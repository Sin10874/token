-- Atomic, resumable pricing backfills. All mutable control state remains behind
-- service-role-only SECURITY DEFINER functions; catalog and event snapshots stay
-- immutable and are hashed without wall-clock fields.

ALTER TABLE public.tokend_pricing_backfill_runs
  ADD COLUMN IF NOT EXISTS create_request_id UUID;
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

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tokend_pricing_backfill_runs_create_request_id_key'
      AND conrelid = 'public.tokend_pricing_backfill_runs'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_backfill_runs
      ADD CONSTRAINT tokend_pricing_backfill_runs_create_request_id_key
      UNIQUE (create_request_id);
  END IF;
END
$constraint$;

CREATE OR REPLACE FUNCTION public.tokend_pricing_create_backfill(
  p_catalog_version TEXT,
  p_create_request_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '2s'
AS $function$
DECLARE
  v_run_id UUID := gen_random_uuid();
  v_snapshot_at TIMESTAMPTZ;
  v_state public.tokend_pricing_state%ROWTYPE;
  v_target_ingest_epoch BIGINT;
  v_upper_event_id TEXT;
  v_upper_member_code TEXT;
  v_existing_run public.tokend_pricing_backfill_runs%ROWTYPE;
BEGIN
  IF p_create_request_id IS NULL THEN
    RAISE EXCEPTION 'Pricing backfill create request id is required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('tokend:pricing:global', 0));

  SELECT *
  INTO v_existing_run
  FROM public.tokend_pricing_backfill_runs
  WHERE create_request_id = p_create_request_id;
  IF FOUND THEN
    IF v_existing_run.catalog_version IS DISTINCT FROM p_catalog_version THEN
      RAISE EXCEPTION 'Pricing backfill create request % belongs to catalog %, not %',
        p_create_request_id, v_existing_run.catalog_version, p_catalog_version
        USING ERRCODE = '55000';
    END IF;

    RETURN json_build_object(
      'runId', v_existing_run.run_id,
      'status', 'freezing',
      'catalogVersion', v_existing_run.catalog_version,
      'snapshotAt', v_existing_run.snapshot_at,
      'targetIngestEpoch', v_existing_run.target_ingest_epoch,
      'targetCount', 0,
      'targetHash', NULL,
      'freezeComplete', v_existing_run.freeze_upper_event_id IS NULL,
      'baseCatalogVersion', v_existing_run.base_catalog_version,
      'baseRunId', v_existing_run.base_backfill_run_id,
      'previousCatalogVersion', v_existing_run.base_previous_catalog_version,
      'previousRunId', v_existing_run.base_previous_backfill_run_id
    );
  END IF;

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
    WHERE status IN ('freezing', 'staging', 'reconciled')
  ) THEN
    RAISE EXCEPTION 'Another pricing backfill is already pending'
      USING ERRCODE = '55000';
  END IF;

  -- The fence only cuts an ingest epoch and captures the existing PK upper key.
  -- Full target materialization happens later in bounded transactions.
  LOCK TABLE public.tokend_usage_events IN SHARE MODE;
  v_snapshot_at := clock_timestamp();
  v_target_ingest_epoch := v_state.current_ingest_epoch;

  SELECT usage_event.id, usage_event.member_code
  INTO v_upper_event_id, v_upper_member_code
  FROM public.tokend_usage_events AS usage_event
  ORDER BY usage_event.id DESC, usage_event.member_code DESC
  LIMIT 1;

  UPDATE public.tokend_pricing_state
  SET current_ingest_epoch = current_ingest_epoch + 1,
      updated_at = clock_timestamp()
  WHERE singleton;

  INSERT INTO public.tokend_pricing_ingest_epochs (epoch, event_count)
  VALUES (v_target_ingest_epoch + 1, 0)
  ON CONFLICT (epoch) DO NOTHING;

  INSERT INTO public.tokend_pricing_backfill_runs (
    run_id,
    catalog_version,
    create_request_id,
    status,
    snapshot_at,
    target_ingest_epoch,
    freeze_upper_event_id,
    freeze_upper_member_code,
    freeze_complete,
    base_catalog_version,
    base_backfill_run_id,
    base_previous_catalog_version,
    base_previous_backfill_run_id,
    started_at
  ) VALUES (
    v_run_id,
    p_catalog_version,
    p_create_request_id,
    'freezing',
    v_snapshot_at,
    v_target_ingest_epoch,
    v_upper_event_id,
    v_upper_member_code,
    v_upper_event_id IS NULL,
    v_state.active_catalog_version,
    v_state.active_backfill_run_id,
    v_state.previous_catalog_version,
    v_state.previous_backfill_run_id,
    v_snapshot_at
  );

  RETURN json_build_object(
    'runId', v_run_id,
    'status', 'freezing',
    'catalogVersion', p_catalog_version,
    'snapshotAt', v_snapshot_at,
    'targetIngestEpoch', v_target_ingest_epoch,
    'targetCount', 0,
    'targetHash', NULL,
    'freezeComplete', v_upper_event_id IS NULL,
    'baseCatalogVersion', v_state.active_catalog_version,
    'baseRunId', v_state.active_backfill_run_id,
    'previousCatalogVersion', v_state.previous_catalog_version,
    'previousRunId', v_state.previous_backfill_run_id
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.tokend_pricing_compute_target_hash(
  p_run_id UUID
)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  WITH ordered_rows AS (
    SELECT
      row_number() OVER (
        ORDER BY target.member_code COLLATE "C", target.event_id COLLATE "C"
      ) AS row_number,
      target.snapshot_hash
    FROM public.tokend_pricing_backfill_targets AS target
    WHERE target.run_id = p_run_id
  ), bounded_buckets AS (
    SELECT
      ((row_number - 1) / 2048)::BIGINT AS bucket_number,
      count(*)::BIGINT AS row_count,
      encode(sha256(convert_to(COALESCE(string_agg(
        snapshot_hash, E'\n' ORDER BY row_number
      ), ''), 'UTF8')), 'hex') AS bucket_hash
    FROM ordered_rows
    GROUP BY ((row_number - 1) / 2048)::BIGINT
  )
  SELECT encode(sha256(convert_to(COALESCE(string_agg(
    jsonb_build_array(bucket_number, row_count, bucket_hash)::TEXT,
    E'\n' ORDER BY bucket_number
  ), ''), 'UTF8')), 'hex')
  FROM bounded_buckets
$function$;

CREATE OR REPLACE FUNCTION public.tokend_pricing_compute_reconciliation_hash(
  p_run_id UUID,
  p_catalog_version TEXT
)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  WITH static_rows AS (
    SELECT
      'T'::TEXT AS row_kind,
      target.member_code,
      target.event_id AS primary_key,
      ''::TEXT AS secondary_key,
      encode(sha256(convert_to(jsonb_build_array(
        'T', target.member_code, target.event_id, target.snapshot_hash
      )::TEXT, 'UTF8')), 'hex') AS row_hash
    FROM public.tokend_pricing_backfill_targets AS target
    WHERE target.run_id = p_run_id
    UNION ALL
    SELECT
      'R', revision.member_code, revision.event_id, revision.version,
      encode(sha256(convert_to(jsonb_build_array(
        'R', revision.version, revision.member_code, revision.event_id,
        revision.backfill_run_id, revision.input_cost, revision.output_cost,
        revision.reasoning_cost, revision.cache_read_cost,
        revision.cache_write_cost, revision.unallocated_cost,
        revision.total_cost, revision.pricing_status, revision.pricing_tier,
        revision.matched_model_id, revision.price_version, revision.breakdown_status
      )::TEXT, 'UTF8')), 'hex')
    FROM public.tokend_event_cost_revisions AS revision
    WHERE revision.version = p_catalog_version
      AND revision.backfill_run_id = p_run_id
    UNION ALL
    SELECT
      'S', shadow.member_code, shadow.session_id, '',
      encode(sha256(convert_to(jsonb_build_array(
        'S', shadow.member_code, shadow.session_id,
        shadow.input_tokens, shadow.output_tokens, shadow.reasoning_tokens,
        shadow.cache_read_tokens, shadow.cache_write_tokens,
        shadow.input_cost, shadow.output_cost, shadow.reasoning_cost,
        shadow.cache_read_cost, shadow.cache_write_cost, shadow.total_cost,
        shadow.call_count, shadow.reported_count, shadow.estimated_count,
        shadow.zero_rate_count, shadow.legacy_count, shadow.unpriced_count
      )::TEXT, 'UTF8')), 'hex')
    FROM public.tokend_pricing_shadow_sessions AS shadow
    WHERE shadow.run_id = p_run_id
  ), ordered_rows AS (
    SELECT
      row_number() OVER (
        ORDER BY row_kind COLLATE "C", member_code COLLATE "C",
          primary_key COLLATE "C", secondary_key COLLATE "C"
      ) AS row_number,
      row_hash
    FROM static_rows
  ), bounded_buckets AS (
    SELECT
      ((row_number - 1) / 2048)::BIGINT AS bucket_number,
      count(*)::BIGINT AS row_count,
      encode(sha256(convert_to(COALESCE(string_agg(
        row_hash, E'\n' ORDER BY row_number
      ), ''), 'UTF8')), 'hex') AS bucket_hash
    FROM ordered_rows
    GROUP BY ((row_number - 1) / 2048)::BIGINT
  )
  SELECT encode(sha256(convert_to(COALESCE(string_agg(
    jsonb_build_array(bucket_number, row_count, bucket_hash)::TEXT,
    E'\n' ORDER BY bucket_number
  ), ''), 'UTF8')), 'hex')
  FROM bounded_buckets
$function$;

CREATE OR REPLACE FUNCTION public.tokend_pricing_freeze_batch(
  p_run_id UUID,
  p_limit INTEGER DEFAULT 5000
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_run public.tokend_pricing_backfill_runs%ROWTYPE;
  v_raw_count BIGINT := 0;
  v_inserted_count BIGINT := 0;
  v_input_tokens BIGINT := 0;
  v_output_tokens BIGINT := 0;
  v_reasoning_tokens BIGINT := 0;
  v_cache_read_tokens BIGINT := 0;
  v_cache_write_tokens BIGINT := 0;
  v_before_total_cost NUMERIC(20,10) := 0;
  v_next_event TEXT;
  v_next_member TEXT;
  v_complete BOOLEAN := FALSE;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'Freeze batch limit must be between 1 and 5000'
      USING ERRCODE = '22023';
  END IF;
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'Backfill run id is required'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('tokend:pricing:run:' || p_run_id::TEXT, 0));
  SELECT * INTO v_run
  FROM public.tokend_pricing_backfill_runs
  WHERE run_id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Backfill run does not exist: %', p_run_id
      USING ERRCODE = '55000';
  END IF;
  IF v_run.status <> 'freezing' THEN
    RAISE EXCEPTION 'Backfill run % is not freezing', p_run_id
      USING ERRCODE = '55000';
  END IF;

  IF v_run.freeze_complete THEN
    RETURN json_build_object(
      'status', 'freezing', 'scanned', 0, 'frozen', 0,
      'scannedCount', v_run.freeze_scanned_count,
      'frozenCount', v_run.frozen_count,
      'skippedCount', v_run.freeze_scanned_count - v_run.frozen_count,
      'freezeComplete', TRUE
    );
  END IF;

  WITH raw_page AS MATERIALIZED (
    SELECT
      usage_event.id,
      usage_event.member_code,
      usage_event.timestamp_ms,
      usage_event.session_id,
      usage_event.model,
      usage_event.input_tokens,
      usage_event.output_tokens,
      usage_event.reasoning_tokens,
      usage_event.cache_read_tokens,
      usage_event.cache_write_tokens,
      usage_event.total_tokens,
      usage_event.token_semantics,
      usage_event.pricing_status,
      usage_event.input_cost,
      usage_event.output_cost,
      usage_event.reasoning_cost,
      usage_event.cache_read_cost,
      usage_event.cache_write_cost,
      usage_event.total_cost,
      usage_event.unallocated_cost,
      usage_event.pricing_ingest_epoch
    FROM public.tokend_usage_events AS usage_event
    WHERE ROW(usage_event.id, usage_event.member_code) > ROW(
        COALESCE(v_run.freeze_cursor_event_id, ''),
        COALESCE(v_run.freeze_cursor_member_code, '')
      )
      AND ROW(usage_event.id, usage_event.member_code) <= ROW(
        v_run.freeze_upper_event_id, v_run.freeze_upper_member_code
      )
    ORDER BY usage_event.id, usage_event.member_code
    LIMIT p_limit
  ), snapshots AS MATERIALIZED (
    SELECT
      raw_page.member_code,
      raw_page.id AS event_id,
      jsonb_build_object(
        'inputTokens', COALESCE(raw_page.input_tokens, 0)::BIGINT,
        'outputTokens', COALESCE(raw_page.output_tokens, 0)::BIGINT,
        'reasoningTokens', COALESCE(raw_page.reasoning_tokens, 0)::BIGINT,
        'cacheReadTokens', COALESCE(raw_page.cache_read_tokens, 0)::BIGINT,
        'cacheWriteTokens', COALESCE(raw_page.cache_write_tokens, 0)::BIGINT,
        'model', raw_page.model,
        'timestampMs', raw_page.timestamp_ms,
        'tokenSemantics', COALESCE(raw_page.token_semantics, 'unknown'),
        'sessionId', raw_page.session_id,
        'beforeTotalCost', COALESCE(base_revision.total_cost, 0)::NUMERIC
      ) AS event_snapshot
    FROM raw_page
    LEFT JOIN public.tokend_event_cost_revisions AS base_revision
      ON base_revision.version = v_run.base_catalog_version
     AND base_revision.member_code = raw_page.member_code
     AND base_revision.event_id = raw_page.id
    WHERE raw_page.pricing_ingest_epoch <= v_run.target_ingest_epoch
      AND raw_page.total_tokens > 0
      AND raw_page.pricing_status IS DISTINCT FROM 'reported'
      AND NOT (
        (raw_page.pricing_status IN ('legacy') OR raw_page.pricing_status IS NULL)
        AND (
          COALESCE(raw_page.input_cost, 0) <> 0
          OR COALESCE(raw_page.output_cost, 0) <> 0
          OR COALESCE(raw_page.reasoning_cost, 0) <> 0
          OR COALESCE(raw_page.cache_read_cost, 0) <> 0
          OR COALESCE(raw_page.cache_write_cost, 0) <> 0
          OR COALESCE(raw_page.total_cost, 0) <> 0
          OR COALESCE(raw_page.unallocated_cost, 0) <> 0
        )
      )
  ), inserted AS (
    INSERT INTO public.tokend_pricing_backfill_targets (
      run_id, member_code, event_id, event_snapshot, snapshot_hash
    )
    SELECT
      p_run_id, snapshot.member_code, snapshot.event_id, snapshot.event_snapshot,
      encode(sha256(convert_to(jsonb_build_array(
        snapshot.member_code, snapshot.event_id, snapshot.event_snapshot
      )::TEXT, 'UTF8')), 'hex')
    FROM snapshots AS snapshot
    ON CONFLICT (run_id, member_code, event_id) DO NOTHING
    RETURNING event_snapshot
  ), raw_stats AS (
    SELECT
      count(*)::BIGINT AS raw_count,
      (array_agg(id ORDER BY id DESC, member_code DESC))[1] AS next_event,
      (array_agg(member_code ORDER BY id DESC, member_code DESC))[1] AS next_member
    FROM raw_page
  ), inserted_stats AS (
    SELECT
      count(*)::BIGINT AS inserted_count,
      COALESCE(sum((event_snapshot->>'inputTokens')::BIGINT), 0)::BIGINT AS input_tokens,
      COALESCE(sum((event_snapshot->>'outputTokens')::BIGINT), 0)::BIGINT AS output_tokens,
      COALESCE(sum((event_snapshot->>'reasoningTokens')::BIGINT), 0)::BIGINT AS reasoning_tokens,
      COALESCE(sum((event_snapshot->>'cacheReadTokens')::BIGINT), 0)::BIGINT AS cache_read_tokens,
      COALESCE(sum((event_snapshot->>'cacheWriteTokens')::BIGINT), 0)::BIGINT AS cache_write_tokens,
      COALESCE(sum((event_snapshot->>'beforeTotalCost')::NUMERIC), 0)::NUMERIC(20,10) AS before_total_cost
    FROM inserted
  )
  SELECT
    raw_stats.raw_count, inserted_stats.inserted_count,
    inserted_stats.input_tokens, inserted_stats.output_tokens,
    inserted_stats.reasoning_tokens, inserted_stats.cache_read_tokens,
    inserted_stats.cache_write_tokens, inserted_stats.before_total_cost,
    raw_stats.next_event, raw_stats.next_member
  INTO
    v_raw_count, v_inserted_count,
    v_input_tokens, v_output_tokens, v_reasoning_tokens,
    v_cache_read_tokens, v_cache_write_tokens, v_before_total_cost,
    v_next_event, v_next_member
  FROM raw_stats CROSS JOIN inserted_stats;

  v_complete := v_raw_count < p_limit;
  UPDATE public.tokend_pricing_backfill_runs
  SET freeze_cursor_event_id = CASE WHEN v_raw_count > 0 THEN v_next_event ELSE freeze_cursor_event_id END,
      freeze_cursor_member_code = CASE WHEN v_raw_count > 0 THEN v_next_member ELSE freeze_cursor_member_code END,
      freeze_scanned_count = freeze_scanned_count + v_raw_count,
      frozen_count = frozen_count + v_inserted_count,
      freeze_complete = v_complete,
      input_tokens = input_tokens + v_input_tokens,
      output_tokens = output_tokens + v_output_tokens,
      reasoning_tokens = reasoning_tokens + v_reasoning_tokens,
      cache_read_tokens = cache_read_tokens + v_cache_read_tokens,
      cache_write_tokens = cache_write_tokens + v_cache_write_tokens,
      before_total_cost = before_total_cost + v_before_total_cost,
      updated_at = clock_timestamp()
  WHERE run_id = p_run_id;

  RETURN json_build_object(
    'status', 'freezing',
    'scanned', v_raw_count,
    'frozen', v_inserted_count,
    'scannedCount', v_run.freeze_scanned_count + v_raw_count,
    'frozenCount', v_run.frozen_count + v_inserted_count,
    'skippedCount', (v_run.freeze_scanned_count + v_raw_count)
      - (v_run.frozen_count + v_inserted_count),
    'freezeComplete', v_complete
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.tokend_pricing_finalize_backfill(
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
  v_input_tokens BIGINT := 0;
  v_output_tokens BIGINT := 0;
  v_reasoning_tokens BIGINT := 0;
  v_cache_read_tokens BIGINT := 0;
  v_cache_write_tokens BIGINT := 0;
  v_before_total_cost NUMERIC(20,10) := 0;
  v_target_hash TEXT;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'Backfill run id is required'
      USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('tokend:pricing:run:' || p_run_id::TEXT, 0));
  SELECT * INTO v_run
  FROM public.tokend_pricing_backfill_runs
  WHERE run_id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Backfill run does not exist: %', p_run_id
      USING ERRCODE = '55000';
  END IF;

  IF v_run.status IN ('staging', 'reconciled', 'active', 'rolled_back')
    AND v_run.target_hash IS NOT NULL THEN
    RETURN json_build_object(
      'runId', p_run_id, 'status', v_run.status,
      'catalogVersion', v_run.catalog_version,
      'snapshotAt', v_run.snapshot_at,
      'targetIngestEpoch', v_run.target_ingest_epoch,
      'targetCount', v_run.target_count, 'targetHash', v_run.target_hash,
      'baseCatalogVersion', v_run.base_catalog_version,
      'baseRunId', v_run.base_backfill_run_id,
      'previousCatalogVersion', v_run.base_previous_catalog_version,
      'previousRunId', v_run.base_previous_backfill_run_id,
      'inputTokens', v_run.input_tokens,
      'outputTokens', v_run.output_tokens,
      'reasoningTokens', v_run.reasoning_tokens,
      'cacheReadTokens', v_run.cache_read_tokens,
      'cacheWriteTokens', v_run.cache_write_tokens,
      'beforeTotalCost', v_run.before_total_cost,
      'freezeComplete', v_run.freeze_complete
    );
  END IF;
  IF v_run.status <> 'freezing' OR NOT v_run.freeze_complete THEN
    RAISE EXCEPTION 'Backfill run % is not ready to finalize', p_run_id
      USING ERRCODE = '55000';
  END IF;

  SELECT
    count(*)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'inputTokens')::BIGINT), 0)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'outputTokens')::BIGINT), 0)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'reasoningTokens')::BIGINT), 0)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'cacheReadTokens')::BIGINT), 0)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'cacheWriteTokens')::BIGINT), 0)::BIGINT,
    COALESCE(sum((target.event_snapshot->>'beforeTotalCost')::NUMERIC), 0)::NUMERIC(20,10)
  INTO
    v_target_count, v_input_tokens, v_output_tokens, v_reasoning_tokens,
    v_cache_read_tokens, v_cache_write_tokens, v_before_total_cost
  FROM public.tokend_pricing_backfill_targets AS target
  WHERE target.run_id = p_run_id;

  IF v_target_count IS DISTINCT FROM v_run.frozen_count
    OR v_input_tokens IS DISTINCT FROM v_run.input_tokens
    OR v_output_tokens IS DISTINCT FROM v_run.output_tokens
    OR v_reasoning_tokens IS DISTINCT FROM v_run.reasoning_tokens
    OR v_cache_read_tokens IS DISTINCT FROM v_run.cache_read_tokens
    OR v_cache_write_tokens IS DISTINCT FROM v_run.cache_write_tokens
    OR v_before_total_cost IS DISTINCT FROM v_run.before_total_cost THEN
    RAISE EXCEPTION 'Frozen target counters changed before finalization'
      USING ERRCODE = '55000';
  END IF;

  v_target_hash := public.tokend_pricing_compute_target_hash(p_run_id);
  UPDATE public.tokend_pricing_backfill_runs
  SET status = 'staging',
      target_count = v_target_count,
      target_hash = v_target_hash,
      frozen_at = COALESCE(frozen_at, clock_timestamp()),
      updated_at = clock_timestamp()
  WHERE run_id = p_run_id;

  RETURN json_build_object(
    'runId', p_run_id, 'status', 'staging',
    'catalogVersion', v_run.catalog_version,
    'snapshotAt', v_run.snapshot_at,
    'targetIngestEpoch', v_run.target_ingest_epoch,
    'targetCount', v_target_count, 'targetHash', v_target_hash,
    'baseCatalogVersion', v_run.base_catalog_version,
    'baseRunId', v_run.base_backfill_run_id,
    'previousCatalogVersion', v_run.base_previous_catalog_version,
    'previousRunId', v_run.base_previous_backfill_run_id,
    'inputTokens', v_input_tokens, 'outputTokens', v_output_tokens,
    'reasoningTokens', v_reasoning_tokens,
    'cacheReadTokens', v_cache_read_tokens,
    'cacheWriteTokens', v_cache_write_tokens,
    'beforeTotalCost', v_before_total_cost,
    'freezeComplete', TRUE
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
  v_zero_cost_model_count BIGINT := 0;
  v_zero_cost_other_event_count BIGINT := 0;
  v_legacy_price_row_count BIGINT := 0;
  v_status_counts JSON;
  v_unpriced_event_count BIGINT := 0;
  v_unpriced_share NUMERIC := 0;
  v_total_cost NUMERIC(20,10) := 0;
  v_post_snapshot_event_count BIGINT := 0;
  v_members_over_2x_count BIGINT := 0;
  v_active_catalog_version TEXT;
  v_catalog_hash TEXT;
  v_previous_catalog_version TEXT;
  v_active_run_id UUID;
  v_previous_run_id UUID;
  v_active_run_status TEXT;
  v_active_reconciliation_hash TEXT;
  v_snapshot_at TIMESTAMPTZ;
  v_snapshot_run_id UUID;
  v_target_ingest_epoch BIGINT;
  v_rollout_fixture_count BIGINT := 0;
BEGIN
  SELECT
    pricing_state.active_catalog_version,
    active_catalog.hash,
    pricing_state.previous_catalog_version,
    pricing_state.active_backfill_run_id,
    pricing_state.previous_backfill_run_id,
    active_run.status,
    active_run.reconciliation_hash,
    active_run.snapshot_at,
    active_run.run_id,
    active_run.target_ingest_epoch
  INTO
    v_active_catalog_version,
    v_catalog_hash,
    v_previous_catalog_version,
    v_active_run_id,
    v_previous_run_id,
    v_active_run_status,
    v_active_reconciliation_hash,
    v_snapshot_at,
    v_snapshot_run_id,
    v_target_ingest_epoch
  FROM public.tokend_pricing_state AS pricing_state
  LEFT JOIN public.tokend_pricing_backfill_runs AS active_run
    ON active_run.run_id = pricing_state.active_backfill_run_id
  LEFT JOIN public.tokend_pricing_catalogs AS active_catalog
    ON active_catalog.version = pricing_state.active_catalog_version
  WHERE pricing_state.singleton;

  IF v_target_ingest_epoch IS NULL THEN
    SELECT run.snapshot_at, run.run_id, run.target_ingest_epoch
    INTO v_snapshot_at, v_snapshot_run_id, v_target_ingest_epoch
    FROM public.tokend_pricing_backfill_runs AS run
    WHERE run.status IN ('freezing', 'staging', 'reconciled')
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
    )::BIGINT,
    COALESCE(sum(usage_event.effective_total_cost), 0)::NUMERIC(20,10),
    json_build_object(
      'reported', count(*) FILTER (
        WHERE usage_event.total_tokens > 0
          AND usage_event.effective_pricing_status = 'reported'
      ),
      'estimated', count(*) FILTER (
        WHERE usage_event.total_tokens > 0
          AND usage_event.effective_pricing_status = 'estimated'
      ),
      'zero_rate', count(*) FILTER (
        WHERE usage_event.total_tokens > 0
          AND usage_event.effective_pricing_status = 'zero_rate'
      ),
      'unpriced', count(*) FILTER (
        WHERE usage_event.total_tokens > 0
          AND usage_event.effective_pricing_status = 'unpriced'
      ),
      'legacy', count(*) FILTER (
        WHERE usage_event.total_tokens > 0
          AND usage_event.effective_pricing_status = 'legacy'
      ),
      'unset', count(*) FILTER (
        WHERE usage_event.total_tokens > 0
          AND usage_event.effective_pricing_status IS NULL
      )
    )
  INTO
    v_event_count,
    v_eligible_event_count,
    v_eligible_zero_cost_count,
    v_unpriced_event_count,
    v_total_cost,
    v_status_counts
  FROM public.tokend_effective_usage_events AS usage_event;

  WITH model_rollup AS MATERIALIZED (
    SELECT
      COALESCE(usage_event.model, 'unknown') AS model,
      count(*)::BIGINT AS event_count,
      COALESCE(sum(usage_event.total_tokens), 0)::BIGINT AS total_tokens
    FROM public.tokend_effective_usage_events AS usage_event
    WHERE usage_event.total_tokens > 0
      AND COALESCE(usage_event.effective_total_cost, 0) = 0
    GROUP BY COALESCE(usage_event.model, 'unknown')
  ), bounded_models AS MATERIALIZED (
    SELECT model_rollup.model, model_rollup.event_count, model_rollup.total_tokens
    FROM model_rollup
    ORDER BY model_rollup.event_count DESC, model_rollup.model
    LIMIT 100
  )
  SELECT
    COALESCE(
      json_agg(
        json_build_object(
          'model', bounded_models.model,
          'eventCount', bounded_models.event_count,
          'totalTokens', bounded_models.total_tokens
        ) ORDER BY bounded_models.event_count DESC, bounded_models.model
      ),
      '[]'::JSON
    ),
    (SELECT count(*)::BIGINT FROM model_rollup),
    GREATEST(
      v_eligible_zero_cost_count - COALESCE(sum(bounded_models.event_count), 0),
      0
    )::BIGINT
  INTO
    v_zero_cost_by_model,
    v_zero_cost_model_count,
    v_zero_cost_other_event_count
  FROM bounded_models;

  SELECT count(*)::BIGINT
  INTO v_legacy_price_row_count
  FROM public.tokend_model_prices;

  v_unpriced_share := CASE
    WHEN v_eligible_event_count = 0 THEN 0::NUMERIC
    ELSE round(v_unpriced_event_count::NUMERIC / v_eligible_event_count::NUMERIC, 10)
  END;

  IF v_target_ingest_epoch IS NOT NULL THEN
    SELECT COALESCE(sum(epoch_row.event_count), 0)::BIGINT
    INTO v_post_snapshot_event_count
    FROM public.tokend_pricing_ingest_epochs AS epoch_row
    WHERE epoch_row.epoch > v_target_ingest_epoch;
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
    'authoritative', TRUE,
    'source', CASE
      WHEN v_active_run_status = 'active' AND v_active_reconciliation_hash IS NOT NULL
        THEN 'frozen_reconciled_run'
      ELSE 'admin_aggregate'
    END,
    'eventCount', v_event_count,
    'eligibleEventCount', v_eligible_event_count,
    'eligibleZeroCostEventCount', v_eligible_zero_cost_count,
    'zeroCostByModel', v_zero_cost_by_model,
    'zeroCostByModelTruncated', v_zero_cost_model_count > 100,
    'zeroCostOtherEventCount', v_zero_cost_other_event_count,
    'legacyPriceRowCount', v_legacy_price_row_count,
    'statusCounts', v_status_counts,
    'unpricedEventCount', v_unpriced_event_count,
    'unpricedShare', v_unpriced_share,
    'totalCost', v_total_cost,
    'postSnapshotEventCount', v_post_snapshot_event_count,
    'membersOver2xCount', v_members_over_2x_count,
    'activeRunStatus', v_active_run_status,
    'activeReconciliationHash', v_active_reconciliation_hash,
    'rolloutFixtureCount', v_rollout_fixture_count,
    'activeCatalogVersion', v_active_catalog_version,
    'catalogHash', v_catalog_hash,
    'activeRunId', v_active_run_id,
    'previousCatalogVersion', v_previous_catalog_version,
    'previousRunId', v_previous_run_id
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.tokend_pricing_health()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_active_catalog_version TEXT;
  v_previous_catalog_version TEXT;
  v_active_run_id UUID;
  v_previous_run_id UUID;
  v_active_run_status TEXT;
  v_active_reconciliation_hash TEXT;
  v_target_ingest_epoch BIGINT;
  v_post_snapshot_event_count BIGINT := 0;
  v_members_over_2x_count BIGINT := 0;
