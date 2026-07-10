-- Atomic, resumable pricing backfills. All mutable control state remains behind
-- service-role-only SECURITY DEFINER functions; catalog and event snapshots stay
-- immutable and are hashed without wall-clock fields.

ALTER TABLE public.tokend_pricing_backfill_runs
  ADD COLUMN IF NOT EXISTS target_hash TEXT;
ALTER TABLE public.tokend_pricing_backfill_runs
  ADD COLUMN IF NOT EXISTS base_catalog_version TEXT;
ALTER TABLE public.tokend_pricing_backfill_runs
  ADD COLUMN IF NOT EXISTS base_backfill_run_id UUID;
ALTER TABLE public.tokend_pricing_backfill_runs
  ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ;
ALTER TABLE public.tokend_pricing_backfill_runs
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
ALTER TABLE public.tokend_pricing_backfill_runs
  ADD COLUMN IF NOT EXISTS rolled_back_at TIMESTAMPTZ;

ALTER TABLE public.tokend_usage_events
  ALTER COLUMN uploaded_at SET DEFAULT clock_timestamp();

CREATE OR REPLACE FUNCTION public.tokend_pricing_create_backfill(
  p_catalog_version TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_run_id UUID := gen_random_uuid();
  v_snapshot_at TIMESTAMPTZ;
  v_state public.tokend_pricing_state%ROWTYPE;
  v_target_hash TEXT;
  v_target_count BIGINT := 0;
  v_input_tokens BIGINT := 0;
  v_output_tokens BIGINT := 0;
  v_reasoning_tokens BIGINT := 0;
  v_cache_read_tokens BIGINT := 0;
  v_cache_write_tokens BIGINT := 0;
  v_before_total_cost NUMERIC(20,10) := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('tokend:pricing:global', 0));

  IF p_catalog_version IS NULL
    OR btrim(p_catalog_version) = ''
    OR NOT EXISTS (
      SELECT 1
      FROM public.tokend_pricing_catalogs
      WHERE version = p_catalog_version
    ) THEN
    RAISE EXCEPTION 'Unknown pricing catalog: %', p_catalog_version
      USING ERRCODE = '55000';
  END IF;

  SELECT *
  INTO v_state
  FROM public.tokend_pricing_state
  WHERE singleton
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pricing singleton state is missing'
      USING ERRCODE = '55000';
  END IF;

  IF p_catalog_version IS NOT DISTINCT FROM v_state.active_catalog_version THEN
    RAISE EXCEPTION 'Pricing catalog % is already active', p_catalog_version
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.tokend_pricing_backfill_runs
    WHERE status IN ('staging', 'reconciled')
  ) THEN
    RAISE EXCEPTION 'Another pricing backfill is already pending'
      USING ERRCODE = '55000';
  END IF;

  -- This SHARE fence conflicts with v2 upload's early ROW EXCLUSIVE fence.
  -- After it is acquired, every earlier upload is committed and visible; every
  -- later upload waits until the staging run and frozen snapshot both exist.
  LOCK TABLE public.tokend_usage_events IN SHARE MODE;
  v_snapshot_at := clock_timestamp();

  INSERT INTO public.tokend_pricing_backfill_runs (
    run_id,
    catalog_version,
    status,
    snapshot_at,
    target_count,
    input_tokens,
    output_tokens,
    reasoning_tokens,
    cache_read_tokens,
    cache_write_tokens,
    before_total_cost,
    target_hash,
    base_catalog_version,
    base_backfill_run_id,
    started_at
  ) VALUES (
    v_run_id,
    p_catalog_version,
    'staging',
    v_snapshot_at,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    NULL,
    v_state.active_catalog_version,
    v_state.active_backfill_run_id,
    v_snapshot_at
  );

  INSERT INTO public.tokend_pricing_backfill_targets (
    run_id,
    member_code,
    event_id,
    event_snapshot
  )
  SELECT
    v_run_id,
    usage_event.member_code,
    usage_event.id,
    jsonb_build_object(
      'inputTokens', COALESCE(usage_event.input_tokens, 0)::BIGINT,
      'outputTokens', COALESCE(usage_event.output_tokens, 0)::BIGINT,
      'reasoningTokens', COALESCE(usage_event.reasoning_tokens, 0)::BIGINT,
      'cacheReadTokens', COALESCE(usage_event.cache_read_tokens, 0)::BIGINT,
      'cacheWriteTokens', COALESCE(usage_event.cache_write_tokens, 0)::BIGINT,
      'model', usage_event.model,
      'timestampMs', usage_event.timestamp_ms,
      'tokenSemantics', COALESCE(usage_event.token_semantics, 'unknown'),
      'sessionId', usage_event.session_id,
      'sessionKey', usage_event.session_key,
      'agent', usage_event.agent,
      'provider', usage_event.provider,
      'channel', usage_event.channel,
      'stopReason', usage_event.stop_reason,
      'project', usage_event.project,
      'beforeInputCost', COALESCE(effective.effective_input_cost, 0)::NUMERIC,
      'beforeOutputCost', COALESCE(effective.effective_output_cost, 0)::NUMERIC,
      'beforeReasoningCost', COALESCE(effective.effective_reasoning_cost, 0)::NUMERIC,
      'beforeCacheReadCost', COALESCE(effective.effective_cache_read_cost, 0)::NUMERIC,
      'beforeCacheWriteCost', COALESCE(effective.effective_cache_write_cost, 0)::NUMERIC,
      'beforeUnallocatedCost', COALESCE(effective.effective_unallocated_cost, 0)::NUMERIC,
      'beforeTotalCost', COALESCE(effective.effective_total_cost, 0)::NUMERIC,
      'beforePricingStatus', COALESCE(effective.effective_pricing_status, 'unpriced'),
      'beforePricingTier', COALESCE(effective.effective_pricing_tier, 'standard'),
      'beforeBreakdownStatus', COALESCE(effective.effective_breakdown_status, 'reconciled')
    )
  FROM public.tokend_usage_events AS usage_event
  LEFT JOIN public.tokend_effective_usage_events AS effective
    ON effective.member_code = usage_event.member_code
   AND effective.id = usage_event.id
  WHERE usage_event.total_tokens > 0
    AND COALESCE(usage_event.uploaded_at, '-infinity'::TIMESTAMPTZ) < v_snapshot_at
    AND usage_event.pricing_status IS DISTINCT FROM 'reported'
    AND NOT (
      (usage_event.pricing_status IN ('legacy') OR usage_event.pricing_status IS NULL)
      AND (
        COALESCE(usage_event.input_cost, 0) <> 0
        OR COALESCE(usage_event.output_cost, 0) <> 0
        OR COALESCE(usage_event.reasoning_cost, 0) <> 0
        OR COALESCE(usage_event.cache_read_cost, 0) <> 0
        OR COALESCE(usage_event.cache_write_cost, 0) <> 0
        OR COALESCE(usage_event.total_cost, 0) <> 0
        OR COALESCE(usage_event.unallocated_cost, 0) <> 0
      )
    )
  ORDER BY usage_event.member_code, usage_event.id;

  SELECT
    count(*)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'inputTokens')::BIGINT), 0)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'outputTokens')::BIGINT), 0)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'reasoningTokens')::BIGINT), 0)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'cacheReadTokens')::BIGINT), 0)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'cacheWriteTokens')::BIGINT), 0)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'beforeTotalCost')::NUMERIC), 0)::NUMERIC(20,10)
  INTO
    v_target_count,
    v_input_tokens,
    v_output_tokens,
    v_reasoning_tokens,
    v_cache_read_tokens,
    v_cache_write_tokens,
    v_before_total_cost
  FROM public.tokend_pricing_backfill_targets AS target
  WHERE target.run_id = v_run_id;

  v_target_hash := (
    SELECT encode(
      sha256(convert_to(COALESCE(string_agg(
        jsonb_build_array(target.member_code, target.event_id, target.event_snapshot)::TEXT,
        E'\n' ORDER BY target.member_code, target.event_id
      ), ''), 'UTF8')),
      'hex'
    )
    FROM public.tokend_pricing_backfill_targets AS target
    WHERE target.run_id = v_run_id
  );

  UPDATE public.tokend_pricing_backfill_runs
  SET target_count = v_target_count,
      input_tokens = v_input_tokens,
      output_tokens = v_output_tokens,
      reasoning_tokens = v_reasoning_tokens,
      cache_read_tokens = v_cache_read_tokens,
      cache_write_tokens = v_cache_write_tokens,
      before_total_cost = v_before_total_cost,
      target_hash = v_target_hash,
      updated_at = clock_timestamp()
  WHERE run_id = v_run_id;

  RETURN json_build_object(
    'runId', v_run_id,
    'status', 'staging',
    'catalogVersion', p_catalog_version,
    'snapshotAt', v_snapshot_at,
    'targetCount', v_target_count,
    'targetHash', v_target_hash,
    'baseCatalogVersion', v_state.active_catalog_version,
    'baseRunId', v_state.active_backfill_run_id
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.tokend_pricing_preflight()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_event_count BIGINT := 0;
  v_eligible_event_count BIGINT := 0;
  v_eligible_zero_cost_count BIGINT := 0;
  v_zero_cost_by_model JSON := '[]'::JSON;
  v_legacy_price_row_count BIGINT := 0;
  v_status_counts JSON;
  v_unpriced_event_count BIGINT := 0;
  v_unpriced_share NUMERIC := 0;
  v_post_snapshot_event_count BIGINT := 0;
  v_members_over_2x_count BIGINT := 0;
  v_active_catalog_version TEXT;
  v_previous_catalog_version TEXT;
  v_active_run_id UUID;
  v_previous_run_id UUID;
  v_active_run_status TEXT;
  v_active_reconciliation_hash TEXT;
  v_snapshot_at TIMESTAMPTZ;
  v_snapshot_run_id UUID;
  v_rollout_fixture_count BIGINT := 0;
BEGIN
  SELECT
    pricing_state.active_catalog_version,
    pricing_state.previous_catalog_version,
    pricing_state.active_backfill_run_id,
    pricing_state.previous_backfill_run_id,
    active_run.status,
    active_run.reconciliation_hash,
    active_run.snapshot_at,
    active_run.run_id
  INTO
    v_active_catalog_version,
    v_previous_catalog_version,
    v_active_run_id,
    v_previous_run_id,
    v_active_run_status,
    v_active_reconciliation_hash,
    v_snapshot_at,
    v_snapshot_run_id
  FROM public.tokend_pricing_state AS pricing_state
  LEFT JOIN public.tokend_pricing_backfill_runs AS active_run
    ON active_run.run_id = pricing_state.active_backfill_run_id
  WHERE pricing_state.singleton;

  IF v_snapshot_at IS NULL THEN
    SELECT run.snapshot_at, run.run_id
    INTO v_snapshot_at, v_snapshot_run_id
    FROM public.tokend_pricing_backfill_runs AS run
    WHERE run.status IN ('staging', 'reconciled')
      AND run.snapshot_at <= clock_timestamp()
    ORDER BY run.snapshot_at DESC, run.created_at DESC, run.run_id DESC
    LIMIT 1;
  END IF;

  SELECT
    count(*)::BIGINT,
    count(*) FILTER (WHERE usage_event.total_tokens > 0)::BIGINT,
    count(*) FILTER (
      WHERE usage_event.total_tokens > 0
        AND COALESCE(usage_event.effective_total_cost, 0) = 0
    )::BIGINT,
    count(*) FILTER (
      WHERE usage_event.effective_pricing_status = 'unpriced'
        AND usage_event.total_tokens > 0
    )::BIGINT
  INTO
    v_event_count,
    v_eligible_event_count,
    v_eligible_zero_cost_count,
    v_unpriced_event_count
  FROM public.tokend_effective_usage_events AS usage_event;

  SELECT COALESCE(
    json_agg(
      json_build_object(
        'model', model_rollup.model,
        'eventCount', model_rollup.event_count,
        'totalTokens', model_rollup.total_tokens
      ) ORDER BY model_rollup.event_count DESC, model_rollup.model
    ),
    '[]'::JSON
  )
  INTO v_zero_cost_by_model
  FROM (
    SELECT
      COALESCE(usage_event.model, 'unknown') AS model,
      count(*)::BIGINT AS event_count,
      COALESCE(sum(usage_event.total_tokens), 0)::BIGINT AS total_tokens
    FROM public.tokend_effective_usage_events AS usage_event
    WHERE usage_event.total_tokens > 0
      AND COALESCE(usage_event.effective_total_cost, 0) = 0
    GROUP BY COALESCE(usage_event.model, 'unknown')
  ) AS model_rollup;

  SELECT count(*)::BIGINT
  INTO v_legacy_price_row_count
  FROM public.tokend_model_prices;

  SELECT json_build_object(
    'reported', count(*) FILTER (WHERE usage_event.effective_pricing_status = 'reported'),
    'estimated', count(*) FILTER (WHERE usage_event.effective_pricing_status = 'estimated'),
    'zero_rate', count(*) FILTER (WHERE usage_event.effective_pricing_status = 'zero_rate'),
    'unpriced', count(*) FILTER (WHERE usage_event.effective_pricing_status = 'unpriced'),
    'legacy', count(*) FILTER (WHERE usage_event.effective_pricing_status = 'legacy'),
    'unset', count(*) FILTER (WHERE usage_event.effective_pricing_status IS NULL)
  )
  INTO v_status_counts
  FROM public.tokend_effective_usage_events AS usage_event;

  v_unpriced_share := CASE
    WHEN v_eligible_event_count = 0 THEN 0::NUMERIC
    ELSE round(v_unpriced_event_count::NUMERIC / v_eligible_event_count::NUMERIC, 10)
  END;

  IF v_snapshot_at IS NOT NULL THEN
    SELECT count(*)::BIGINT
    INTO v_post_snapshot_event_count
    FROM public.tokend_usage_events AS usage_event
    WHERE usage_event.uploaded_at >= v_snapshot_at
      AND NOT EXISTS (
        SELECT 1
        FROM public.tokend_pricing_backfill_targets AS frozen_target
        WHERE frozen_target.run_id = v_snapshot_run_id
          AND frozen_target.member_code = usage_event.member_code
          AND frozen_target.event_id = usage_event.id
      );
  END IF;

  IF v_active_catalog_version IS NOT NULL
    AND v_previous_catalog_version IS NOT NULL
    AND v_active_catalog_version <> v_previous_catalog_version
    AND EXISTS (
      SELECT 1 FROM public.tokend_event_cost_revisions
      WHERE version = v_active_catalog_version
    )
    AND EXISTS (
      SELECT 1 FROM public.tokend_event_cost_revisions
      WHERE version = v_previous_catalog_version
    ) THEN
    SELECT count(*)::BIGINT
    INTO v_members_over_2x_count
    FROM (
      SELECT revision.member_code
      FROM public.tokend_event_cost_revisions AS revision
      WHERE revision.version IN (v_active_catalog_version, v_previous_catalog_version)
      GROUP BY revision.member_code
      HAVING count(*) FILTER (WHERE revision.version = v_active_catalog_version) > 0
        AND count(*) FILTER (WHERE revision.version = v_previous_catalog_version) > 0
        AND COALESCE(sum(revision.total_cost) FILTER (
          WHERE revision.version = v_active_catalog_version
        ), 0) > 2 * COALESCE(sum(revision.total_cost) FILTER (
          WHERE revision.version = v_previous_catalog_version
        ), 0)
    ) AS member_rollup;
  END IF;

  SELECT count(*)::BIGINT
  INTO v_rollout_fixture_count
  FROM public.tokend_members
  WHERE member_code LIKE 'ROLL%';

  RETURN json_build_object(
    'eventCount', v_event_count,
    'eligibleEventCount', v_eligible_event_count,
    'eligibleZeroCostEventCount', v_eligible_zero_cost_count,
    'zeroCostByModel', v_zero_cost_by_model,
    'legacyPriceRowCount', v_legacy_price_row_count,
    'statusCounts', v_status_counts,
    'unpricedEventCount', v_unpriced_event_count,
    'unpricedShare', v_unpriced_share,
    'postSnapshotEventCount', v_post_snapshot_event_count,
    'membersOver2xCount', v_members_over_2x_count,
    'activeRunStatus', v_active_run_status,
    'activeReconciliationHash', v_active_reconciliation_hash,
    'rolloutFixtureCount', v_rollout_fixture_count,
    'activeCatalogVersion', v_active_catalog_version,
    'activeRunId', v_active_run_id,
    'previousCatalogVersion', v_previous_catalog_version,
    'previousRunId', v_previous_run_id
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.tokend_pricing_activate(
  p_run_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_run public.tokend_pricing_backfill_runs%ROWTYPE;
  v_state public.tokend_pricing_state%ROWTYPE;
  v_target_count BIGINT := 0;
  v_revision_count BIGINT := 0;
  v_remaining_count BIGINT := 0;
  v_breakdown_invalid_count BIGINT := 0;
  v_post_snapshot_event_count BIGINT := 0;
  v_unexplained_member_count BIGINT := 0;
  v_current_hash TEXT;
  v_already_active BOOLEAN := FALSE;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'Backfill run id is required'
      USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('tokend:pricing:global', 0));

  SELECT *
  INTO v_run
  FROM public.tokend_pricing_backfill_runs
  WHERE run_id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Backfill run does not exist: %', p_run_id
      USING ERRCODE = '55000';
  END IF;

  SELECT *
  INTO v_state
  FROM public.tokend_pricing_state
  WHERE singleton
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pricing singleton state is missing'
      USING ERRCODE = '55000';
  END IF;

  v_already_active := v_state.active_catalog_version IS NOT DISTINCT FROM v_run.catalog_version
    AND v_state.active_backfill_run_id IS NOT DISTINCT FROM p_run_id
    AND v_state.previous_catalog_version IS NOT DISTINCT FROM v_run.base_catalog_version
    AND v_state.previous_backfill_run_id IS NOT DISTINCT FROM v_run.base_backfill_run_id
    AND v_run.status = 'active';

  IF NOT v_already_active AND v_run.status NOT IN ('reconciled', 'rolled_back') THEN
    RAISE EXCEPTION 'Backfill run % cannot activate from %', p_run_id, v_run.status
      USING ERRCODE = '55000';
  END IF;
  IF NOT v_already_active AND NOT (
    v_state.active_catalog_version IS NOT DISTINCT FROM v_run.base_catalog_version
    AND v_state.active_backfill_run_id IS NOT DISTINCT FROM v_run.base_backfill_run_id
  ) THEN
    RAISE EXCEPTION 'Backfill run % was reconciled against a stale active pair', p_run_id
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*)::BIGINT,
    count(*) FILTER (WHERE target.processed_at IS NULL)::BIGINT
  INTO v_target_count, v_remaining_count
  FROM public.tokend_pricing_backfill_targets AS target
  WHERE target.run_id = p_run_id;

  SELECT count(*)::BIGINT,
    count(*) FILTER (WHERE revision.breakdown_status = 'invalid')::BIGINT
  INTO v_revision_count, v_breakdown_invalid_count
  FROM public.tokend_event_cost_revisions AS revision
  WHERE revision.version = v_run.catalog_version
    AND revision.backfill_run_id = p_run_id;

  SELECT count(*)::BIGINT
  INTO v_post_snapshot_event_count
  FROM public.tokend_usage_events AS usage_event
  WHERE usage_event.uploaded_at >= v_run.snapshot_at
    AND NOT EXISTS (
      SELECT 1
      FROM public.tokend_pricing_backfill_targets AS frozen_target
      WHERE frozen_target.run_id = p_run_id
        AND frozen_target.member_code = usage_event.member_code
        AND frozen_target.event_id = usage_event.id
    );

  WITH target_by_member AS (
    SELECT
      target.member_code,
      count(*)::BIGINT AS target_count,
      COALESCE(sum((target.event_snapshot->>'inputTokens')::BIGINT), 0)::BIGINT AS target_input_tokens,
      COALESCE(sum((target.event_snapshot->>'outputTokens')::BIGINT), 0)::BIGINT AS target_output_tokens,
      COALESCE(sum((target.event_snapshot->>'reasoningTokens')::BIGINT), 0)::BIGINT AS target_reasoning_tokens,
      COALESCE(sum((target.event_snapshot->>'cacheReadTokens')::BIGINT), 0)::BIGINT AS target_cache_read_tokens,
      COALESCE(sum((target.event_snapshot->>'cacheWriteTokens')::BIGINT), 0)::BIGINT AS target_cache_write_tokens
    FROM public.tokend_pricing_backfill_targets AS target
    WHERE target.run_id = p_run_id
    GROUP BY target.member_code
  ), revision_by_member AS (
    SELECT
      revision.member_code,
      count(*)::BIGINT AS revision_count,
      COALESCE(sum(revision.total_cost), 0)::NUMERIC(20,10) AS revision_total_cost
    FROM public.tokend_event_cost_revisions AS revision
    WHERE revision.version = v_run.catalog_version
      AND revision.backfill_run_id = p_run_id
    GROUP BY revision.member_code
  ), shadow_by_member AS (
    SELECT
      shadow.member_code,
      COALESCE(sum(shadow.call_count), 0)::BIGINT AS shadow_count,
      COALESCE(sum(shadow.input_tokens), 0)::BIGINT AS shadow_input_tokens,
      COALESCE(sum(shadow.output_tokens), 0)::BIGINT AS shadow_output_tokens,
      COALESCE(sum(shadow.reasoning_tokens), 0)::BIGINT AS shadow_reasoning_tokens,
      COALESCE(sum(shadow.cache_read_tokens), 0)::BIGINT AS shadow_cache_read_tokens,
      COALESCE(sum(shadow.cache_write_tokens), 0)::BIGINT AS shadow_cache_write_tokens,
      COALESCE(sum(shadow.total_cost), 0)::NUMERIC(20,10) AS shadow_total_cost
    FROM public.tokend_pricing_shadow_sessions AS shadow
    WHERE shadow.run_id = p_run_id
    GROUP BY shadow.member_code
  ), member_codes AS (
    SELECT member_code FROM target_by_member
    UNION
    SELECT member_code FROM revision_by_member
    UNION
    SELECT member_code FROM shadow_by_member
  ), inconsistent_members AS (
    SELECT member_row.member_code
    FROM member_codes AS member_row
    LEFT JOIN target_by_member AS target_rollup USING (member_code)
    LEFT JOIN revision_by_member AS revision_rollup USING (member_code)
    LEFT JOIN shadow_by_member AS shadow_rollup USING (member_code)
    WHERE COALESCE(target_rollup.target_count, 0) <> COALESCE(revision_rollup.revision_count, 0)
       OR COALESCE(target_rollup.target_count, 0) <> COALESCE(shadow_rollup.shadow_count, 0)
       OR COALESCE(target_rollup.target_input_tokens, 0) <> COALESCE(shadow_rollup.shadow_input_tokens, 0)
       OR COALESCE(target_rollup.target_output_tokens, 0) <> COALESCE(shadow_rollup.shadow_output_tokens, 0)
       OR COALESCE(target_rollup.target_reasoning_tokens, 0) <> COALESCE(shadow_rollup.shadow_reasoning_tokens, 0)
       OR COALESCE(target_rollup.target_cache_read_tokens, 0) <> COALESCE(shadow_rollup.shadow_cache_read_tokens, 0)
       OR COALESCE(target_rollup.target_cache_write_tokens, 0) <> COALESCE(shadow_rollup.shadow_cache_write_tokens, 0)
       OR COALESCE(revision_rollup.revision_total_cost, 0) <> COALESCE(shadow_rollup.shadow_total_cost, 0)
    UNION
    SELECT target.member_code
    FROM public.tokend_pricing_backfill_targets AS target
    LEFT JOIN public.tokend_sessions AS session_row
      ON session_row.member_code = target.member_code
     AND session_row.session_id = target.event_snapshot->>'sessionId'
    WHERE target.run_id = p_run_id
      AND session_row.session_id IS NULL
  )
  SELECT count(*)::BIGINT
  INTO v_unexplained_member_count
  FROM inconsistent_members;

  v_current_hash := (
    SELECT encode(
      sha256(convert_to(COALESCE(string_agg(
        static_row.row_value,
        E'\n' ORDER BY static_row.row_kind, static_row.member_code,
          static_row.primary_key, static_row.secondary_key
      ), ''), 'UTF8')),
      'hex'
    )
    FROM (
      SELECT
        'T'::TEXT AS row_kind,
        target.member_code,
        target.event_id AS primary_key,
        ''::TEXT AS secondary_key,
        jsonb_build_array(
          'T', target.member_code, target.event_id, target.event_snapshot
        )::TEXT AS row_value
      FROM public.tokend_pricing_backfill_targets AS target
      WHERE target.run_id = p_run_id
      UNION ALL
      SELECT
        'R', revision.member_code, revision.event_id, revision.version,
        jsonb_build_array(
          'R',
          revision.version, revision.member_code, revision.event_id,
          revision.backfill_run_id,
          revision.input_cost, revision.output_cost,
          revision.reasoning_cost, revision.cache_read_cost,
          revision.cache_write_cost, revision.unallocated_cost,
          revision.total_cost, revision.pricing_status, revision.pricing_tier,
          revision.matched_model_id, revision.price_version, revision.breakdown_status
        )::TEXT
      FROM public.tokend_event_cost_revisions AS revision
      WHERE revision.version = v_run.catalog_version
        AND revision.backfill_run_id = p_run_id
      UNION ALL
      SELECT
        'S', shadow.member_code, shadow.session_id, '',
        jsonb_build_array(
          'S',
          shadow.member_code, shadow.session_id,
          shadow.input_tokens, shadow.output_tokens,
          shadow.reasoning_tokens, shadow.cache_read_tokens,
          shadow.cache_write_tokens, shadow.input_cost,
          shadow.output_cost, shadow.reasoning_cost,
          shadow.cache_read_cost, shadow.cache_write_cost,
          shadow.total_cost, shadow.call_count,
          shadow.reported_count, shadow.estimated_count,
          shadow.zero_rate_count, shadow.legacy_count,
          shadow.unpriced_count
        )::TEXT
      FROM public.tokend_pricing_shadow_sessions AS shadow
      WHERE shadow.run_id = p_run_id
    ) AS static_row
  );

  IF v_target_count IS DISTINCT FROM v_run.target_count
    OR v_revision_count IS DISTINCT FROM v_target_count
    OR v_remaining_count <> 0
    OR v_breakdown_invalid_count <> 0
    OR v_unexplained_member_count <> 0
    OR v_run.reconciliation_hash IS NULL
    OR v_current_hash IS DISTINCT FROM v_run.reconciliation_hash THEN
    RAISE EXCEPTION 'Backfill run % no longer satisfies reconciliation gates', p_run_id
      USING ERRCODE = '55000';
  END IF;

  IF v_already_active THEN
    RETURN json_build_object(
      'runId', p_run_id,
      'status', 'active',
      'catalogVersion', v_run.catalog_version,
      'previousCatalogVersion', v_state.previous_catalog_version,
      'previousRunId', v_state.previous_backfill_run_id,
      'activeCatalogVersion', v_state.active_catalog_version,
      'activeRunId', v_state.active_backfill_run_id,
      'targetCount', v_target_count,
      'revisionCount', v_revision_count,
      'postSnapshotEventCount', v_post_snapshot_event_count,
      'reconciliationHash', v_run.reconciliation_hash
    );
  END IF;

  UPDATE public.tokend_pricing_state
  SET previous_catalog_version = v_state.active_catalog_version,
      previous_backfill_run_id = v_state.active_backfill_run_id,
      active_catalog_version = v_run.catalog_version,
      active_backfill_run_id = p_run_id,
      updated_at = clock_timestamp()
  WHERE singleton;

  UPDATE public.tokend_pricing_backfill_runs
  SET status = 'active',
      activated_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE run_id = p_run_id;

  INSERT INTO public.tokend_pricing_audit (
    audit_id, run_id, action, actor,
    old_catalog_version, new_catalog_version,
    old_backfill_run_id, new_backfill_run_id, payload
  ) VALUES (
    gen_random_uuid(), p_run_id, 'activate', session_user,
    v_state.active_catalog_version, v_run.catalog_version,
    v_state.active_backfill_run_id, p_run_id,
    jsonb_build_object('reconciliationHash', v_run.reconciliation_hash)
  );

  RETURN json_build_object(
    'runId', p_run_id,
    'status', 'active',
    'catalogVersion', v_run.catalog_version,
    'previousCatalogVersion', v_run.base_catalog_version,
    'previousRunId', v_run.base_backfill_run_id,
    'activeCatalogVersion', v_run.catalog_version,
    'activeRunId', p_run_id,
    'targetCount', v_target_count,
    'revisionCount', v_revision_count,
    'postSnapshotEventCount', v_post_snapshot_event_count,
    'reconciliationHash', v_run.reconciliation_hash
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.tokend_pricing_rollback(
  p_run_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_run public.tokend_pricing_backfill_runs%ROWTYPE;
  v_state public.tokend_pricing_state%ROWTYPE;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'Backfill run id is required'
      USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('tokend:pricing:global', 0));

  SELECT *
  INTO v_run
  FROM public.tokend_pricing_backfill_runs
  WHERE run_id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Backfill run does not exist: %', p_run_id
      USING ERRCODE = '55000';
  END IF;

  SELECT *
  INTO v_state
  FROM public.tokend_pricing_state
  WHERE singleton
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pricing singleton state is missing'
      USING ERRCODE = '55000';
  END IF;

  IF v_run.status = 'rolled_back'
    AND v_state.active_catalog_version IS NOT DISTINCT FROM v_run.base_catalog_version
    AND v_state.active_backfill_run_id IS NOT DISTINCT FROM v_run.base_backfill_run_id
    AND v_state.previous_catalog_version IS NOT DISTINCT FROM v_run.catalog_version
    AND v_state.previous_backfill_run_id IS NOT DISTINCT FROM p_run_id THEN
    RETURN json_build_object(
      'runId', p_run_id,
      'status', 'rolled_back',
      'activeCatalogVersion', v_state.active_catalog_version,
      'activeRunId', v_state.active_backfill_run_id
    );
  END IF;

  IF v_run.status <> 'active'
    OR NOT (
      v_state.active_catalog_version IS NOT DISTINCT FROM v_run.catalog_version
      AND v_state.active_backfill_run_id IS NOT DISTINCT FROM p_run_id
      AND v_state.previous_catalog_version IS NOT DISTINCT FROM v_run.base_catalog_version
      AND v_state.previous_backfill_run_id IS NOT DISTINCT FROM v_run.base_backfill_run_id
    ) THEN
    RAISE EXCEPTION 'Backfill run % is not the current reversible pair', p_run_id
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.tokend_pricing_state
  SET active_catalog_version = v_run.base_catalog_version,
      active_backfill_run_id = v_run.base_backfill_run_id,
      previous_catalog_version = v_run.catalog_version,
      previous_backfill_run_id = p_run_id,
      updated_at = clock_timestamp()
  WHERE singleton;

  UPDATE public.tokend_pricing_backfill_runs
  SET status = 'rolled_back',
      rolled_back_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE run_id = p_run_id;

  INSERT INTO public.tokend_pricing_audit (
    audit_id, run_id, action, actor,
    old_catalog_version, new_catalog_version,
    old_backfill_run_id, new_backfill_run_id, payload
  ) VALUES (
    gen_random_uuid(), p_run_id, 'rollback', session_user,
    v_state.active_catalog_version, v_run.base_catalog_version,
    v_state.active_backfill_run_id, v_run.base_backfill_run_id,
    jsonb_build_object('reconciliationHash', v_run.reconciliation_hash)
  );

  RETURN json_build_object(
    'runId', p_run_id,
    'status', 'rolled_back',
    'activeCatalogVersion', v_run.base_catalog_version,
    'activeRunId', v_run.base_backfill_run_id
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.tokend_pricing_reconcile(
  p_run_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_run public.tokend_pricing_backfill_runs%ROWTYPE;
  v_target_count BIGINT := 0;
  v_revision_count BIGINT := 0;
  v_missing_revision_count BIGINT := 0;
  v_duplicate_revision_count BIGINT := 0;
  v_input_tokens BIGINT := 0;
  v_output_tokens BIGINT := 0;
  v_reasoning_tokens BIGINT := 0;
  v_cache_read_tokens BIGINT := 0;
  v_cache_write_tokens BIGINT := 0;
  v_reported_count BIGINT := 0;
  v_estimated_count BIGINT := 0;
  v_zero_rate_count BIGINT := 0;
  v_legacy_count BIGINT := 0;
  v_unpriced_count BIGINT := 0;
  v_before_total_cost NUMERIC(20,10) := 0;
  v_after_total_cost NUMERIC(20,10) := 0;
  v_breakdown_invalid_count BIGINT := 0;
  v_post_snapshot_event_count BIGINT := 0;
  v_unexplained_member_count BIGINT := 0;
  v_reconciliation_hash TEXT;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'Backfill run id is required'
      USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('tokend:pricing:run:' || p_run_id::TEXT, 0));

  SELECT *
  INTO v_run
  FROM public.tokend_pricing_backfill_runs
  WHERE run_id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Backfill run does not exist: %', p_run_id
      USING ERRCODE = '55000';
  END IF;
  IF v_run.status NOT IN ('staging', 'reconciled') THEN
    RAISE EXCEPTION 'Backfill run % cannot be reconciled from %', p_run_id, v_run.status
      USING ERRCODE = '55000';
  END IF;

  DELETE FROM public.tokend_pricing_shadow_sessions
  WHERE run_id = p_run_id;

  INSERT INTO public.tokend_pricing_shadow_sessions (
    run_id,
    member_code,
    session_id,
    input_tokens,
    output_tokens,
    reasoning_tokens,
    cache_read_tokens,
    cache_write_tokens,
    input_cost,
    output_cost,
    reasoning_cost,
    cache_read_cost,
    cache_write_cost,
    total_cost,
    call_count,
    reported_count,
    estimated_count,
    zero_rate_count,
    unpriced_count,
    legacy_count
  )
  SELECT
    p_run_id,
    target.member_code,
    target.event_snapshot->>'sessionId',
    COALESCE(sum((target.event_snapshot->>'inputTokens')::BIGINT), 0)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'outputTokens')::BIGINT), 0)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'reasoningTokens')::BIGINT), 0)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'cacheReadTokens')::BIGINT), 0)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'cacheWriteTokens')::BIGINT), 0)::BIGINT,
    COALESCE(sum(revision.input_cost), 0)::NUMERIC(20,10),
    COALESCE(sum(revision.output_cost), 0)::NUMERIC(20,10),
    COALESCE(sum(revision.reasoning_cost), 0)::NUMERIC(20,10),
    COALESCE(sum(revision.cache_read_cost), 0)::NUMERIC(20,10),
    COALESCE(sum(revision.cache_write_cost), 0)::NUMERIC(20,10),
    COALESCE(sum(revision.total_cost), 0)::NUMERIC(20,10),
    count(*)::BIGINT,
    count(*) FILTER (WHERE revision.pricing_status = 'reported')::BIGINT,
    count(*) FILTER (WHERE revision.pricing_status = 'estimated')::BIGINT,
    count(*) FILTER (WHERE revision.pricing_status = 'zero_rate')::BIGINT,
    count(*) FILTER (WHERE revision.pricing_status = 'unpriced')::BIGINT,
    count(*) FILTER (WHERE revision.pricing_status = 'legacy')::BIGINT
  FROM public.tokend_pricing_backfill_targets AS target
  JOIN public.tokend_event_cost_revisions AS revision
    ON revision.version = v_run.catalog_version
   AND revision.member_code = target.member_code
   AND revision.event_id = target.event_id
   AND revision.backfill_run_id = p_run_id
  JOIN public.tokend_sessions AS session_row
    ON session_row.member_code = target.member_code
   AND session_row.session_id = target.event_snapshot->>'sessionId'
  WHERE target.run_id = p_run_id
  GROUP BY target.member_code, target.event_snapshot->>'sessionId';

  SELECT
    count(*)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'inputTokens')::BIGINT), 0)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'outputTokens')::BIGINT), 0)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'reasoningTokens')::BIGINT), 0)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'cacheReadTokens')::BIGINT), 0)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'cacheWriteTokens')::BIGINT), 0)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'beforeTotalCost')::NUMERIC), 0)::NUMERIC(20,10)
  INTO
    v_target_count,
    v_input_tokens,
    v_output_tokens,
    v_reasoning_tokens,
    v_cache_read_tokens,
    v_cache_write_tokens,
    v_before_total_cost
  FROM public.tokend_pricing_backfill_targets AS target
  WHERE target.run_id = p_run_id;

  SELECT
    count(*)::BIGINT,
    count(*) FILTER (WHERE revision.pricing_status = 'reported')::BIGINT,
    count(*) FILTER (WHERE revision.pricing_status = 'estimated')::BIGINT,
    count(*) FILTER (WHERE revision.pricing_status = 'zero_rate')::BIGINT,
    count(*) FILTER (WHERE revision.pricing_status = 'legacy')::BIGINT,
    count(*) FILTER (WHERE revision.pricing_status = 'unpriced')::BIGINT,
    count(*) FILTER (WHERE revision.breakdown_status = 'invalid')::BIGINT,
    COALESCE(sum(revision.total_cost), 0)::NUMERIC(20,10)
  INTO
    v_revision_count,
    v_reported_count,
    v_estimated_count,
    v_zero_rate_count,
    v_legacy_count,
    v_unpriced_count,
    v_breakdown_invalid_count,
    v_after_total_cost
  FROM public.tokend_event_cost_revisions AS revision
  WHERE revision.version = v_run.catalog_version
    AND revision.backfill_run_id = p_run_id;

  SELECT count(*)::BIGINT
  INTO v_missing_revision_count
  FROM public.tokend_pricing_backfill_targets AS target
  LEFT JOIN public.tokend_event_cost_revisions AS revision
    ON revision.version = v_run.catalog_version
   AND revision.member_code = target.member_code
   AND revision.event_id = target.event_id
   AND revision.backfill_run_id = p_run_id
  WHERE target.run_id = p_run_id
    AND revision.event_id IS NULL;

  SELECT COALESCE(sum(revision_group.revision_count - 1), 0)::BIGINT
  INTO v_duplicate_revision_count
  FROM (
    SELECT target.member_code, target.event_id, count(revision.event_id)::BIGINT AS revision_count
    FROM public.tokend_pricing_backfill_targets AS target
    JOIN public.tokend_event_cost_revisions AS revision
      ON revision.version = v_run.catalog_version
     AND revision.member_code = target.member_code
     AND revision.event_id = target.event_id
     AND revision.backfill_run_id = p_run_id
    WHERE target.run_id = p_run_id
    GROUP BY target.member_code, target.event_id
    HAVING count(revision.event_id) > 1
  ) AS revision_group;

  SELECT count(*)::BIGINT
  INTO v_post_snapshot_event_count
  FROM public.tokend_usage_events AS usage_event
  WHERE usage_event.uploaded_at >= v_run.snapshot_at
    AND NOT EXISTS (
      SELECT 1
      FROM public.tokend_pricing_backfill_targets AS frozen_target
      WHERE frozen_target.run_id = p_run_id
        AND frozen_target.member_code = usage_event.member_code
        AND frozen_target.event_id = usage_event.id
    );

  WITH target_by_member AS (
    SELECT
      target.member_code,
      count(*)::BIGINT AS target_count,
      COALESCE(sum((target.event_snapshot->>'inputTokens')::BIGINT), 0)::BIGINT AS target_input_tokens,
      COALESCE(sum((target.event_snapshot->>'outputTokens')::BIGINT), 0)::BIGINT AS target_output_tokens,
      COALESCE(sum((target.event_snapshot->>'reasoningTokens')::BIGINT), 0)::BIGINT AS target_reasoning_tokens,
      COALESCE(sum((target.event_snapshot->>'cacheReadTokens')::BIGINT), 0)::BIGINT AS target_cache_read_tokens,
      COALESCE(sum((target.event_snapshot->>'cacheWriteTokens')::BIGINT), 0)::BIGINT AS target_cache_write_tokens
    FROM public.tokend_pricing_backfill_targets AS target
    WHERE target.run_id = p_run_id
    GROUP BY target.member_code
  ), revision_by_member AS (
    SELECT
      revision.member_code,
      count(*)::BIGINT AS revision_count,
      COALESCE(sum(revision.total_cost), 0)::NUMERIC(20,10) AS revision_total_cost
    FROM public.tokend_event_cost_revisions AS revision
    WHERE revision.version = v_run.catalog_version
      AND revision.backfill_run_id = p_run_id
    GROUP BY revision.member_code
  ), shadow_by_member AS (
    SELECT
      shadow.member_code,
      COALESCE(sum(shadow.call_count), 0)::BIGINT AS shadow_count,
      COALESCE(sum(shadow.input_tokens), 0)::BIGINT AS shadow_input_tokens,
      COALESCE(sum(shadow.output_tokens), 0)::BIGINT AS shadow_output_tokens,
      COALESCE(sum(shadow.reasoning_tokens), 0)::BIGINT AS shadow_reasoning_tokens,
      COALESCE(sum(shadow.cache_read_tokens), 0)::BIGINT AS shadow_cache_read_tokens,
      COALESCE(sum(shadow.cache_write_tokens), 0)::BIGINT AS shadow_cache_write_tokens,
      COALESCE(sum(shadow.total_cost), 0)::NUMERIC(20,10) AS shadow_total_cost
    FROM public.tokend_pricing_shadow_sessions AS shadow
    WHERE shadow.run_id = p_run_id
    GROUP BY shadow.member_code
  ), member_codes AS (
    SELECT member_code FROM target_by_member
    UNION
    SELECT member_code FROM revision_by_member
    UNION
    SELECT member_code FROM shadow_by_member
  ), inconsistent_members AS (
    SELECT member_row.member_code
    FROM member_codes AS member_row
    LEFT JOIN target_by_member AS target_rollup USING (member_code)
    LEFT JOIN revision_by_member AS revision_rollup USING (member_code)
    LEFT JOIN shadow_by_member AS shadow_rollup USING (member_code)
    WHERE COALESCE(target_rollup.target_count, 0) <> COALESCE(revision_rollup.revision_count, 0)
       OR COALESCE(target_rollup.target_count, 0) <> COALESCE(shadow_rollup.shadow_count, 0)
       OR COALESCE(target_rollup.target_input_tokens, 0) <> COALESCE(shadow_rollup.shadow_input_tokens, 0)
       OR COALESCE(target_rollup.target_output_tokens, 0) <> COALESCE(shadow_rollup.shadow_output_tokens, 0)
       OR COALESCE(target_rollup.target_reasoning_tokens, 0) <> COALESCE(shadow_rollup.shadow_reasoning_tokens, 0)
       OR COALESCE(target_rollup.target_cache_read_tokens, 0) <> COALESCE(shadow_rollup.shadow_cache_read_tokens, 0)
       OR COALESCE(target_rollup.target_cache_write_tokens, 0) <> COALESCE(shadow_rollup.shadow_cache_write_tokens, 0)
       OR COALESCE(revision_rollup.revision_total_cost, 0) <> COALESCE(shadow_rollup.shadow_total_cost, 0)
    UNION
    SELECT target.member_code
    FROM public.tokend_pricing_backfill_targets AS target
    LEFT JOIN public.tokend_sessions AS session_row
      ON session_row.member_code = target.member_code
     AND session_row.session_id = target.event_snapshot->>'sessionId'
    WHERE target.run_id = p_run_id
      AND session_row.session_id IS NULL
  )
  SELECT count(*)::BIGINT
  INTO v_unexplained_member_count
  FROM inconsistent_members;

  v_reconciliation_hash := (
    SELECT encode(
      sha256(convert_to(COALESCE(string_agg(
        static_row.row_value,
        E'\n' ORDER BY static_row.row_kind, static_row.member_code,
          static_row.primary_key, static_row.secondary_key
      ), ''), 'UTF8')),
      'hex'
    )
    FROM (
      SELECT
        'T'::TEXT AS row_kind,
        target.member_code,
        target.event_id AS primary_key,
        ''::TEXT AS secondary_key,
        jsonb_build_array(
          'T', target.member_code, target.event_id, target.event_snapshot
        )::TEXT AS row_value
      FROM public.tokend_pricing_backfill_targets AS target
      WHERE target.run_id = p_run_id
      UNION ALL
      SELECT
        'R',
        revision.member_code,
        revision.event_id,
        revision.version,
        jsonb_build_array(
          'R',
          revision.version, revision.member_code, revision.event_id,
          revision.backfill_run_id,
          revision.input_cost, revision.output_cost,
          revision.reasoning_cost, revision.cache_read_cost,
          revision.cache_write_cost, revision.unallocated_cost,
          revision.total_cost, revision.pricing_status, revision.pricing_tier,
          revision.matched_model_id, revision.price_version, revision.breakdown_status
        )::TEXT
      FROM public.tokend_event_cost_revisions AS revision
      WHERE revision.version = v_run.catalog_version
        AND revision.backfill_run_id = p_run_id
      UNION ALL
      SELECT
        'S',
        shadow.member_code,
        shadow.session_id,
        '',
        jsonb_build_array(
          'S',
          shadow.member_code, shadow.session_id,
          shadow.input_tokens, shadow.output_tokens,
          shadow.reasoning_tokens, shadow.cache_read_tokens,
          shadow.cache_write_tokens, shadow.input_cost,
          shadow.output_cost, shadow.reasoning_cost,
          shadow.cache_read_cost, shadow.cache_write_cost,
          shadow.total_cost, shadow.call_count,
          shadow.reported_count, shadow.estimated_count,
          shadow.zero_rate_count, shadow.legacy_count,
          shadow.unpriced_count
        )::TEXT
      FROM public.tokend_pricing_shadow_sessions AS shadow
      WHERE shadow.run_id = p_run_id
    ) AS static_row
  );

  IF v_missing_revision_count = 0
    AND v_duplicate_revision_count = 0
    AND v_breakdown_invalid_count = 0
    AND v_target_count IS NOT DISTINCT FROM v_run.target_count
    AND v_unexplained_member_count = 0 THEN
    UPDATE public.tokend_pricing_backfill_runs
    SET status = 'reconciled',
        reconciliation_hash = v_reconciliation_hash,
        reconciled_at = COALESCE(reconciled_at, clock_timestamp()),
        completed_at = COALESCE(completed_at, clock_timestamp()),
        updated_at = clock_timestamp()
    WHERE run_id = p_run_id;
  ELSE
    UPDATE public.tokend_pricing_backfill_runs
    SET status = 'staging',
        reconciliation_hash = NULL,
        reconciled_at = NULL,
        completed_at = NULL,
        updated_at = clock_timestamp()
    WHERE run_id = p_run_id;
  END IF;

  RETURN json_build_object(
    'targetCount', v_target_count,
    'revisionCount', v_revision_count,
    'missingRevisionCount', v_missing_revision_count,
    'duplicateRevisionCount', v_duplicate_revision_count,
    'inputTokens', v_input_tokens,
    'outputTokens', v_output_tokens,
    'reasoningTokens', v_reasoning_tokens,
    'cacheReadTokens', v_cache_read_tokens,
    'cacheWriteTokens', v_cache_write_tokens,
    'reportedCount', v_reported_count,
    'estimatedCount', v_estimated_count,
    'zeroRateCount', v_zero_rate_count,
    'legacyCount', v_legacy_count,
    'unpricedCount', v_unpriced_count,
    'beforeTotalCost', v_before_total_cost,
    'afterTotalCost', v_after_total_cost,
    'totalCostDelta', v_after_total_cost - v_before_total_cost,
    'breakdownInvalidCount', v_breakdown_invalid_count,
    'postSnapshotEventCount', v_post_snapshot_event_count,
    'unexplainedMemberCount', v_unexplained_member_count,
    'reconciliationHash', v_reconciliation_hash
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.tokend_pricing_backfill_batch(
  p_run_id UUID,
  p_after_member TEXT DEFAULT '',
  p_after_event TEXT DEFAULT '',
  p_limit INTEGER DEFAULT 10000
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_run public.tokend_pricing_backfill_runs%ROWTYPE;
  v_target RECORD;
  v_price JSONB;
  v_processed INTEGER := 0;
  v_revision_count BIGINT := 0;
  v_remaining_count BIGINT := 0;
  v_persisted_member TEXT := '';
  v_persisted_event TEXT := '';
  v_next_member TEXT := '';
  v_next_event TEXT := '';
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'Backfill batch limit must be between 1 and 10000'
      USING ERRCODE = '22023';
  END IF;
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'Backfill run id is required'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('tokend:pricing:run:' || p_run_id::TEXT, 0));

  SELECT *
  INTO v_run
  FROM public.tokend_pricing_backfill_runs
  WHERE run_id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Backfill run does not exist: %', p_run_id
      USING ERRCODE = '55000';
  END IF;
  IF v_run.status <> 'staging' THEN
    RAISE EXCEPTION 'Backfill run % is not staging', p_run_id
      USING ERRCODE = '55000';
  END IF;

  v_persisted_member := COALESCE(v_run.cursor_member_code, '');
  v_persisted_event := COALESCE(v_run.cursor_event_id, '');
  v_next_member := v_persisted_member;
  v_next_event := v_persisted_event;
  p_after_member := COALESCE(p_after_member, '');
  p_after_event := COALESCE(p_after_event, '');

  IF ROW(p_after_member, p_after_event)
    > ROW(v_persisted_member, v_persisted_event) THEN
    RAISE EXCEPTION 'Caller cursor is ahead of persisted progress'
      USING ERRCODE = '55000';
  END IF;

  FOR v_target IN
    SELECT target.*
    FROM public.tokend_pricing_backfill_targets AS target
    WHERE target.run_id = p_run_id
      AND target.processed_at IS NULL
      AND ROW(target.member_code, target.event_id)
        > ROW(v_persisted_member, v_persisted_event)
    ORDER BY target.member_code, target.event_id
    LIMIT p_limit
    FOR UPDATE OF target
  LOOP
    v_price := public.tokend_price_event(v_target.event_snapshot, v_run.catalog_version);

    INSERT INTO public.tokend_event_cost_revisions (
      version,
      member_code,
      event_id,
      backfill_run_id,
      input_cost,
      output_cost,
      reasoning_cost,
      cache_read_cost,
      cache_write_cost,
      unallocated_cost,
      total_cost,
      pricing_status,
      pricing_tier,
      matched_model_id,
      price_version,
      breakdown_status
    ) VALUES (
      v_run.catalog_version,
      v_target.member_code,
      v_target.event_id,
      p_run_id,
      COALESCE((v_price->>'inputCost')::NUMERIC, 0),
      COALESCE((v_price->>'outputCost')::NUMERIC, 0),
      COALESCE((v_price->>'reasoningCost')::NUMERIC, 0),
      COALESCE((v_price->>'cacheReadCost')::NUMERIC, 0),
      COALESCE((v_price->>'cacheWriteCost')::NUMERIC, 0),
      COALESCE((v_price->>'unallocatedCost')::NUMERIC, 0),
      COALESCE((v_price->>'totalCost')::NUMERIC, 0),
      COALESCE(v_price->>'pricingStatus', 'unpriced'),
      COALESCE(v_price->>'pricingTier', 'standard'),
      NULLIF(v_price->>'matchedModelId', ''),
      NULLIF(v_price->>'priceVersion', ''),
      COALESCE(v_price->>'breakdownStatus', 'reconciled')
    )
    ON CONFLICT (version, member_code, event_id) DO UPDATE SET
      backfill_run_id = EXCLUDED.backfill_run_id,
      input_cost = EXCLUDED.input_cost,
      output_cost = EXCLUDED.output_cost,
      reasoning_cost = EXCLUDED.reasoning_cost,
      cache_read_cost = EXCLUDED.cache_read_cost,
      cache_write_cost = EXCLUDED.cache_write_cost,
      unallocated_cost = EXCLUDED.unallocated_cost,
      total_cost = EXCLUDED.total_cost,
      pricing_status = EXCLUDED.pricing_status,
      pricing_tier = EXCLUDED.pricing_tier,
      matched_model_id = EXCLUDED.matched_model_id,
      price_version = EXCLUDED.price_version,
      breakdown_status = EXCLUDED.breakdown_status,
      computed_at = clock_timestamp();

    UPDATE public.tokend_pricing_backfill_targets
    SET processed_at = clock_timestamp()
    WHERE run_id = p_run_id
      AND member_code = v_target.member_code
      AND event_id = v_target.event_id;

    v_processed := v_processed + 1;
    v_next_member := v_target.member_code;
    v_next_event := v_target.event_id;
  END LOOP;

  UPDATE public.tokend_pricing_backfill_runs
  SET cursor_member_code = CASE WHEN v_processed > 0 THEN v_next_member ELSE cursor_member_code END,
      cursor_event_id = CASE WHEN v_processed > 0 THEN v_next_event ELSE cursor_event_id END,
      started_at = COALESCE(started_at, clock_timestamp()),
      updated_at = clock_timestamp()
  WHERE run_id = p_run_id;

  SELECT count(*)::BIGINT
  INTO v_revision_count
  FROM public.tokend_event_cost_revisions AS revision
  WHERE revision.version = v_run.catalog_version
    AND revision.backfill_run_id = p_run_id;

  SELECT count(*)::BIGINT
  INTO v_remaining_count
  FROM public.tokend_pricing_backfill_targets
  WHERE run_id = p_run_id
    AND processed_at IS NULL;

  RETURN json_build_object(
    'ok', TRUE,
    'processed', v_processed,
    'revisionCount', v_revision_count,
    'remainingCount', v_remaining_count,
    'nextMember', NULLIF(v_next_member, ''),
    'nextEvent', NULLIF(v_next_event, '')
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.tokend_pricing_get_backfill(
  p_run_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_run public.tokend_pricing_backfill_runs%ROWTYPE;
  v_revision_count BIGINT := 0;
  v_remaining_count BIGINT := 0;
  v_post_snapshot_event_count BIGINT := 0;
  v_active_catalog_version TEXT;
  v_active_run_id UUID;
BEGIN
  SELECT * INTO v_run
  FROM public.tokend_pricing_backfill_runs
  WHERE run_id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Backfill run does not exist: %', p_run_id
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*)::BIGINT
  INTO v_revision_count
  FROM public.tokend_event_cost_revisions AS revision
  WHERE revision.version = v_run.catalog_version
    AND revision.backfill_run_id = p_run_id;

  SELECT count(*)::BIGINT
  INTO v_remaining_count
  FROM public.tokend_pricing_backfill_targets
  WHERE run_id = p_run_id AND processed_at IS NULL;

  SELECT count(*)::BIGINT
  INTO v_post_snapshot_event_count
  FROM public.tokend_usage_events AS usage_event
  WHERE usage_event.uploaded_at >= v_run.snapshot_at
    AND NOT EXISTS (
      SELECT 1
      FROM public.tokend_pricing_backfill_targets AS frozen_target
      WHERE frozen_target.run_id = p_run_id
        AND frozen_target.member_code = usage_event.member_code
        AND frozen_target.event_id = usage_event.id
    );

  SELECT active_catalog_version, active_backfill_run_id
  INTO v_active_catalog_version, v_active_run_id
  FROM public.tokend_pricing_state
  WHERE singleton;

  RETURN json_build_object(
    'runId', v_run.run_id,
    'status', v_run.status,
    'catalogVersion', v_run.catalog_version,
    'snapshotAt', v_run.snapshot_at,
    'targetCount', v_run.target_count,
    'revisionCount', v_revision_count,
    'remainingCount', v_remaining_count,
    'postSnapshotEventCount', v_post_snapshot_event_count,
    'cursorMember', v_run.cursor_member_code,
    'cursorEvent', v_run.cursor_event_id,
    'activeCatalogVersion', v_active_catalog_version,
    'activeRunId', v_active_run_id
  );
END
$function$;

REVOKE ALL ON FUNCTION public.tokend_pricing_create_backfill(TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_pricing_backfill_batch(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_pricing_reconcile(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_pricing_activate(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_pricing_rollback(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_pricing_get_backfill(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_pricing_preflight() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.tokend_pricing_create_backfill(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.tokend_pricing_backfill_batch(UUID, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.tokend_pricing_reconcile(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.tokend_pricing_activate(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.tokend_pricing_rollback(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.tokend_pricing_get_backfill(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.tokend_pricing_preflight() TO service_role;

NOTIFY pgrst, 'reload schema';
