-- Pricing-aware upload path, server-side estimator, and aggregate rollout preflight.
-- Additive to the production-compatible schema and 202607100001_pricing_core.sql.

CREATE OR REPLACE FUNCTION public.tokend_price_event(
  p_event JSONB,
  p_catalog_version TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_result JSONB;
  v_warnings JSONB := '[]'::JSONB;
  v_raw_model TEXT;
  v_candidate_model TEXT;
  v_matched_model TEXT;
  v_suffix_match TEXT[];
  v_suffix_date DATE;
  v_timestamp_value NUMERIC;
  v_timestamp_ms BIGINT;
  v_event_at TIMESTAMPTZ;
  v_field TEXT;
  v_value NUMERIC;
  v_input_tokens BIGINT := 0;
  v_output_tokens BIGINT := 0;
  v_reasoning_tokens BIGINT := 0;
  v_cache_read_tokens BIGINT := 0;
  v_cache_write_tokens BIGINT := 0;
  v_prompt_tokens BIGINT := 0;
  v_semantics TEXT := 'unknown';
  v_tier TEXT := 'standard';
  v_status TEXT;
  v_reason TEXT;
  v_price public.tokend_pricing_models%ROWTYPE;
  v_input_rate NUMERIC;
  v_output_rate NUMERIC;
  v_cache_read_rate NUMERIC;
  v_cache_write_rate NUMERIC;
  v_input_cost NUMERIC := 0;
  v_output_cost NUMERIC := 0;
  v_reasoning_cost NUMERIC := 0;
  v_cache_read_cost NUMERIC := 0;
  v_cache_write_cost NUMERIC := 0;
  v_total_cost NUMERIC := 0;
  v_money_limit CONSTANT NUMERIC := 9999999999.9999999999;
BEGIN
  v_result := jsonb_build_object(
    'status', 'unpriced',
    'pricingStatus', 'unpriced',
    'tier', 'standard',
    'pricingTier', 'standard',
    'model', NULL,
    'matchedModelId', NULL,
    'priceVersion', NULL,
    'inputCost', 0::NUMERIC,
    'outputCost', 0::NUMERIC,
    'reasoningCost', 0::NUMERIC,
    'cacheReadCost', 0::NUMERIC,
    'cacheWriteCost', 0::NUMERIC,
    'unallocatedCost', 0::NUMERIC,
    'totalCost', 0::NUMERIC,
    'breakdown', jsonb_build_object(
      'inputCost', 0::NUMERIC,
      'outputCost', 0::NUMERIC,
      'reasoningCost', 0::NUMERIC,
      'cacheReadCost', 0::NUMERIC,
      'cacheWriteCost', 0::NUMERIC,
      'unallocatedCost', 0::NUMERIC,
      'totalCost', 0::NUMERIC
    ),
    'breakdownStatus', 'reconciled',
    'reason', 'invalid_event',
    'warnings', v_warnings
  );

  IF jsonb_typeof(p_event) IS DISTINCT FROM 'object' THEN
    RETURN v_result;
  END IF;

  IF p_catalog_version IS NULL
    OR btrim(p_catalog_version) = ''
    OR NOT EXISTS (
      SELECT 1
      FROM public.tokend_pricing_catalogs
      WHERE version = p_catalog_version
    ) THEN
    RETURN v_result || jsonb_build_object('reason', 'unknown_catalog');
  END IF;

  IF jsonb_typeof(p_event->'model') IS DISTINCT FROM 'string'
    OR btrim(p_event->>'model') = '' THEN
    RETURN v_result || jsonb_build_object('reason', 'invalid_model');
  END IF;
  v_raw_model := p_event->>'model';

  SELECT canonical.model_id
  INTO v_matched_model
  FROM public.tokend_pricing_canonical_models AS canonical
  WHERE canonical.version = p_catalog_version
    AND canonical.model_id = v_raw_model
  LIMIT 1;

  IF v_matched_model IS NULL THEN
    SELECT alias_row.model_id
    INTO v_matched_model
    FROM public.tokend_pricing_aliases AS alias_row
    WHERE alias_row.version = p_catalog_version
      AND alias_row.alias = v_raw_model
    LIMIT 1;
  END IF;

  IF v_matched_model IS NULL THEN
    v_suffix_match := regexp_match(v_raw_model, '^(.*)-([0-9]{8})$');
    IF v_suffix_match IS NOT NULL
      AND v_suffix_match[1] <> ''
      AND substring(v_suffix_match[2], 1, 4)::INTEGER BETWEEN 1 AND 9999 THEN
      BEGIN
        v_suffix_date := make_date(
          substring(v_suffix_match[2], 1, 4)::INTEGER,
          substring(v_suffix_match[2], 5, 2)::INTEGER,
          substring(v_suffix_match[2], 7, 2)::INTEGER
        );
      EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
        v_suffix_date := NULL;
      END;

      IF v_suffix_date IS NOT NULL
        AND to_char(v_suffix_date, 'YYYYMMDD') = v_suffix_match[2] THEN
        v_candidate_model := v_suffix_match[1];
        SELECT canonical.model_id
        INTO v_matched_model
        FROM public.tokend_pricing_canonical_models AS canonical
        WHERE canonical.version = p_catalog_version
          AND canonical.model_id = v_candidate_model
        LIMIT 1;

        IF v_matched_model IS NULL THEN
          SELECT alias_row.model_id
          INTO v_matched_model
          FROM public.tokend_pricing_aliases AS alias_row
          WHERE alias_row.version = p_catalog_version
            AND alias_row.alias = v_candidate_model
          LIMIT 1;
        END IF;
      END IF;
    END IF;
  END IF;

  IF v_matched_model IS NULL THEN
    RETURN v_result || jsonb_build_object('reason', 'unknown_model');
  END IF;

  v_result := v_result || jsonb_build_object(
    'model', v_matched_model,
    'matchedModelId', v_matched_model
  );

  IF NOT (p_event ? 'timestampMs')
    OR jsonb_typeof(p_event->'timestampMs') IS DISTINCT FROM 'number' THEN
    RETURN v_result || jsonb_build_object('reason', 'invalid_event_time');
  END IF;
  BEGIN
    v_timestamp_value := (p_event->>'timestampMs')::NUMERIC;
  EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
    RETURN v_result || jsonb_build_object('reason', 'invalid_event_time');
  END;
  IF v_timestamp_value <> trunc(v_timestamp_value)
    OR v_timestamp_value < -62135596800000
    OR v_timestamp_value > 253402300799999 THEN
    RETURN v_result || jsonb_build_object('reason', 'invalid_event_time');
  END IF;
  v_timestamp_ms := v_timestamp_value::BIGINT;
  BEGIN
    v_event_at := TIMESTAMPTZ 'epoch'
      + v_timestamp_ms * INTERVAL '1 millisecond';
  EXCEPTION WHEN datetime_field_overflow OR numeric_value_out_of_range THEN
    RETURN v_result || jsonb_build_object('reason', 'invalid_event_time');
  END;

  FOREACH v_field IN ARRAY ARRAY[
    'inputTokens', 'outputTokens', 'reasoningTokens',
    'cacheReadTokens', 'cacheWriteTokens'
  ]
  LOOP
    IF NOT (p_event ? v_field)
      OR jsonb_typeof(p_event->v_field) IS DISTINCT FROM 'number' THEN
      RETURN v_result || jsonb_build_object('reason', 'invalid_token_buckets');
    END IF;
    BEGIN
      v_value := (p_event->>v_field)::NUMERIC;
    EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
      RETURN v_result || jsonb_build_object('reason', 'invalid_token_buckets');
    END;
    IF v_value < 0 OR v_value <> trunc(v_value) OR v_value > 2147483647 THEN
      RETURN v_result || jsonb_build_object('reason', 'invalid_token_buckets');
    END IF;

    CASE v_field
      WHEN 'inputTokens' THEN v_input_tokens := v_value::BIGINT;
      WHEN 'outputTokens' THEN v_output_tokens := v_value::BIGINT;
      WHEN 'reasoningTokens' THEN v_reasoning_tokens := v_value::BIGINT;
      WHEN 'cacheReadTokens' THEN v_cache_read_tokens := v_value::BIGINT;
      WHEN 'cacheWriteTokens' THEN v_cache_write_tokens := v_value::BIGINT;
    END CASE;
  END LOOP;

  SELECT model_price.*
  INTO v_price
  FROM public.tokend_pricing_models AS model_price
  WHERE model_price.version = p_catalog_version
    AND model_price.model_id = v_matched_model
    AND model_price.valid_from <= v_event_at
    AND (model_price.valid_to IS NULL OR v_event_at < model_price.valid_to)
  ORDER BY model_price.valid_from DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN v_result || jsonb_build_object('reason', 'no_effective_price');
  END IF;

  v_semantics := CASE
    WHEN p_event->>'tokenSemantics' = 'disjoint' THEN 'disjoint'
    ELSE 'unknown'
  END;
  v_prompt_tokens := v_input_tokens + v_cache_read_tokens + v_cache_write_tokens;
  v_input_rate := v_price.standard_input_rate;
  v_output_rate := v_price.standard_output_rate;
  v_cache_read_rate := v_price.standard_cache_read_rate;
  v_cache_write_rate := v_price.standard_cache_write_rate;

  IF v_semantics = 'unknown' AND v_price.long_context_threshold IS NOT NULL THEN
    v_warnings := jsonb_build_array('unknown_token_semantics');
  ELSIF v_semantics = 'disjoint'
    AND v_price.long_context_threshold IS NOT NULL
    AND v_prompt_tokens > v_price.long_context_threshold THEN
    v_tier := 'long_context';
    v_input_rate := v_price.long_context_input_rate;
    v_output_rate := v_price.long_context_output_rate;
    v_cache_read_rate := v_price.long_context_cache_read_rate;
    v_cache_write_rate := v_price.long_context_cache_write_rate;
  END IF;

  IF v_input_rate = 0
    AND v_output_rate = 0
    AND v_cache_read_rate = 0
    AND v_cache_write_rate = 0 THEN
    v_status := 'zero_rate';
    v_reason := 'explicit_zero_rate';
  ELSE
    v_status := 'estimated';
    v_reason := 'catalog_price';
  END IF;

  v_input_cost := v_input_tokens * v_input_rate / 1000000::NUMERIC;
  v_output_cost := v_output_tokens * v_output_rate / 1000000::NUMERIC;
  v_reasoning_cost := v_reasoning_tokens * v_output_rate / 1000000::NUMERIC;
  v_cache_read_cost := v_cache_read_tokens * v_cache_read_rate / 1000000::NUMERIC;
  v_cache_write_cost := v_cache_write_tokens * v_cache_write_rate / 1000000::NUMERIC;
  v_total_cost := v_input_cost + v_output_cost + v_reasoning_cost
    + v_cache_read_cost + v_cache_write_cost;

  IF v_input_cost < 0 OR v_input_cost > v_money_limit
    OR v_output_cost < 0 OR v_output_cost > v_money_limit
    OR v_reasoning_cost < 0 OR v_reasoning_cost > v_money_limit
    OR v_cache_read_cost < 0 OR v_cache_read_cost > v_money_limit
    OR v_cache_write_cost < 0 OR v_cache_write_cost > v_money_limit
    OR v_total_cost < 0 OR v_total_cost > v_money_limit THEN
    RETURN v_result || jsonb_build_object('reason', 'cost_out_of_range');
  END IF;

  RETURN jsonb_build_object(
    'status', v_status,
    'pricingStatus', v_status,
    'tier', v_tier,
    'pricingTier', v_tier,
    'model', v_matched_model,
    'matchedModelId', v_matched_model,
    'priceVersion', p_catalog_version || '/' || v_matched_model || '/'
      || to_char(v_price.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'inputCost', v_input_cost,
    'outputCost', v_output_cost,
    'reasoningCost', v_reasoning_cost,
    'cacheReadCost', v_cache_read_cost,
    'cacheWriteCost', v_cache_write_cost,
    'unallocatedCost', 0::NUMERIC,
    'totalCost', v_total_cost,
    'breakdown', jsonb_build_object(
      'inputCost', v_input_cost,
      'outputCost', v_output_cost,
      'reasoningCost', v_reasoning_cost,
      'cacheReadCost', v_cache_read_cost,
      'cacheWriteCost', v_cache_write_cost,
      'unallocatedCost', 0::NUMERIC,
      'totalCost', v_total_cost
    ),
    'breakdownStatus', 'reconciled',
    'reason', v_reason,
    'warnings', v_warnings
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
  v_snapshot_catalog_version TEXT;
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
    active_run.run_id,
    active_run.catalog_version
  INTO
    v_active_catalog_version,
    v_previous_catalog_version,
    v_active_run_id,
    v_previous_run_id,
    v_active_run_status,
    v_active_reconciliation_hash,
    v_snapshot_at,
    v_snapshot_run_id,
    v_snapshot_catalog_version
  FROM public.tokend_pricing_state AS pricing_state
  LEFT JOIN public.tokend_pricing_backfill_runs AS active_run
    ON active_run.run_id = pricing_state.active_backfill_run_id
  WHERE pricing_state.singleton;

  IF v_snapshot_at IS NULL THEN
    SELECT run.snapshot_at, run.run_id, run.catalog_version
    INTO v_snapshot_at, v_snapshot_run_id, v_snapshot_catalog_version
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
        AND COALESCE(usage_event.total_cost, 0) = 0
    )::BIGINT,
    count(*) FILTER (
      WHERE usage_event.pricing_status = 'unpriced'
        AND usage_event.total_tokens > 0
    )::BIGINT
  INTO
    v_event_count,
    v_eligible_event_count,
    v_eligible_zero_cost_count,
    v_unpriced_event_count
  FROM public.tokend_usage_events AS usage_event;

  SELECT COALESCE(
    json_agg(
      json_build_object(
        'model', model_rollup.model,
        'eventCount', model_rollup.event_count,
        'totalTokens', model_rollup.total_tokens
      )
      ORDER BY model_rollup.event_count DESC, model_rollup.model
    ),
    '[]'::JSON
  )
  INTO v_zero_cost_by_model
  FROM (
    SELECT
      COALESCE(usage_event.model, 'unknown') AS model,
      count(*)::BIGINT AS event_count,
      COALESCE(sum(usage_event.total_tokens), 0)::BIGINT AS total_tokens
    FROM public.tokend_usage_events AS usage_event
    WHERE usage_event.total_tokens > 0
      AND COALESCE(usage_event.total_cost, 0) = 0
    GROUP BY COALESCE(usage_event.model, 'unknown')
  ) AS model_rollup;

  SELECT count(*)::BIGINT
  INTO v_legacy_price_row_count
  FROM public.tokend_model_prices;

  SELECT json_build_object(
    'reported', count(*) FILTER (WHERE usage_event.pricing_status = 'reported'),
    'estimated', count(*) FILTER (WHERE usage_event.pricing_status = 'estimated'),
    'zero_rate', count(*) FILTER (WHERE usage_event.pricing_status = 'zero_rate'),
    'unpriced', count(*) FILTER (WHERE usage_event.pricing_status = 'unpriced'),
    'legacy', count(*) FILTER (WHERE usage_event.pricing_status = 'legacy'),
    'unset', count(*) FILTER (WHERE usage_event.pricing_status IS NULL)
  )
  INTO v_status_counts
  FROM public.tokend_usage_events AS usage_event;

  v_unpriced_share := CASE
    WHEN v_eligible_event_count = 0 THEN 0::NUMERIC
    ELSE round(v_unpriced_event_count::NUMERIC / v_eligible_event_count::NUMERIC, 10)
  END;

  IF v_snapshot_at IS NOT NULL THEN
    SELECT count(*)::BIGINT
    INTO v_post_snapshot_event_count
    FROM (
      SELECT DISTINCT revision.member_code, revision.event_id
      FROM public.tokend_event_cost_revisions AS revision
      WHERE revision.version = v_snapshot_catalog_version
        AND revision.backfill_run_id IS NULL
        AND revision.computed_at >= v_snapshot_at
        AND NOT EXISTS (
          SELECT 1
          FROM public.tokend_pricing_backfill_targets AS frozen_target
          WHERE frozen_target.run_id = v_snapshot_run_id
            AND frozen_target.member_code = revision.member_code
            AND frozen_target.event_id = revision.event_id
        )
    ) AS live_revision;
  END IF;

  IF v_active_catalog_version IS NOT NULL
    AND v_previous_catalog_version IS NOT NULL
    AND v_active_catalog_version <> v_previous_catalog_version
    AND EXISTS (
      SELECT 1
      FROM public.tokend_event_cost_revisions
      WHERE version = v_active_catalog_version
    )
    AND EXISTS (
      SELECT 1
      FROM public.tokend_event_cost_revisions
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

CREATE OR REPLACE FUNCTION public.tokend_upload_events_v2(
  p_token TEXT,
  p_events JSONB,
  p_sync_states JSONB
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_code TEXT;
  v_entry JSONB;
  v_evt JSONB;
  v_sync_state JSONB;
  v_field TEXT;
  v_value NUMERIC;
  v_timestamp_value NUMERIC;
  v_input_tokens BIGINT;
  v_output_tokens BIGINT;
  v_reasoning_tokens BIGINT;
  v_cache_read_tokens BIGINT;
  v_cache_write_tokens BIGINT;
  v_total_tokens BIGINT;
  v_input_cost NUMERIC;
  v_output_cost NUMERIC;
  v_reasoning_cost NUMERIC;
  v_cache_read_cost NUMERIC;
  v_cache_write_cost NUMERIC;
  v_unallocated_cost NUMERIC;
  v_total_cost NUMERIC;
  v_component_total NUMERIC;
  v_has_metadata BOOLEAN;
  v_costs_trustworthy BOOLEAN;
  v_all_costs_present BOOLEAN;
  v_any_cost BOOLEAN;
  v_base_status TEXT;
  v_pricing_tier TEXT;
  v_token_semantics TEXT;
  v_breakdown_status TEXT;
  v_inserted INTEGER := 0;
  v_row_count INTEGER;
  v_catalog_version TEXT;
  v_catalog_versions TEXT[] := ARRAY[]::TEXT[];
  v_price JSONB;
  v_money_limit CONSTANT NUMERIC := 9999999999.9999999999;
BEGIN
  SELECT member.member_code
  INTO v_code
  FROM public.tokend_members AS member
  WHERE member.token = p_token
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  IF jsonb_typeof(p_events) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'p_events must be a JSON array'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_sync_states) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'p_sync_states must be a JSON array'
      USING ERRCODE = '22023';
  END IF;

  -- Validate the complete batch before any persistent mutation.
  FOR v_entry IN
    SELECT event_entry.value
    FROM jsonb_array_elements(p_events) AS event_entry(value)
  LOOP
    IF jsonb_typeof(v_entry) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'event entries must be JSON objects'
        USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(v_entry->'id') IS DISTINCT FROM 'string'
      OR btrim(v_entry->>'id') = ''
      OR length(v_entry->>'id') > 512 THEN
      RAISE EXCEPTION 'event id must be a bounded non-empty string'
        USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_entry->'sessionId') IS DISTINCT FROM 'string'
      OR btrim(v_entry->>'sessionId') = ''
      OR length(v_entry->>'sessionId') > 512 THEN
      RAISE EXCEPTION 'event sessionId must be a bounded non-empty string'
        USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_entry->'model') IS DISTINCT FROM 'string'
      OR btrim(v_entry->>'model') = ''
      OR length(v_entry->>'model') > 512 THEN
      RAISE EXCEPTION 'event model must be a bounded non-empty string'
        USING ERRCODE = '22023';
    END IF;

    IF NOT (v_entry ? 'timestampMs')
      OR jsonb_typeof(v_entry->'timestampMs') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'event timestampMs must be a valid bounded bigint timestamp'
        USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_timestamp_value := (v_entry->>'timestampMs')::NUMERIC;
    EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
      RAISE EXCEPTION 'event timestampMs must be a valid bounded bigint timestamp'
        USING ERRCODE = '22023';
    END;
    IF v_timestamp_value <> trunc(v_timestamp_value)
      OR v_timestamp_value < -62135596800000
      OR v_timestamp_value > 253402300799999 THEN
      RAISE EXCEPTION 'event timestampMs must be a valid bounded bigint timestamp'
        USING ERRCODE = '22023';
    END IF;

    v_total_tokens := 0;
    FOREACH v_field IN ARRAY ARRAY[
      'inputTokens', 'outputTokens', 'reasoningTokens',
      'cacheReadTokens', 'cacheWriteTokens'
    ]
    LOOP
      IF NOT (v_entry ? v_field)
        OR jsonb_typeof(v_entry->v_field) IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'event % must be a bounded non-negative integer', v_field
          USING ERRCODE = '22023';
      END IF;
      BEGIN
        v_value := (v_entry->>v_field)::NUMERIC;
      EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
        RAISE EXCEPTION 'event % must be a bounded non-negative integer', v_field
          USING ERRCODE = '22023';
      END;
      IF v_value < 0 OR v_value <> trunc(v_value) OR v_value > 2147483647 THEN
        RAISE EXCEPTION 'event % must be a bounded non-negative integer', v_field
          USING ERRCODE = '22023';
      END IF;
      v_total_tokens := v_total_tokens + v_value::BIGINT;
    END LOOP;

    IF v_entry ? 'totalTokens' AND jsonb_typeof(v_entry->'totalTokens') <> 'null' THEN
      IF jsonb_typeof(v_entry->'totalTokens') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'event totalTokens must be a bounded non-negative integer'
          USING ERRCODE = '22023';
      END IF;
      BEGIN
        v_value := (v_entry->>'totalTokens')::NUMERIC;
      EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
        RAISE EXCEPTION 'event totalTokens must be a bounded non-negative integer'
          USING ERRCODE = '22023';
      END;
      IF v_value < 0 OR v_value <> trunc(v_value) OR v_value > 2147483647 THEN
        RAISE EXCEPTION 'event totalTokens must be a bounded non-negative integer'
          USING ERRCODE = '22023';
      END IF;
    ELSIF v_total_tokens > 2147483647 THEN
      RAISE EXCEPTION 'event totalTokens must be a bounded non-negative integer'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  FOR v_entry IN
    SELECT sync_entry.value
    FROM jsonb_array_elements(p_sync_states) AS sync_entry(value)
  LOOP
    IF jsonb_typeof(v_entry) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'sync state entries must be JSON objects'
        USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_entry->'sourcePathHash') IS DISTINCT FROM 'string'
      OR btrim(v_entry->>'sourcePathHash') = ''
      OR length(v_entry->>'sourcePathHash') > 512 THEN
      RAISE EXCEPTION 'sync state sourcePathHash must be a bounded non-empty string'
        USING ERRCODE = '22023';
    END IF;

    FOREACH v_field IN ARRAY ARRAY['lastProcessedLines', 'parserVersion']
    LOOP
      IF NOT (v_entry ? v_field) OR jsonb_typeof(v_entry->v_field) = 'null' THEN
        CONTINUE;
      END IF;
      IF jsonb_typeof(v_entry->v_field) IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'sync state % must be a bounded non-negative integer', v_field
          USING ERRCODE = '22023';
      END IF;
      BEGIN
        v_value := (v_entry->>v_field)::NUMERIC;
      EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
        RAISE EXCEPTION 'sync state % must be a bounded non-negative integer', v_field
          USING ERRCODE = '22023';
      END;
      IF v_value < 0 OR v_value <> trunc(v_value) OR v_value > 2147483647 THEN
        RAISE EXCEPTION 'sync state % must be a bounded non-negative integer', v_field
          USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END LOOP;

  SELECT COALESCE(
    array_agg(DISTINCT target.catalog_version ORDER BY target.catalog_version),
    ARRAY[]::TEXT[]
  )
  INTO v_catalog_versions
  FROM (
    SELECT pricing_state.active_catalog_version AS catalog_version
    FROM public.tokend_pricing_state AS pricing_state
    WHERE pricing_state.singleton
    UNION ALL
    SELECT pricing_state.previous_catalog_version AS catalog_version
    FROM public.tokend_pricing_state AS pricing_state
    WHERE pricing_state.singleton
    UNION ALL
    SELECT backfill.catalog_version
    FROM public.tokend_pricing_backfill_runs AS backfill
    WHERE backfill.status IN ('staging', 'reconciled')
      AND backfill.snapshot_at <= clock_timestamp()
  ) AS target
  WHERE target.catalog_version IS NOT NULL;

  FOR v_evt IN
    SELECT deduped.event_value
    FROM (
      SELECT DISTINCT ON (event_entry.value->>'id')
        event_entry.value AS event_value,
        event_entry.ordinality
      FROM jsonb_array_elements(p_events) WITH ORDINALITY AS event_entry(value, ordinality)
      ORDER BY event_entry.value->>'id', event_entry.ordinality
    ) AS deduped
    ORDER BY deduped.event_value->>'id'
  LOOP
    v_input_tokens := (v_evt->>'inputTokens')::BIGINT;
    v_output_tokens := (v_evt->>'outputTokens')::BIGINT;
    v_reasoning_tokens := (v_evt->>'reasoningTokens')::BIGINT;
    v_cache_read_tokens := (v_evt->>'cacheReadTokens')::BIGINT;
    v_cache_write_tokens := (v_evt->>'cacheWriteTokens')::BIGINT;
    v_total_tokens := CASE
      WHEN v_evt ? 'totalTokens' AND jsonb_typeof(v_evt->'totalTokens') = 'number'
        THEN (v_evt->>'totalTokens')::BIGINT
      ELSE v_input_tokens + v_output_tokens + v_reasoning_tokens
        + v_cache_read_tokens + v_cache_write_tokens
    END;

    v_has_metadata := v_evt ? 'pricingStatus'
      AND jsonb_typeof(v_evt->'pricingStatus') = 'string'
      AND btrim(v_evt->>'pricingStatus') <> '';
    v_costs_trustworthy := TRUE;
    v_all_costs_present := TRUE;
    FOREACH v_field IN ARRAY ARRAY[
      'inputCost', 'outputCost', 'reasoningCost',
      'cacheReadCost', 'cacheWriteCost', 'totalCost'
    ]
    LOOP
      IF NOT (v_evt ? v_field) OR jsonb_typeof(v_evt->v_field) = 'null' THEN
        v_all_costs_present := FALSE;
        CONTINUE;
      END IF;
      IF jsonb_typeof(v_evt->v_field) IS DISTINCT FROM 'number' THEN
        v_costs_trustworthy := FALSE;
        EXIT;
      END IF;
      BEGIN
        v_value := (v_evt->>v_field)::NUMERIC;
      EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
        v_costs_trustworthy := FALSE;
        EXIT;
      END;
      IF v_value < 0 OR v_value > v_money_limit THEN
        v_costs_trustworthy := FALSE;
        EXIT;
      END IF;
    END LOOP;

    IF v_costs_trustworthy
      AND v_evt ? 'unallocatedCost'
      AND jsonb_typeof(v_evt->'unallocatedCost') <> 'null' THEN
      IF jsonb_typeof(v_evt->'unallocatedCost') IS DISTINCT FROM 'number' THEN
        v_costs_trustworthy := FALSE;
      ELSE
        BEGIN
          v_value := (v_evt->>'unallocatedCost')::NUMERIC;
        EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
          v_costs_trustworthy := FALSE;
        END;
        IF v_costs_trustworthy AND (v_value < 0 OR v_value > v_money_limit) THEN
          v_costs_trustworthy := FALSE;
        END IF;
      END IF;
    END IF;

    IF v_costs_trustworthy THEN
      v_input_cost := COALESCE((v_evt->>'inputCost')::NUMERIC, 0);
      v_output_cost := COALESCE((v_evt->>'outputCost')::NUMERIC, 0);
      v_reasoning_cost := COALESCE((v_evt->>'reasoningCost')::NUMERIC, 0);
      v_cache_read_cost := COALESCE((v_evt->>'cacheReadCost')::NUMERIC, 0);
      v_cache_write_cost := COALESCE((v_evt->>'cacheWriteCost')::NUMERIC, 0);
      v_total_cost := COALESCE((v_evt->>'totalCost')::NUMERIC, 0);
      v_unallocated_cost := CASE
        WHEN v_evt ? 'unallocatedCost'
          AND jsonb_typeof(v_evt->'unallocatedCost') = 'number'
          THEN (v_evt->>'unallocatedCost')::NUMERIC
        ELSE 0::NUMERIC
      END;
    ELSE
      v_input_cost := 0;
      v_output_cost := 0;
      v_reasoning_cost := 0;
      v_cache_read_cost := 0;
      v_cache_write_cost := 0;
      v_unallocated_cost := 0;
      v_total_cost := 0;
    END IF;

    v_any_cost := v_input_cost <> 0
      OR v_output_cost <> 0
      OR v_reasoning_cost <> 0
      OR v_cache_read_cost <> 0
      OR v_cache_write_cost <> 0
      OR v_total_cost <> 0;
    v_token_semantics := CASE
      WHEN v_evt->>'tokenSemantics' = 'disjoint' THEN 'disjoint'
      ELSE 'unknown'
    END;

    IF v_evt->>'pricingStatus' = 'reported'
      AND v_costs_trustworthy
      AND v_all_costs_present THEN
      v_base_status := 'reported';
      v_pricing_tier := CASE
        WHEN v_evt->>'pricingTier' = 'long_context' THEN 'long_context'
        ELSE 'standard'
      END;
    ELSIF NOT v_has_metadata AND v_costs_trustworthy AND v_any_cost THEN
      v_base_status := 'legacy';
      v_pricing_tier := 'standard';
    ELSE
      v_base_status := 'unpriced';
      v_pricing_tier := 'standard';
      v_input_cost := 0;
      v_output_cost := 0;
      v_reasoning_cost := 0;
      v_cache_read_cost := 0;
      v_cache_write_cost := 0;
      v_unallocated_cost := 0;
      v_total_cost := 0;
    END IF;

    IF v_base_status IN ('reported', 'legacy') THEN
      v_component_total := v_input_cost + v_output_cost + v_reasoning_cost
        + v_cache_read_cost + v_cache_write_cost;
      v_breakdown_status := CASE
        WHEN v_evt->>'breakdownStatus' IN ('reconciled', 'unallocated', 'invalid')
          THEN v_evt->>'breakdownStatus'
        WHEN v_component_total > v_total_cost THEN 'invalid'
        WHEN v_component_total < v_total_cost THEN 'unallocated'
        ELSE 'reconciled'
      END;
    ELSE
      v_breakdown_status := 'reconciled';
    END IF;

    INSERT INTO public.tokend_usage_events (
      id, member_code, timestamp_ms, session_id, session_key,
      agent, provider, model, channel,
      input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens, total_tokens,
      input_cost, output_cost, reasoning_cost,
      cache_read_cost, cache_write_cost, total_cost,
      stop_reason, project,
      pricing_status, pricing_tier, price_version, matched_model_id,
      token_semantics, unallocated_cost, breakdown_status
    ) VALUES (
      v_evt->>'id',
      v_code,
      (v_evt->>'timestampMs')::BIGINT,
      v_evt->>'sessionId',
      LEFT(v_evt->>'sessionKey', 512),
      LEFT(v_evt->>'agent', 512),
      LEFT(v_evt->>'provider', 512),
      LEFT(v_evt->>'model', 512),
      LEFT(COALESCE(v_evt->>'channel', 'unknown'), 512),
      v_input_tokens,
      v_output_tokens,
      v_reasoning_tokens,
      v_cache_read_tokens,
      v_cache_write_tokens,
      v_total_tokens,
      v_input_cost,
      v_output_cost,
      v_reasoning_cost,
      v_cache_read_cost,
      v_cache_write_cost,
      v_total_cost,
      LEFT(v_evt->>'stopReason', 512),
      LEFT(v_evt->>'project', 256),
      v_base_status,
      v_pricing_tier,
      NULL,
      NULL,
      v_token_semantics,
      v_unallocated_cost,
      v_breakdown_status
    )
    ON CONFLICT (id, member_code) DO NOTHING;

    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    v_inserted := v_inserted + v_row_count;

    IF v_row_count = 0 THEN
      UPDATE public.tokend_usage_events
      SET project = COALESCE(
        LEFT(v_evt->>'project', 256),
        public.tokend_usage_events.project
      )
      WHERE id = v_evt->>'id'
        AND member_code = v_code;
    END IF;

    SELECT
      usage_event.pricing_status,
      jsonb_build_object(
        'id', usage_event.id,
        'timestampMs', usage_event.timestamp_ms,
        'sessionId', usage_event.session_id,
        'model', usage_event.model,
        'inputTokens', COALESCE(usage_event.input_tokens, 0),
        'outputTokens', COALESCE(usage_event.output_tokens, 0),
        'reasoningTokens', COALESCE(usage_event.reasoning_tokens, 0),
        'cacheReadTokens', COALESCE(usage_event.cache_read_tokens, 0),
        'cacheWriteTokens', COALESCE(usage_event.cache_write_tokens, 0),
        'tokenSemantics', COALESCE(usage_event.token_semantics, 'unknown')
      )
    INTO v_base_status, v_evt
    FROM public.tokend_usage_events AS usage_event
    WHERE usage_event.id = v_evt->>'id'
      AND usage_event.member_code = v_code;

    IF v_base_status NOT IN ('reported', 'legacy') THEN
      FOREACH v_catalog_version IN ARRAY v_catalog_versions
      LOOP
        v_price := public.tokend_price_event(v_evt, v_catalog_version);

        INSERT INTO public.tokend_event_cost_revisions (
          version, member_code, event_id, backfill_run_id,
          input_cost, output_cost, reasoning_cost,
          cache_read_cost, cache_write_cost, unallocated_cost, total_cost,
          pricing_status, pricing_tier, matched_model_id, price_version,
          breakdown_status, computed_at
        ) VALUES (
          v_catalog_version,
          v_code,
          v_evt->>'id',
          NULL,
          (v_price->>'inputCost')::NUMERIC,
          (v_price->>'outputCost')::NUMERIC,
          (v_price->>'reasoningCost')::NUMERIC,
          (v_price->>'cacheReadCost')::NUMERIC,
          (v_price->>'cacheWriteCost')::NUMERIC,
          (v_price->>'unallocatedCost')::NUMERIC,
          (v_price->>'totalCost')::NUMERIC,
          v_price->>'status',
          v_price->>'tier',
          v_price->>'matchedModelId',
          v_price->>'priceVersion',
          v_price->>'breakdownStatus',
          clock_timestamp()
        )
        ON CONFLICT (version, member_code, event_id) DO UPDATE SET
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
          computed_at = EXCLUDED.computed_at
        WHERE tokend_event_cost_revisions.pricing_status = 'unpriced'
          AND EXCLUDED.pricing_status IN ('estimated', 'zero_rate');
      END LOOP;
    END IF;
  END LOOP;

  FOR v_sync_state IN
    SELECT deduped.sync_value
    FROM (
      SELECT DISTINCT ON (sync_entry.value->>'sourcePathHash')
        sync_entry.value AS sync_value,
        sync_entry.ordinality
      FROM jsonb_array_elements(p_sync_states) WITH ORDINALITY AS sync_entry(value, ordinality)
      ORDER BY sync_entry.value->>'sourcePathHash', sync_entry.ordinality
    ) AS deduped
    ORDER BY deduped.sync_value->>'sourcePathHash'
  LOOP
    INSERT INTO public.tokend_sync_state (
      member_code, source_path_hash, last_processed_lines,
      parser_version, last_sync_at
    ) VALUES (
      v_code,
      v_sync_state->>'sourcePathHash',
      COALESCE((v_sync_state->>'lastProcessedLines')::INTEGER, 0),
      COALESCE((v_sync_state->>'parserVersion')::INTEGER, 1),
      clock_timestamp()
    )
    ON CONFLICT (member_code, source_path_hash) DO UPDATE SET
      last_processed_lines = EXCLUDED.last_processed_lines,
      parser_version = EXCLUDED.parser_version,
      last_sync_at = EXCLUDED.last_sync_at;
  END LOOP;

  RETURN json_build_object('ok', true, 'inserted', v_inserted);
END
$function$;

CREATE OR REPLACE FUNCTION public.tokend_upload_events(
  p_token TEXT,
  p_events JSONB,
  p_sync_states JSONB
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RETURN public.tokend_upload_events_v2(p_token, p_events, p_sync_states);
END
$function$;

REVOKE ALL ON FUNCTION public.tokend_price_event(JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_upload_events_v2(TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_pricing_preflight() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.tokend_upload_events_v2(TEXT, JSONB, JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tokend_pricing_preflight() TO service_role;

NOTIFY pgrst, 'reload schema';