BEGIN
  SELECT
    pricing_state.active_catalog_version,
    pricing_state.previous_catalog_version,
    pricing_state.active_backfill_run_id,
    pricing_state.previous_backfill_run_id,
    active_run.status,
    active_run.reconciliation_hash,
    active_run.target_ingest_epoch,
    active_run.members_over_2x_count
  INTO
    v_active_catalog_version,
    v_previous_catalog_version,
    v_active_run_id,
    v_previous_run_id,
    v_active_run_status,
    v_active_reconciliation_hash,
    v_target_ingest_epoch,
    v_members_over_2x_count
  FROM public.tokend_pricing_state AS pricing_state
  LEFT JOIN public.tokend_pricing_backfill_runs AS active_run
    ON active_run.run_id = pricing_state.active_backfill_run_id
  WHERE pricing_state.singleton;

  IF v_target_ingest_epoch IS NOT NULL THEN
    SELECT COALESCE(sum(epoch_row.event_count), 0)::BIGINT
    INTO v_post_snapshot_event_count
    FROM public.tokend_pricing_ingest_epochs AS epoch_row
    WHERE epoch_row.epoch > v_target_ingest_epoch;
  END IF;

  RETURN json_build_object(
    'activeCatalogVersion', v_active_catalog_version,
    'activeRunId', v_active_run_id,
    'previousCatalogVersion', v_previous_catalog_version,
    'previousRunId', v_previous_run_id,
    'activeRunStatus', v_active_run_status,
    'activeReconciliationHash', v_active_reconciliation_hash,
    'postSnapshotEventCount', v_post_snapshot_event_count,
    'membersOver2xCount', v_members_over_2x_count
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
  v_members_over_2x_count BIGINT := 0;
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

  SELECT COALESCE(sum(epoch_row.event_count), 0)::BIGINT
  INTO v_post_snapshot_event_count
  FROM public.tokend_pricing_ingest_epochs AS epoch_row
  WHERE epoch_row.epoch > v_run.target_ingest_epoch;

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

  v_current_hash := public.tokend_pricing_compute_reconciliation_hash(
    p_run_id, v_run.catalog_version
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

  IF v_run.base_catalog_version IS NOT NULL
    AND v_run.catalog_version <> v_run.base_catalog_version THEN
    SELECT count(*)::BIGINT
    INTO v_members_over_2x_count
    FROM (
      SELECT revision.member_code
      FROM public.tokend_event_cost_revisions AS revision
      WHERE revision.version IN (v_run.catalog_version, v_run.base_catalog_version)
      GROUP BY revision.member_code
      HAVING count(*) FILTER (WHERE revision.version = v_run.catalog_version) > 0
        AND count(*) FILTER (WHERE revision.version = v_run.base_catalog_version) > 0
        AND COALESCE(sum(revision.total_cost) FILTER (
          WHERE revision.version = v_run.catalog_version
        ), 0) > 2 * COALESCE(sum(revision.total_cost) FILTER (
          WHERE revision.version = v_run.base_catalog_version
        ), 0)
    ) AS member_rollup;
  END IF;

  UPDATE public.tokend_pricing_backfill_runs
  SET status = 'active',
      activated_at = clock_timestamp(),
      members_over_2x_count = v_members_over_2x_count,
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

  SELECT COALESCE(sum(epoch_row.event_count), 0)::BIGINT
  INTO v_post_snapshot_event_count
  FROM public.tokend_pricing_ingest_epochs AS epoch_row
  WHERE epoch_row.epoch > v_run.target_ingest_epoch;

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

  v_reconciliation_hash := public.tokend_pricing_compute_reconciliation_hash(
    p_run_id, v_run.catalog_version
  );

  IF v_missing_revision_count = 0
    AND v_duplicate_revision_count = 0
    AND v_breakdown_invalid_count = 0
    AND v_target_count IS NOT DISTINCT FROM v_run.target_count
    AND v_unexplained_member_count = 0 THEN
    UPDATE public.tokend_pricing_backfill_runs
    SET status = 'reconciled',
        reconciliation_hash = v_reconciliation_hash,
        post_snapshot_event_count = v_post_snapshot_event_count,
        reconciled_at = COALESCE(reconciled_at, clock_timestamp()),
        completed_at = COALESCE(completed_at, clock_timestamp()),
        updated_at = clock_timestamp()
    WHERE run_id = p_run_id;
  ELSE
    UPDATE public.tokend_pricing_backfill_runs
    SET status = 'staging',
        reconciliation_hash = NULL,
        post_snapshot_event_count = v_post_snapshot_event_count,
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

  WITH batch_targets AS MATERIALIZED (
    SELECT target.*
    FROM public.tokend_pricing_backfill_targets AS target
    WHERE target.run_id = p_run_id
      AND target.processed_at IS NULL
      AND ROW(target.member_code, target.event_id)
        > ROW(v_persisted_member, v_persisted_event)
    ORDER BY target.member_code, target.event_id
    LIMIT p_limit
    FOR UPDATE OF target
  ), priced_targets AS MATERIALIZED (
    SELECT
      target.member_code,
      target.event_id,
      public.tokend_price_event(target.event_snapshot, v_run.catalog_version) AS price
    FROM batch_targets AS target
  ), upserted AS (
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
    )
    SELECT
      v_run.catalog_version,
      priced.member_code,
      priced.event_id,
      p_run_id,
      COALESCE((priced.price->>'inputCost')::NUMERIC, 0),
      COALESCE((priced.price->>'outputCost')::NUMERIC, 0),
      COALESCE((priced.price->>'reasoningCost')::NUMERIC, 0),
      COALESCE((priced.price->>'cacheReadCost')::NUMERIC, 0),
      COALESCE((priced.price->>'cacheWriteCost')::NUMERIC, 0),
      COALESCE((priced.price->>'unallocatedCost')::NUMERIC, 0),
      COALESCE((priced.price->>'totalCost')::NUMERIC, 0),
      COALESCE(priced.price->>'pricingStatus', 'unpriced'),
      COALESCE(priced.price->>'pricingTier', 'standard'),
      NULLIF(priced.price->>'matchedModelId', ''),
      NULLIF(priced.price->>'priceVersion', ''),
      COALESCE(priced.price->>'breakdownStatus', 'reconciled')
    FROM priced_targets AS priced
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
      computed_at = clock_timestamp()
    RETURNING member_code, event_id
  ), marked AS (
    UPDATE public.tokend_pricing_backfill_targets
    SET processed_at = clock_timestamp()
    FROM upserted
    WHERE tokend_pricing_backfill_targets.run_id = p_run_id
      AND tokend_pricing_backfill_targets.member_code = upserted.member_code
      AND tokend_pricing_backfill_targets.event_id = upserted.event_id
    RETURNING
      tokend_pricing_backfill_targets.member_code,
      tokend_pricing_backfill_targets.event_id
  )
  SELECT
    count(*)::INTEGER,
    (array_agg(member_code ORDER BY member_code DESC, event_id DESC))[1],
    (array_agg(event_id ORDER BY member_code DESC, event_id DESC))[1]
  INTO v_processed, v_next_member, v_next_event
  FROM marked;

  v_next_member := COALESCE(v_next_member, v_persisted_member);
  v_next_event := COALESCE(v_next_event, v_persisted_event);

  UPDATE public.tokend_pricing_backfill_runs
  SET cursor_member_code = CASE WHEN v_processed > 0 THEN v_next_member ELSE cursor_member_code END,
      cursor_event_id = CASE WHEN v_processed > 0 THEN v_next_event ELSE cursor_event_id END,
      priced_count = priced_count + v_processed,
      started_at = COALESCE(started_at, clock_timestamp()),
      updated_at = clock_timestamp()
  WHERE run_id = p_run_id;

  v_revision_count := v_run.priced_count + v_processed;
  v_remaining_count := GREATEST(v_run.target_count - v_revision_count, 0);

  RETURN json_build_object(
    'ok', TRUE,
    'processed', v_processed,
    'revisionCount', v_revision_count,
    'processedCount', v_revision_count,
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

  v_revision_count := v_run.priced_count;
  v_remaining_count := GREATEST(v_run.target_count - v_run.priced_count, 0);

  SELECT COALESCE(sum(epoch_row.event_count), 0)::BIGINT
  INTO v_post_snapshot_event_count
  FROM public.tokend_pricing_ingest_epochs AS epoch_row
  WHERE epoch_row.epoch > v_run.target_ingest_epoch;

  SELECT active_catalog_version, active_backfill_run_id
  INTO v_active_catalog_version, v_active_run_id
  FROM public.tokend_pricing_state
  WHERE singleton;

  RETURN json_build_object(
    'runId', v_run.run_id,
    'status', v_run.status,
    'catalogVersion', v_run.catalog_version,
    'snapshotAt', v_run.snapshot_at,
    'targetIngestEpoch', v_run.target_ingest_epoch,
    'targetCount', v_run.target_count,
    'targetHash', v_run.target_hash,
    'baseCatalogVersion', v_run.base_catalog_version,
    'baseRunId', v_run.base_backfill_run_id,
    'previousCatalogVersion', v_run.base_previous_catalog_version,
    'previousRunId', v_run.base_previous_backfill_run_id,
    'scannedCount', v_run.freeze_scanned_count,
    'frozenCount', v_run.frozen_count,
    'skippedCount', v_run.freeze_scanned_count - v_run.frozen_count,
    'freezeComplete', v_run.freeze_complete,
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

REVOKE ALL ON FUNCTION public.tokend_pricing_create_backfill(TEXT, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_pricing_compute_target_hash(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_pricing_compute_reconciliation_hash(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_pricing_freeze_batch(UUID, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_pricing_finalize_backfill(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_pricing_backfill_batch(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_pricing_reconcile(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_pricing_activate(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_pricing_rollback(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_pricing_get_backfill(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_pricing_preflight() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_pricing_health() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.tokend_pricing_create_backfill(TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.tokend_pricing_freeze_batch(UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.tokend_pricing_finalize_backfill(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.tokend_pricing_backfill_batch(UUID, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.tokend_pricing_reconcile(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.tokend_pricing_activate(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.tokend_pricing_rollback(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.tokend_pricing_get_backfill(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.tokend_pricing_preflight() TO service_role;
GRANT EXECUTE ON FUNCTION public.tokend_pricing_health() TO service_role;

NOTIFY pgrst, 'reload schema';
