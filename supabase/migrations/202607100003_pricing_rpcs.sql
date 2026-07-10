-- One effective-cost relation and additive vNext dashboard RPCs.
-- Base reported costs and non-zero legacy costs are immutable sources of truth;
-- only the active catalog version can supply a revision. Backfill run ids remain
-- audit metadata and never participate in selection.

CREATE OR REPLACE VIEW public.tokend_effective_usage_events
WITH (security_barrier = true)
AS
WITH selected AS (
  SELECT
    usage_event.id,
    usage_event.member_code,
    usage_event.timestamp_ms,
    usage_event.session_id,
    usage_event.session_key,
    usage_event.agent,
    usage_event.provider,
    usage_event.model,
    usage_event.channel,
    usage_event.input_tokens,
    usage_event.output_tokens,
    usage_event.reasoning_tokens,
    usage_event.cache_read_tokens,
    usage_event.cache_write_tokens,
    usage_event.total_tokens,
    usage_event.input_cost,
    usage_event.output_cost,
    usage_event.reasoning_cost,
    usage_event.cache_read_cost,
    usage_event.cache_write_cost,
    usage_event.total_cost,
    usage_event.stop_reason,
    usage_event.project,
    usage_event.uploaded_at,
    usage_event.pricing_status,
    usage_event.pricing_tier,
    usage_event.price_version,
    usage_event.matched_model_id,
    usage_event.token_semantics,
    usage_event.unallocated_cost,
    usage_event.breakdown_status,
    pricing_state.active_catalog_version,
    revision.version AS revision_catalog_version,
    revision.backfill_run_id AS revision_backfill_run_id,
    revision.input_cost AS revision_input_cost,
    revision.output_cost AS revision_output_cost,
    revision.reasoning_cost AS revision_reasoning_cost,
    revision.cache_read_cost AS revision_cache_read_cost,
    revision.cache_write_cost AS revision_cache_write_cost,
    revision.unallocated_cost AS revision_unallocated_cost,
    revision.total_cost AS revision_total_cost,
    revision.pricing_status AS revision_pricing_status,
    revision.pricing_tier AS revision_pricing_tier,
    revision.matched_model_id AS revision_matched_model_id,
    revision.price_version AS revision_price_version,
    revision.breakdown_status AS revision_breakdown_status,
    CASE
      WHEN usage_event.pricing_status = 'reported' THEN 'reported'
      WHEN usage_event.pricing_status IN ('legacy')
        AND (
          COALESCE(usage_event.input_cost, 0) <> 0
          OR COALESCE(usage_event.output_cost, 0) <> 0
          OR COALESCE(usage_event.reasoning_cost, 0) <> 0
          OR COALESCE(usage_event.cache_read_cost, 0) <> 0
          OR COALESCE(usage_event.cache_write_cost, 0) <> 0
          OR COALESCE(usage_event.total_cost, 0) <> 0
          OR COALESCE(usage_event.unallocated_cost, 0) <> 0
        ) THEN 'legacy'
      WHEN usage_event.pricing_status IS NULL
        AND (
          COALESCE(usage_event.input_cost, 0) <> 0
          OR COALESCE(usage_event.output_cost, 0) <> 0
          OR COALESCE(usage_event.reasoning_cost, 0) <> 0
          OR COALESCE(usage_event.cache_read_cost, 0) <> 0
          OR COALESCE(usage_event.cache_write_cost, 0) <> 0
          OR COALESCE(usage_event.total_cost, 0) <> 0
          OR COALESCE(usage_event.unallocated_cost, 0) <> 0
        ) THEN 'legacy'
      WHEN revision.event_id IS NOT NULL THEN 'revision'
      ELSE 'unpriced'
    END AS effective_source
  FROM public.tokend_usage_events AS usage_event
  LEFT JOIN public.tokend_pricing_state AS pricing_state
    ON pricing_state.singleton
  LEFT JOIN public.tokend_event_cost_revisions AS revision
    ON revision.member_code = usage_event.member_code
   AND revision.event_id = usage_event.id
   AND revision.version = pricing_state.active_catalog_version
), costed AS (
  SELECT
    selected.*,
    CASE selected.effective_source
      WHEN 'reported' THEN COALESCE(selected.input_cost, 0)::NUMERIC
      WHEN 'legacy' THEN COALESCE(selected.input_cost, 0)::NUMERIC
      WHEN 'revision' THEN COALESCE(selected.revision_input_cost, 0)::NUMERIC
      ELSE 0::NUMERIC
    END AS selected_input_cost,
    CASE selected.effective_source
      WHEN 'reported' THEN COALESCE(selected.output_cost, 0)::NUMERIC
      WHEN 'legacy' THEN COALESCE(selected.output_cost, 0)::NUMERIC
      WHEN 'revision' THEN COALESCE(selected.revision_output_cost, 0)::NUMERIC
      ELSE 0::NUMERIC
    END AS selected_output_cost,
    CASE selected.effective_source
      WHEN 'reported' THEN COALESCE(selected.reasoning_cost, 0)::NUMERIC
      WHEN 'legacy' THEN COALESCE(selected.reasoning_cost, 0)::NUMERIC
      WHEN 'revision' THEN COALESCE(selected.revision_reasoning_cost, 0)::NUMERIC
      ELSE 0::NUMERIC
    END AS selected_reasoning_cost,
    CASE selected.effective_source
      WHEN 'reported' THEN COALESCE(selected.cache_read_cost, 0)::NUMERIC
      WHEN 'legacy' THEN COALESCE(selected.cache_read_cost, 0)::NUMERIC
      WHEN 'revision' THEN COALESCE(selected.revision_cache_read_cost, 0)::NUMERIC
      ELSE 0::NUMERIC
    END AS selected_cache_read_cost,
    CASE selected.effective_source
      WHEN 'reported' THEN COALESCE(selected.cache_write_cost, 0)::NUMERIC
      WHEN 'legacy' THEN COALESCE(selected.cache_write_cost, 0)::NUMERIC
      WHEN 'revision' THEN COALESCE(selected.revision_cache_write_cost, 0)::NUMERIC
      ELSE 0::NUMERIC
    END AS selected_cache_write_cost,
    CASE selected.effective_source
      WHEN 'reported' THEN COALESCE(selected.total_cost, 0)::NUMERIC
      WHEN 'legacy' THEN COALESCE(selected.total_cost, 0)::NUMERIC
      WHEN 'revision' THEN COALESCE(selected.revision_total_cost, 0)::NUMERIC
      ELSE 0::NUMERIC
    END AS selected_total_cost,
    CASE selected.effective_source
      WHEN 'reported' THEN 'reported'
      WHEN 'legacy' THEN 'legacy'
      WHEN 'revision' THEN COALESCE(selected.revision_pricing_status, 'unpriced')
      ELSE 'unpriced'
    END AS effective_pricing_status,
    CASE selected.effective_source
      WHEN 'reported' THEN COALESCE(selected.pricing_tier, 'standard')
      WHEN 'legacy' THEN COALESCE(selected.pricing_tier, 'standard')
      WHEN 'revision' THEN COALESCE(selected.revision_pricing_tier, 'standard')
      ELSE 'standard'
    END AS effective_pricing_tier,
    CASE selected.effective_source
      WHEN 'reported' THEN selected.price_version
      WHEN 'legacy' THEN selected.price_version
      WHEN 'revision' THEN selected.revision_catalog_version
      ELSE selected.active_catalog_version
    END AS effective_catalog_version,
    CASE selected.effective_source
      WHEN 'reported' THEN selected.matched_model_id
      WHEN 'legacy' THEN selected.matched_model_id
      WHEN 'revision' THEN selected.revision_matched_model_id
      ELSE NULL
    END AS effective_matched_model_id,
    CASE WHEN selected.effective_source = 'revision'
      THEN selected.revision_backfill_run_id ELSE NULL
    END AS effective_backfill_run_id
  FROM selected
), compared AS (
  SELECT
    costed.*,
    costed.selected_total_cost
      - costed.selected_input_cost - costed.selected_output_cost
      - costed.selected_reasoning_cost - costed.selected_cache_read_cost
      - costed.selected_cache_write_cost AS comparison_delta,
    -- Six independently rounded float4 values need an aggregate 5 ppm bound.
    CASE
      WHEN costed.effective_source IN ('reported', 'legacy')
        THEN (
          ABS(costed.selected_total_cost)
          + ABS(costed.selected_input_cost)
          + ABS(costed.selected_output_cost)
          + ABS(costed.selected_reasoning_cost)
          + ABS(costed.selected_cache_read_cost)
          + ABS(costed.selected_cache_write_cost)
        ) * 0.000005::NUMERIC
      ELSE 0::NUMERIC
    END AS comparison_epsilon,
    CASE
      WHEN costed.selected_input_cost >= costed.selected_output_cost
        AND costed.selected_input_cost >= costed.selected_reasoning_cost
        AND costed.selected_input_cost >= costed.selected_cache_read_cost
        AND costed.selected_input_cost >= costed.selected_cache_write_cost THEN 'input'
      WHEN costed.selected_output_cost >= costed.selected_reasoning_cost
        AND costed.selected_output_cost >= costed.selected_cache_read_cost
        AND costed.selected_output_cost >= costed.selected_cache_write_cost THEN 'output'
      WHEN costed.selected_reasoning_cost >= costed.selected_cache_read_cost
        AND costed.selected_reasoning_cost >= costed.selected_cache_write_cost THEN 'reasoning'
      WHEN costed.selected_cache_read_cost >= costed.selected_cache_write_cost THEN 'cache_read'
      ELSE 'cache_write'
    END AS normalization_target,
    GREATEST(
      costed.selected_input_cost,
      costed.selected_output_cost,
      costed.selected_reasoning_cost,
      costed.selected_cache_read_cost,
      costed.selected_cache_write_cost
    ) AS normalization_component
  FROM costed
), classified AS (
  SELECT
    compared.*,
    CASE
      WHEN comparison_delta < -comparison_epsilon THEN 'invalid'
      WHEN comparison_delta > comparison_epsilon THEN 'unallocated'
      WHEN comparison_delta < 0
        AND normalization_component + comparison_delta < 0 THEN 'invalid'
      ELSE 'reconciled'
    END AS effective_breakdown_status
  FROM compared
), resolved AS (
  SELECT
    classified.*,
    CASE
      WHEN classified.effective_breakdown_status = 'reconciled' AND classified.normalization_target = 'input'
        THEN classified.selected_input_cost + classified.comparison_delta
      ELSE classified.selected_input_cost
    END AS effective_input_cost,
    CASE
      WHEN classified.effective_breakdown_status = 'reconciled' AND classified.normalization_target = 'output'
        THEN classified.selected_output_cost + classified.comparison_delta
      ELSE classified.selected_output_cost
    END AS effective_output_cost,
    CASE
      WHEN classified.effective_breakdown_status = 'reconciled' AND classified.normalization_target = 'reasoning'
        THEN classified.selected_reasoning_cost + classified.comparison_delta
      ELSE classified.selected_reasoning_cost
    END AS effective_reasoning_cost,
    CASE
      WHEN classified.effective_breakdown_status = 'reconciled' AND classified.normalization_target = 'cache_read'
        THEN classified.selected_cache_read_cost + classified.comparison_delta
      ELSE classified.selected_cache_read_cost
    END AS effective_cache_read_cost,
    CASE
      WHEN classified.effective_breakdown_status = 'reconciled' AND classified.normalization_target = 'cache_write'
        THEN classified.selected_cache_write_cost + classified.comparison_delta
      ELSE classified.selected_cache_write_cost
    END AS effective_cache_write_cost,
    classified.selected_total_cost AS effective_total_cost
  FROM classified
)
SELECT
  resolved.id,
  resolved.member_code,
  resolved.timestamp_ms,
  resolved.session_id,
  resolved.session_key,
  resolved.agent,
  resolved.provider,
  resolved.model,
  resolved.channel,
  resolved.input_tokens,
  resolved.output_tokens,
  resolved.reasoning_tokens,
  resolved.cache_read_tokens,
  resolved.cache_write_tokens,
  resolved.total_tokens,
  resolved.input_cost,
  resolved.output_cost,
  resolved.reasoning_cost,
  resolved.cache_read_cost,
  resolved.cache_write_cost,
  resolved.total_cost,
  resolved.stop_reason,
  resolved.project,
  resolved.uploaded_at,
  resolved.pricing_status,
  resolved.pricing_tier,
  resolved.price_version,
  resolved.matched_model_id,
  resolved.token_semantics,
  resolved.unallocated_cost,
  resolved.breakdown_status,
  resolved.effective_input_cost,
  resolved.effective_output_cost,
  resolved.effective_reasoning_cost,
  resolved.effective_cache_read_cost,
  resolved.effective_cache_write_cost,
  CASE
    WHEN resolved.effective_breakdown_status = 'invalid'
      THEN 0::NUMERIC
    WHEN resolved.effective_breakdown_status = 'unallocated'
      THEN GREATEST(
      resolved.effective_total_cost
      - resolved.effective_input_cost
      - resolved.effective_output_cost
      - resolved.effective_reasoning_cost
      - resolved.effective_cache_read_cost
      - resolved.effective_cache_write_cost,
      0::NUMERIC
    )
    ELSE 0::NUMERIC
  END AS effective_unallocated_cost,
  resolved.effective_total_cost,
  resolved.effective_pricing_status,
  resolved.effective_pricing_tier,
  resolved.effective_catalog_version,
  resolved.effective_matched_model_id,
  resolved.effective_breakdown_status,
  resolved.effective_backfill_run_id,
  resolved.effective_source,
  resolved.total_tokens > 0 AS eligible_for_cost_coverage
FROM resolved;

REVOKE ALL PRIVILEGES ON TABLE public.tokend_effective_usage_events FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tokend_get_summary_v5(
  p_token TEXT,
  p_period TEXT DEFAULT '7d',
  p_timezone TEXT DEFAULT 'Asia/Shanghai'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_code TEXT;
  v_timezone TEXT := 'Asia/Shanghai';
  v_from_ms BIGINT;
  v_previous_from_ms BIGINT;
  v_current RECORD;
  v_previous RECORD;
  v_messages RECORD;
  v_current_envelope JSONB;
  v_previous_envelope JSONB;
  v_models JSONB;
  v_conversations JSONB;
BEGIN
  SELECT member_code INTO v_code
  FROM public.tokend_members
  WHERE token = p_token
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  SELECT COALESCE((SELECT name FROM pg_timezone_names WHERE name = p_timezone LIMIT 1), 'Asia/Shanghai')
  INTO v_timezone;
  IF p_period = '30d' THEN
    v_from_ms := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone(v_timezone, now())) - INTERVAL '29 days') AT TIME ZONE v_timezone)) * 1000)::BIGINT;
    v_previous_from_ms := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone(v_timezone, now())) - INTERVAL '59 days') AT TIME ZONE v_timezone)) * 1000)::BIGINT;
  ELSIF p_period = '1d' THEN
    v_from_ms := (EXTRACT(EPOCH FROM (now() - INTERVAL '24 hours')) * 1000)::BIGINT;
    v_previous_from_ms := (EXTRACT(EPOCH FROM (now() - INTERVAL '48 hours')) * 1000)::BIGINT;
  ELSE
    v_from_ms := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone(v_timezone, now())) - INTERVAL '6 days') AT TIME ZONE v_timezone)) * 1000)::BIGINT;
    v_previous_from_ms := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone(v_timezone, now())) - INTERVAL '13 days') AT TIME ZONE v_timezone)) * 1000)::BIGINT;
  END IF;

  DROP TABLE IF EXISTS pg_temp.tokend_summary_effective_events;
  CREATE TEMP TABLE tokend_summary_effective_events ON COMMIT DROP AS
  SELECT
    effective_event.*,
    effective_event.timestamp_ms >= v_from_ms AS is_current
  FROM public.tokend_effective_usage_events AS effective_event
  WHERE effective_event.member_code = v_code
    AND effective_event.timestamp_ms >= v_previous_from_ms
    AND COALESCE(effective_event.channel, '') NOT IN ('', 'unknown')
    AND NOT (
      effective_event.channel = 'cron'
      AND COALESCE(effective_event.session_key, '') = ''
    );

  WITH aggregate AS (
    SELECT
      COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens,
      COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::BIGINT AS reasoning_tokens,
      COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS cache_write_tokens,
      COALESCE(SUM(input_tokens), 0)::BIGINT + COALESCE(SUM(output_tokens), 0)::BIGINT
        + COALESCE(SUM(reasoning_tokens), 0)::BIGINT + COALESCE(SUM(cache_read_tokens), 0)::BIGINT
        + COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS total_tokens,
      COALESCE(SUM(effective_input_cost), 0)::NUMERIC AS input_cost,
      COALESCE(SUM(effective_output_cost), 0)::NUMERIC AS output_cost,
      COALESCE(SUM(effective_reasoning_cost), 0)::NUMERIC AS reasoning_cost,
      COALESCE(SUM(effective_cache_read_cost), 0)::NUMERIC AS cache_read_cost,
      COALESCE(SUM(effective_cache_write_cost), 0)::NUMERIC AS cache_write_cost,
      COALESCE(SUM(effective_unallocated_cost), 0)::NUMERIC AS unallocated_cost,
      COALESCE(SUM(effective_total_cost), 0)::NUMERIC AS total_cost,
      COUNT(*)::BIGINT AS call_count,
      COUNT(DISTINCT session_id)::BIGINT AS session_count,
      COUNT(DISTINCT channel)::BIGINT AS channel_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage)::BIGINT AS eligible_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'reported')::BIGINT AS reported_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'estimated')::BIGINT AS estimated_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'zero_rate')::BIGINT AS zero_rate_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'legacy')::BIGINT AS legacy_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'unpriced')::BIGINT AS unpriced_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_breakdown_status = 'invalid')::BIGINT AS breakdown_invalid_count
    FROM pg_temp.tokend_summary_effective_events
    WHERE is_current
  ), envelope AS (
    SELECT aggregate.*,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC,
        (reported_event_count + estimated_event_count + zero_rate_event_count + legacy_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS cost_availability,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC,
        (reported_event_count + estimated_event_count + zero_rate_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS verified_cost_coverage,
      CASE
        WHEN eligible_event_count = 0 THEN 'no_usage'
        WHEN unpriced_event_count = eligible_event_count THEN 'unpriced'
        WHEN zero_rate_event_count = eligible_event_count THEN 'zero_rate'
        WHEN unpriced_event_count > 0 AND unpriced_event_count < eligible_event_count THEN 'partial'
        WHEN unpriced_event_count = 0 AND legacy_event_count > 0 THEN 'legacy'
        ELSE 'complete'
      END AS coverage_status
    FROM aggregate
  ) SELECT * INTO v_current FROM envelope;

  WITH aggregate AS (
    SELECT
      COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens,
      COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::BIGINT AS reasoning_tokens,
      COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS cache_write_tokens,
      COALESCE(SUM(input_tokens), 0)::BIGINT + COALESCE(SUM(output_tokens), 0)::BIGINT + COALESCE(SUM(reasoning_tokens), 0)::BIGINT + COALESCE(SUM(cache_read_tokens), 0)::BIGINT + COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS total_tokens,
      COALESCE(SUM(effective_input_cost), 0)::NUMERIC AS input_cost,
      COALESCE(SUM(effective_output_cost), 0)::NUMERIC AS output_cost,
      COALESCE(SUM(effective_reasoning_cost), 0)::NUMERIC AS reasoning_cost,
      COALESCE(SUM(effective_cache_read_cost), 0)::NUMERIC AS cache_read_cost,
      COALESCE(SUM(effective_cache_write_cost), 0)::NUMERIC AS cache_write_cost,
      COALESCE(SUM(effective_unallocated_cost), 0)::NUMERIC AS unallocated_cost,
      COALESCE(SUM(effective_total_cost), 0)::NUMERIC AS total_cost,
      COUNT(*)::BIGINT AS call_count, COUNT(DISTINCT session_id)::BIGINT AS session_count, COUNT(DISTINCT channel)::BIGINT AS channel_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage)::BIGINT AS eligible_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'reported')::BIGINT AS reported_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'estimated')::BIGINT AS estimated_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'zero_rate')::BIGINT AS zero_rate_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'legacy')::BIGINT AS legacy_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'unpriced')::BIGINT AS unpriced_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_breakdown_status = 'invalid')::BIGINT AS breakdown_invalid_count
    FROM pg_temp.tokend_summary_effective_events
    WHERE NOT is_current
  ), envelope AS (
    SELECT aggregate.*,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count + legacy_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS cost_availability,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS verified_cost_coverage,
      CASE WHEN eligible_event_count = 0 THEN 'no_usage' WHEN unpriced_event_count = eligible_event_count THEN 'unpriced' WHEN zero_rate_event_count = eligible_event_count THEN 'zero_rate' WHEN unpriced_event_count > 0 AND unpriced_event_count < eligible_event_count THEN 'partial' WHEN unpriced_event_count = 0 AND legacy_event_count > 0 THEN 'legacy' ELSE 'complete' END AS coverage_status
    FROM aggregate
  ) SELECT * INTO v_previous FROM envelope;

  SELECT
    COUNT(*) FILTER (WHERE message.kind IN ('user', 'assistant') AND message.timestamp_ms >= v_from_ms)::BIGINT AS current_total,
    COUNT(*) FILTER (WHERE message.kind = 'user' AND message.timestamp_ms >= v_from_ms)::BIGINT AS current_user,
    COUNT(*) FILTER (WHERE message.kind IN ('user', 'assistant') AND message.timestamp_ms < v_from_ms)::BIGINT AS previous_total,
    COUNT(*) FILTER (WHERE message.kind = 'user' AND message.timestamp_ms < v_from_ms)::BIGINT AS previous_user
  INTO v_messages
  FROM public.tokend_message_events AS message
  WHERE message.member_code = v_code
    AND message.timestamp_ms >= v_previous_from_ms
    AND COALESCE(message.channel, '') NOT IN ('', 'unknown')
    AND message.session_id IN (
      SELECT DISTINCT session_id
      FROM pg_temp.tokend_summary_effective_events
    );

  v_current_envelope := jsonb_build_object(
    'inputTokens', v_current.input_tokens, 'outputTokens', v_current.output_tokens,
    'reasoningTokens', v_current.reasoning_tokens, 'cacheReadTokens', v_current.cache_read_tokens,
    'cacheWriteTokens', v_current.cache_write_tokens, 'totalTokens', v_current.total_tokens,
    'inputCost', v_current.input_cost, 'outputCost', v_current.output_cost,
    'reasoningCost', v_current.reasoning_cost, 'cacheReadCost', v_current.cache_read_cost,
    'cacheWriteCost', v_current.cache_write_cost, 'unallocatedCost', v_current.unallocated_cost,
    'totalCost', v_current.total_cost, 'eligibleEventCount', v_current.eligible_event_count,
    'reportedEventCount', v_current.reported_event_count, 'estimatedEventCount', v_current.estimated_event_count,
    'zeroRateEventCount', v_current.zero_rate_event_count, 'legacyEventCount', v_current.legacy_event_count,
    'unpricedEventCount', v_current.unpriced_event_count, 'breakdownInvalidCount', v_current.breakdown_invalid_count,
    'costAvailability', v_current.cost_availability, 'verifiedCostCoverage', v_current.verified_cost_coverage,
    'coverageStatus', v_current.coverage_status, 'costDetailsAvailable', true
  );
  v_previous_envelope := jsonb_build_object(
    'inputTokens', v_previous.input_tokens, 'outputTokens', v_previous.output_tokens,
    'reasoningTokens', v_previous.reasoning_tokens, 'cacheReadTokens', v_previous.cache_read_tokens,
    'cacheWriteTokens', v_previous.cache_write_tokens, 'totalTokens', v_previous.total_tokens,
    'inputCost', v_previous.input_cost, 'outputCost', v_previous.output_cost,
    'reasoningCost', v_previous.reasoning_cost, 'cacheReadCost', v_previous.cache_read_cost,
    'cacheWriteCost', v_previous.cache_write_cost, 'unallocatedCost', v_previous.unallocated_cost,
    'totalCost', v_previous.total_cost, 'eligibleEventCount', v_previous.eligible_event_count,
    'reportedEventCount', v_previous.reported_event_count, 'estimatedEventCount', v_previous.estimated_event_count,
    'zeroRateEventCount', v_previous.zero_rate_event_count, 'legacyEventCount', v_previous.legacy_event_count,
    'unpricedEventCount', v_previous.unpriced_event_count, 'breakdownInvalidCount', v_previous.breakdown_invalid_count,
    'costAvailability', v_previous.cost_availability, 'verifiedCostCoverage', v_previous.verified_cost_coverage,
    'coverageStatus', v_previous.coverage_status, 'costDetailsAvailable', true
  );

  WITH aggregate AS (
    SELECT model,
      COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens,
      COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::BIGINT AS reasoning_tokens,
      COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS cache_write_tokens,
      COALESCE(SUM(input_tokens), 0)::BIGINT + COALESCE(SUM(output_tokens), 0)::BIGINT + COALESCE(SUM(reasoning_tokens), 0)::BIGINT + COALESCE(SUM(cache_read_tokens), 0)::BIGINT + COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS total_tokens,
      COALESCE(SUM(effective_input_cost), 0)::NUMERIC AS input_cost,
      COALESCE(SUM(effective_output_cost), 0)::NUMERIC AS output_cost,
      COALESCE(SUM(effective_reasoning_cost), 0)::NUMERIC AS reasoning_cost,
      COALESCE(SUM(effective_cache_read_cost), 0)::NUMERIC AS cache_read_cost,
      COALESCE(SUM(effective_cache_write_cost), 0)::NUMERIC AS cache_write_cost,
      COALESCE(SUM(effective_unallocated_cost), 0)::NUMERIC AS unallocated_cost,
      COALESCE(SUM(effective_total_cost), 0)::NUMERIC AS total_cost,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage)::BIGINT AS eligible_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'reported')::BIGINT AS reported_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'estimated')::BIGINT AS estimated_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'zero_rate')::BIGINT AS zero_rate_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'legacy')::BIGINT AS legacy_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'unpriced')::BIGINT AS unpriced_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_breakdown_status = 'invalid')::BIGINT AS breakdown_invalid_count
    FROM pg_temp.tokend_summary_effective_events
    WHERE is_current
    GROUP BY model
  ), envelope AS (
    SELECT aggregate.*,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count + legacy_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS cost_availability,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS verified_cost_coverage,
      CASE WHEN eligible_event_count = 0 THEN 'no_usage' WHEN unpriced_event_count = eligible_event_count THEN 'unpriced' WHEN zero_rate_event_count = eligible_event_count THEN 'zero_rate' WHEN unpriced_event_count > 0 AND unpriced_event_count < eligible_event_count THEN 'partial' WHEN unpriced_event_count = 0 AND legacy_event_count > 0 THEN 'legacy' ELSE 'complete' END AS coverage_status
    FROM aggregate
  ), limited AS (SELECT * FROM envelope ORDER BY total_tokens DESC, model LIMIT 10)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'model', model, 'tokens', total_tokens,
    'inputTokens', input_tokens, 'outputTokens', output_tokens, 'reasoningTokens', reasoning_tokens,
    'cacheReadTokens', cache_read_tokens, 'cacheWriteTokens', cache_write_tokens, 'totalTokens', total_tokens,
    'inputCost', input_cost, 'outputCost', output_cost, 'reasoningCost', reasoning_cost,
    'cacheReadCost', cache_read_cost, 'cacheWriteCost', cache_write_cost,
    'unallocatedCost', unallocated_cost, 'totalCost', total_cost,
    'eligibleEventCount', eligible_event_count, 'reportedEventCount', reported_event_count,
    'estimatedEventCount', estimated_event_count, 'zeroRateEventCount', zero_rate_event_count,
    'legacyEventCount', legacy_event_count, 'unpricedEventCount', unpriced_event_count,
    'breakdownInvalidCount', breakdown_invalid_count, 'costAvailability', cost_availability,
    'verifiedCostCoverage', verified_cost_coverage, 'coverageStatus', coverage_status,
    'costDetailsAvailable', true
  ) ORDER BY total_tokens DESC, model), '[]'::JSONB)
  INTO v_models FROM limited;

  WITH aggregate AS (
    SELECT session_id,
      COALESCE((ARRAY_AGG(project ORDER BY timestamp_ms DESC, id DESC) FILTER (WHERE NULLIF(project, '') IS NOT NULL))[1],
        (ARRAY_AGG(agent ORDER BY timestamp_ms DESC, id DESC) FILTER (WHERE NULLIF(agent, '') IS NOT NULL))[1],
        LEFT(session_id, 8)) AS title,
      (ARRAY_AGG(channel ORDER BY timestamp_ms DESC, id DESC) FILTER (WHERE NULLIF(channel, '') IS NOT NULL))[1] AS channel,
      MAX(timestamp_ms)::BIGINT AS last_at,
      COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens,
      COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::BIGINT AS reasoning_tokens,
      COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS cache_write_tokens,
      COALESCE(SUM(input_tokens), 0)::BIGINT + COALESCE(SUM(output_tokens), 0)::BIGINT + COALESCE(SUM(reasoning_tokens), 0)::BIGINT + COALESCE(SUM(cache_read_tokens), 0)::BIGINT + COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS total_tokens,
      COALESCE(SUM(effective_input_cost), 0)::NUMERIC AS input_cost,
      COALESCE(SUM(effective_output_cost), 0)::NUMERIC AS output_cost,
      COALESCE(SUM(effective_reasoning_cost), 0)::NUMERIC AS reasoning_cost,
      COALESCE(SUM(effective_cache_read_cost), 0)::NUMERIC AS cache_read_cost,
      COALESCE(SUM(effective_cache_write_cost), 0)::NUMERIC AS cache_write_cost,
      COALESCE(SUM(effective_unallocated_cost), 0)::NUMERIC AS unallocated_cost,
      COALESCE(SUM(effective_total_cost), 0)::NUMERIC AS total_cost,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage)::BIGINT AS eligible_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'reported')::BIGINT AS reported_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'estimated')::BIGINT AS estimated_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'zero_rate')::BIGINT AS zero_rate_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'legacy')::BIGINT AS legacy_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'unpriced')::BIGINT AS unpriced_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_breakdown_status = 'invalid')::BIGINT AS breakdown_invalid_count
    FROM pg_temp.tokend_summary_effective_events
    WHERE is_current
    GROUP BY session_id
  ), envelope AS (
    SELECT aggregate.*,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count + legacy_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS cost_availability,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS verified_cost_coverage,
      CASE WHEN eligible_event_count = 0 THEN 'no_usage' WHEN unpriced_event_count = eligible_event_count THEN 'unpriced' WHEN zero_rate_event_count = eligible_event_count THEN 'zero_rate' WHEN unpriced_event_count > 0 AND unpriced_event_count < eligible_event_count THEN 'partial' WHEN unpriced_event_count = 0 AND legacy_event_count > 0 THEN 'legacy' ELSE 'complete' END AS coverage_status
    FROM aggregate
  ), limited AS (SELECT * FROM envelope ORDER BY total_tokens DESC, total_cost DESC, session_id LIMIT 8)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'sessionId', session_id, 'title', title, 'channel', channel,
    'tokens', total_tokens, 'cost', total_cost, 'lastAt', last_at,
    'inputTokens', input_tokens, 'outputTokens', output_tokens, 'reasoningTokens', reasoning_tokens,
    'cacheReadTokens', cache_read_tokens, 'cacheWriteTokens', cache_write_tokens, 'totalTokens', total_tokens,
    'inputCost', input_cost, 'outputCost', output_cost, 'reasoningCost', reasoning_cost,
    'cacheReadCost', cache_read_cost, 'cacheWriteCost', cache_write_cost,
    'unallocatedCost', unallocated_cost, 'totalCost', total_cost,
    'eligibleEventCount', eligible_event_count, 'reportedEventCount', reported_event_count,
    'estimatedEventCount', estimated_event_count, 'zeroRateEventCount', zero_rate_event_count,
    'legacyEventCount', legacy_event_count, 'unpricedEventCount', unpriced_event_count,
    'breakdownInvalidCount', breakdown_invalid_count, 'costAvailability', cost_availability,
    'verifiedCostCoverage', verified_cost_coverage, 'coverageStatus', coverage_status,
    'costDetailsAvailable', true
  ) ORDER BY total_tokens DESC, total_cost DESC, session_id), '[]'::JSONB)
  INTO v_conversations FROM limited;

  RETURN (
    jsonb_build_object(
      'ok', true,
      'callCount', v_current.call_count, 'sessionCount', v_current.session_count,
      'channelCount', v_current.channel_count,
      'messageCount', CASE WHEN COALESCE(v_messages.current_total, 0) > 0 THEN v_messages.current_total ELSE v_current.call_count END,
      'userMessageCount', CASE WHEN COALESCE(v_messages.current_user, 0) > 0 THEN v_messages.current_user ELSE NULL END,
      'current', v_current_envelope || jsonb_build_object(
        'callCount', v_current.call_count, 'sessionCount', v_current.session_count,
        'channelCount', v_current.channel_count,
        'messageCount', CASE WHEN COALESCE(v_messages.current_total, 0) > 0 THEN v_messages.current_total ELSE v_current.call_count END,
        'userMessageCount', CASE WHEN COALESCE(v_messages.current_user, 0) > 0 THEN v_messages.current_user ELSE NULL END
      ),
      'previous', v_previous_envelope || jsonb_build_object(
        'callCount', v_previous.call_count, 'sessionCount', v_previous.session_count,
        'channelCount', v_previous.channel_count,
        'messageCount', CASE WHEN COALESCE(v_messages.previous_total, 0) > 0 THEN v_messages.previous_total ELSE v_previous.call_count END,
        'userMessageCount', CASE WHEN COALESCE(v_messages.previous_user, 0) > 0 THEN v_messages.previous_user ELSE NULL END
      ),
      'modelDistribution', v_models,
      'topConversations', v_conversations
    ) || v_current_envelope
  )::JSON;
END
$function$;

CREATE OR REPLACE FUNCTION public.tokend_get_channel_breakdown_v4(
  p_token TEXT,
  p_period TEXT DEFAULT '7d'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_code TEXT;
  v_from_ms BIGINT;
  v_rows JSONB;
BEGIN
  SELECT member_code INTO v_code FROM public.tokend_members WHERE token = p_token LIMIT 1;
  IF NOT FOUND THEN RETURN json_build_object('ok', false, 'error', 'invalid_token'); END IF;
  IF p_period = '30d' THEN
    v_from_ms := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone('Asia/Shanghai', now())) - INTERVAL '29 days') AT TIME ZONE 'Asia/Shanghai')) * 1000)::BIGINT;
  ELSIF p_period = '1d' THEN
    v_from_ms := (EXTRACT(EPOCH FROM (now() - INTERVAL '24 hours')) * 1000)::BIGINT;
  ELSE
    v_from_ms := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone('Asia/Shanghai', now())) - INTERVAL '6 days') AT TIME ZONE 'Asia/Shanghai')) * 1000)::BIGINT;
  END IF;
  WITH source AS (
    SELECT * FROM public.tokend_effective_usage_events
    WHERE member_code = v_code AND timestamp_ms >= v_from_ms
      AND COALESCE(channel, '') NOT IN ('', 'unknown')
      AND NOT (channel = 'cron' AND COALESCE(session_key, '') = '')
  ), aggregate AS (
    SELECT channel,
      COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens,
      COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::BIGINT AS reasoning_tokens,
      COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS cache_write_tokens,
      COALESCE(SUM(input_tokens), 0)::BIGINT + COALESCE(SUM(output_tokens), 0)::BIGINT + COALESCE(SUM(reasoning_tokens), 0)::BIGINT + COALESCE(SUM(cache_read_tokens), 0)::BIGINT + COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS total_tokens,
      COALESCE(SUM(effective_input_cost), 0)::NUMERIC AS input_cost,
      COALESCE(SUM(effective_output_cost), 0)::NUMERIC AS output_cost,
      COALESCE(SUM(effective_reasoning_cost), 0)::NUMERIC AS reasoning_cost,
      COALESCE(SUM(effective_cache_read_cost), 0)::NUMERIC AS cache_read_cost,
      COALESCE(SUM(effective_cache_write_cost), 0)::NUMERIC AS cache_write_cost,
      COALESCE(SUM(effective_unallocated_cost), 0)::NUMERIC AS unallocated_cost,
      COALESCE(SUM(effective_total_cost), 0)::NUMERIC AS total_cost,
      COUNT(*)::BIGINT AS call_count, COUNT(DISTINCT session_id)::BIGINT AS session_count,
      MAX(timestamp_ms)::BIGINT AS last_seen,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage)::BIGINT AS eligible_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'reported')::BIGINT AS reported_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'estimated')::BIGINT AS estimated_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'zero_rate')::BIGINT AS zero_rate_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'legacy')::BIGINT AS legacy_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'unpriced')::BIGINT AS unpriced_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_breakdown_status = 'invalid')::BIGINT AS breakdown_invalid_count
    FROM source GROUP BY channel
  ), envelope AS (
    SELECT aggregate.*,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count + legacy_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS cost_availability,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS verified_cost_coverage,
      CASE WHEN eligible_event_count = 0 THEN 'no_usage' WHEN unpriced_event_count = eligible_event_count THEN 'unpriced' WHEN zero_rate_event_count = eligible_event_count THEN 'zero_rate' WHEN unpriced_event_count > 0 AND unpriced_event_count < eligible_event_count THEN 'partial' WHEN unpriced_event_count = 0 AND legacy_event_count > 0 THEN 'legacy' ELSE 'complete' END AS coverage_status
    FROM aggregate
  ), with_messages AS (
    SELECT envelope.*,
      (SELECT COUNT(*)::BIGINT FROM public.tokend_message_events AS message
       WHERE message.member_code = v_code AND message.channel = envelope.channel
         AND message.timestamp_ms >= v_from_ms
         AND message.session_id IN (SELECT session_id FROM source WHERE source.channel = envelope.channel)) AS message_count,
      (SELECT COUNT(*)::BIGINT FROM public.tokend_message_events AS message
       WHERE message.member_code = v_code AND message.channel = envelope.channel
         AND message.timestamp_ms >= v_from_ms AND message.kind = 'user'
         AND message.session_id IN (SELECT session_id FROM source WHERE source.channel = envelope.channel)) AS user_message_count
    FROM envelope
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'channel', channel, 'tokens', total_tokens, 'cost', total_cost, 'calls', call_count,
    'sessions', session_count, 'messageCount', message_count, 'userMessageCount', user_message_count,
    'lastSeen', last_seen,
    'inputTokens', input_tokens, 'outputTokens', output_tokens, 'reasoningTokens', reasoning_tokens,
    'cacheReadTokens', cache_read_tokens, 'cacheWriteTokens', cache_write_tokens, 'totalTokens', total_tokens,
    'inputCost', input_cost, 'outputCost', output_cost, 'reasoningCost', reasoning_cost,
    'cacheReadCost', cache_read_cost, 'cacheWriteCost', cache_write_cost, 'unallocatedCost', unallocated_cost,
    'totalCost', total_cost, 'eligibleEventCount', eligible_event_count, 'reportedEventCount', reported_event_count,
    'estimatedEventCount', estimated_event_count, 'zeroRateEventCount', zero_rate_event_count,
    'legacyEventCount', legacy_event_count, 'unpricedEventCount', unpriced_event_count,
    'breakdownInvalidCount', breakdown_invalid_count, 'costAvailability', cost_availability,
    'verifiedCostCoverage', verified_cost_coverage, 'coverageStatus', coverage_status,
    'costDetailsAvailable', true
  ) ORDER BY total_tokens DESC, channel), '[]'::JSONB) INTO v_rows FROM with_messages;
  RETURN json_build_object('ok', true, 'channels', v_rows);
END
$function$;


CREATE OR REPLACE FUNCTION public.tokend_get_model_breakdown_v3(
  p_token TEXT,
  p_period TEXT DEFAULT '7d'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_code TEXT;
  v_from_ms BIGINT;
  v_rows JSONB;
BEGIN
  SELECT member_code INTO v_code FROM public.tokend_members WHERE token = p_token LIMIT 1;
  IF NOT FOUND THEN RETURN json_build_object('ok', false, 'error', 'invalid_token'); END IF;
  IF p_period = '30d' THEN
    v_from_ms := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone('Asia/Shanghai', now())) - INTERVAL '29 days') AT TIME ZONE 'Asia/Shanghai')) * 1000)::BIGINT;
  ELSIF p_period = '1d' THEN
    v_from_ms := (EXTRACT(EPOCH FROM (now() - INTERVAL '24 hours')) * 1000)::BIGINT;
  ELSE
    v_from_ms := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone('Asia/Shanghai', now())) - INTERVAL '6 days') AT TIME ZONE 'Asia/Shanghai')) * 1000)::BIGINT;
  END IF;

  WITH source AS (
    SELECT * FROM public.tokend_effective_usage_events
    WHERE member_code = v_code AND timestamp_ms >= v_from_ms
      AND COALESCE(channel, '') NOT IN ('', 'unknown')
      AND NOT (channel = 'cron' AND COALESCE(session_key, '') = '')
  ), aggregate AS (
    SELECT model, MAX(provider) AS provider,
      COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens,
      COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::BIGINT AS reasoning_tokens,
      COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS cache_write_tokens,
      COALESCE(SUM(input_tokens), 0)::BIGINT + COALESCE(SUM(output_tokens), 0)::BIGINT + COALESCE(SUM(reasoning_tokens), 0)::BIGINT + COALESCE(SUM(cache_read_tokens), 0)::BIGINT + COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS total_tokens,
      COALESCE(SUM(effective_input_cost), 0)::NUMERIC AS input_cost,
      COALESCE(SUM(effective_output_cost), 0)::NUMERIC AS output_cost,
      COALESCE(SUM(effective_reasoning_cost), 0)::NUMERIC AS reasoning_cost,
      COALESCE(SUM(effective_cache_read_cost), 0)::NUMERIC AS cache_read_cost,
      COALESCE(SUM(effective_cache_write_cost), 0)::NUMERIC AS cache_write_cost,
      COALESCE(SUM(effective_unallocated_cost), 0)::NUMERIC AS unallocated_cost,
      COALESCE(SUM(effective_total_cost), 0)::NUMERIC AS total_cost,
      COUNT(*)::BIGINT AS call_count, COUNT(DISTINCT session_id)::BIGINT AS session_count,
      MAX(timestamp_ms)::BIGINT AS last_seen,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage)::BIGINT AS eligible_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'reported')::BIGINT AS reported_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'estimated')::BIGINT AS estimated_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'zero_rate')::BIGINT AS zero_rate_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'legacy')::BIGINT AS legacy_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'unpriced')::BIGINT AS unpriced_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_breakdown_status = 'invalid')::BIGINT AS breakdown_invalid_count
    FROM source GROUP BY model
  ), envelope AS (
    SELECT aggregate.*,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count + legacy_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS cost_availability,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS verified_cost_coverage,
      CASE WHEN eligible_event_count = 0 THEN 'no_usage' WHEN unpriced_event_count = eligible_event_count THEN 'unpriced' WHEN zero_rate_event_count = eligible_event_count THEN 'zero_rate' WHEN unpriced_event_count > 0 AND unpriced_event_count < eligible_event_count THEN 'partial' WHEN unpriced_event_count = 0 AND legacy_event_count > 0 THEN 'legacy' ELSE 'complete' END AS coverage_status
    FROM aggregate
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'model', model, 'provider', provider, 'tokens', total_tokens, 'cost', total_cost,
    'calls', call_count, 'sessionCount', session_count, 'lastSeen', last_seen,
    'inputTokens', input_tokens, 'outputTokens', output_tokens, 'reasoningTokens', reasoning_tokens,
    'cacheReadTokens', cache_read_tokens, 'cacheWriteTokens', cache_write_tokens, 'totalTokens', total_tokens,
    'inputCost', input_cost, 'outputCost', output_cost, 'reasoningCost', reasoning_cost,
    'cacheReadCost', cache_read_cost, 'cacheWriteCost', cache_write_cost,
    'unallocatedCost', unallocated_cost, 'totalCost', total_cost,
    'eligibleEventCount', eligible_event_count, 'reportedEventCount', reported_event_count,
    'estimatedEventCount', estimated_event_count, 'zeroRateEventCount', zero_rate_event_count,
    'legacyEventCount', legacy_event_count, 'unpricedEventCount', unpriced_event_count,
    'breakdownInvalidCount', breakdown_invalid_count, 'costAvailability', cost_availability,
    'verifiedCostCoverage', verified_cost_coverage, 'coverageStatus', coverage_status,
    'costDetailsAvailable', true
  ) ORDER BY total_tokens DESC, model), '[]'::JSONB) INTO v_rows FROM envelope;
  RETURN json_build_object('ok', true, 'models', v_rows);
END
$function$;


CREATE OR REPLACE FUNCTION public.tokend_get_daily_trend_v5(
  p_token TEXT,
  p_period TEXT DEFAULT '7d',
  p_timezone TEXT DEFAULT 'Asia/Shanghai'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_code TEXT;
  v_timezone TEXT := 'Asia/Shanghai';
  v_from_ms BIGINT;
  v_format TEXT;
  v_granularity TEXT;
  v_rows JSONB;
BEGIN
  SELECT member_code INTO v_code FROM public.tokend_members WHERE token = p_token LIMIT 1;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;
  SELECT COALESCE((SELECT name FROM pg_timezone_names WHERE name = p_timezone LIMIT 1), 'Asia/Shanghai') INTO v_timezone;
  IF p_period = '30d' THEN
    v_from_ms := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone(v_timezone, now())) - INTERVAL '29 days') AT TIME ZONE v_timezone)) * 1000)::BIGINT;
  ELSIF p_period = '1d' THEN
    v_from_ms := (EXTRACT(EPOCH FROM (now() - INTERVAL '24 hours')) * 1000)::BIGINT;
  ELSE
    v_from_ms := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone(v_timezone, now())) - INTERVAL '6 days') AT TIME ZONE v_timezone)) * 1000)::BIGINT;
  END IF;
  v_format := CASE WHEN p_period = '1d' THEN 'YYYY-MM-DD HH24:00' ELSE 'YYYY-MM-DD' END;
  v_granularity := CASE WHEN p_period = '1d' THEN 'hour' ELSE 'day' END;

  WITH source AS (
    SELECT *, TO_CHAR(timezone(v_timezone, TO_TIMESTAMP(timestamp_ms / 1000.0)), v_format) AS bucket
    FROM public.tokend_effective_usage_events
    WHERE member_code = v_code AND timestamp_ms >= v_from_ms
      AND COALESCE(channel, '') NOT IN ('', 'unknown')
      AND NOT (channel = 'cron' AND COALESCE(session_key, '') = '')
  ), aggregate AS (
    SELECT bucket,
      COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens,
      COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::BIGINT AS reasoning_tokens,
      COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS cache_write_tokens,
      COALESCE(SUM(input_tokens), 0)::BIGINT + COALESCE(SUM(output_tokens), 0)::BIGINT + COALESCE(SUM(reasoning_tokens), 0)::BIGINT + COALESCE(SUM(cache_read_tokens), 0)::BIGINT + COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS total_tokens,
      COALESCE(SUM(effective_input_cost), 0)::NUMERIC AS input_cost,
      COALESCE(SUM(effective_output_cost), 0)::NUMERIC AS output_cost,
      COALESCE(SUM(effective_reasoning_cost), 0)::NUMERIC AS reasoning_cost,
      COALESCE(SUM(effective_cache_read_cost), 0)::NUMERIC AS cache_read_cost,
      COALESCE(SUM(effective_cache_write_cost), 0)::NUMERIC AS cache_write_cost,
      COALESCE(SUM(effective_unallocated_cost), 0)::NUMERIC AS unallocated_cost,
      COALESCE(SUM(effective_total_cost), 0)::NUMERIC AS total_cost,
      COUNT(*)::BIGINT AS call_count, COUNT(DISTINCT session_id)::BIGINT AS session_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage)::BIGINT AS eligible_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'reported')::BIGINT AS reported_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'estimated')::BIGINT AS estimated_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'zero_rate')::BIGINT AS zero_rate_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'legacy')::BIGINT AS legacy_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'unpriced')::BIGINT AS unpriced_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_breakdown_status = 'invalid')::BIGINT AS breakdown_invalid_count
    FROM source GROUP BY bucket
  ), envelope AS (
    SELECT aggregate.*,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count + legacy_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS cost_availability,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS verified_cost_coverage,
      CASE WHEN eligible_event_count = 0 THEN 'no_usage' WHEN unpriced_event_count = eligible_event_count THEN 'unpriced' WHEN zero_rate_event_count = eligible_event_count THEN 'zero_rate' WHEN unpriced_event_count > 0 AND unpriced_event_count < eligible_event_count THEN 'partial' WHEN unpriced_event_count = 0 AND legacy_event_count > 0 THEN 'legacy' ELSE 'complete' END AS coverage_status
    FROM aggregate
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'day', bucket, 'tokens', total_tokens, 'cost', total_cost, 'calls', call_count, 'sessions', session_count,
    'inputTokens', input_tokens, 'outputTokens', output_tokens, 'reasoningTokens', reasoning_tokens,
    'cacheReadTokens', cache_read_tokens, 'cacheWriteTokens', cache_write_tokens, 'totalTokens', total_tokens,
    'inputCost', input_cost, 'outputCost', output_cost, 'reasoningCost', reasoning_cost,
    'cacheReadCost', cache_read_cost, 'cacheWriteCost', cache_write_cost,
    'unallocatedCost', unallocated_cost, 'totalCost', total_cost,
    'eligibleEventCount', eligible_event_count, 'reportedEventCount', reported_event_count,
    'estimatedEventCount', estimated_event_count, 'zeroRateEventCount', zero_rate_event_count,
    'legacyEventCount', legacy_event_count, 'unpricedEventCount', unpriced_event_count,
    'breakdownInvalidCount', breakdown_invalid_count, 'costAvailability', cost_availability,
    'verifiedCostCoverage', verified_cost_coverage, 'coverageStatus', coverage_status,
    'costDetailsAvailable', true
  ) ORDER BY bucket), '[]'::JSONB) INTO v_rows FROM envelope;

  RETURN json_build_object('ok', true, 'granularity', v_granularity, 'days', v_rows);
END
$function$;

CREATE OR REPLACE FUNCTION public.tokend_get_model_detail_v2(
  p_token TEXT,
  p_model TEXT,
  p_period TEXT DEFAULT '7d'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_code TEXT;
  v_from_ms BIGINT;
  v_summary RECORD;
  v_envelope JSONB;
  v_trend JSONB;
  v_mix JSONB;
BEGIN
  SELECT member_code INTO v_code FROM public.tokend_members WHERE token = p_token LIMIT 1;
  IF NOT FOUND THEN RETURN json_build_object('ok', false, 'error', 'invalid_token'); END IF;
  IF p_period = '30d' THEN
    v_from_ms := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone('Asia/Shanghai', now())) - INTERVAL '29 days') AT TIME ZONE 'Asia/Shanghai')) * 1000)::BIGINT;
  ELSIF p_period = '1d' THEN
    v_from_ms := (EXTRACT(EPOCH FROM (now() - INTERVAL '24 hours')) * 1000)::BIGINT;
  ELSE
    v_from_ms := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone('Asia/Shanghai', now())) - INTERVAL '6 days') AT TIME ZONE 'Asia/Shanghai')) * 1000)::BIGINT;
  END IF;

  WITH aggregate AS (
    SELECT MAX(provider) AS provider,
      COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens,
      COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::BIGINT AS reasoning_tokens,
      COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS cache_write_tokens,
      COALESCE(SUM(input_tokens), 0)::BIGINT + COALESCE(SUM(output_tokens), 0)::BIGINT + COALESCE(SUM(reasoning_tokens), 0)::BIGINT + COALESCE(SUM(cache_read_tokens), 0)::BIGINT + COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS total_tokens,
      COALESCE(SUM(effective_input_cost), 0)::NUMERIC AS input_cost,
      COALESCE(SUM(effective_output_cost), 0)::NUMERIC AS output_cost,
      COALESCE(SUM(effective_reasoning_cost), 0)::NUMERIC AS reasoning_cost,
      COALESCE(SUM(effective_cache_read_cost), 0)::NUMERIC AS cache_read_cost,
      COALESCE(SUM(effective_cache_write_cost), 0)::NUMERIC AS cache_write_cost,
      COALESCE(SUM(effective_unallocated_cost), 0)::NUMERIC AS unallocated_cost,
      COALESCE(SUM(effective_total_cost), 0)::NUMERIC AS total_cost,
      COUNT(*)::BIGINT AS call_count, COUNT(DISTINCT session_id)::BIGINT AS session_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage)::BIGINT AS eligible_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'reported')::BIGINT AS reported_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'estimated')::BIGINT AS estimated_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'zero_rate')::BIGINT AS zero_rate_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'legacy')::BIGINT AS legacy_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'unpriced')::BIGINT AS unpriced_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_breakdown_status = 'invalid')::BIGINT AS breakdown_invalid_count
    FROM public.tokend_effective_usage_events
    WHERE member_code = v_code AND model = p_model AND timestamp_ms >= v_from_ms
      AND COALESCE(channel, '') NOT IN ('', 'unknown') AND NOT (channel = 'cron' AND COALESCE(session_key, '') = '')
  ), envelope AS (
    SELECT aggregate.*,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count + legacy_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS cost_availability,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS verified_cost_coverage,
      CASE WHEN eligible_event_count = 0 THEN 'no_usage' WHEN unpriced_event_count = eligible_event_count THEN 'unpriced' WHEN zero_rate_event_count = eligible_event_count THEN 'zero_rate' WHEN unpriced_event_count > 0 AND unpriced_event_count < eligible_event_count THEN 'partial' WHEN unpriced_event_count = 0 AND legacy_event_count > 0 THEN 'legacy' ELSE 'complete' END AS coverage_status
    FROM aggregate
  ) SELECT * INTO v_summary FROM envelope;

  v_envelope := jsonb_build_object(
    'inputTokens', v_summary.input_tokens, 'outputTokens', v_summary.output_tokens,
    'reasoningTokens', v_summary.reasoning_tokens, 'cacheReadTokens', v_summary.cache_read_tokens,
    'cacheWriteTokens', v_summary.cache_write_tokens, 'totalTokens', v_summary.total_tokens,
    'inputCost', v_summary.input_cost, 'outputCost', v_summary.output_cost,
    'reasoningCost', v_summary.reasoning_cost, 'cacheReadCost', v_summary.cache_read_cost,
    'cacheWriteCost', v_summary.cache_write_cost, 'unallocatedCost', v_summary.unallocated_cost,
    'totalCost', v_summary.total_cost, 'eligibleEventCount', v_summary.eligible_event_count,
    'reportedEventCount', v_summary.reported_event_count, 'estimatedEventCount', v_summary.estimated_event_count,
    'zeroRateEventCount', v_summary.zero_rate_event_count, 'legacyEventCount', v_summary.legacy_event_count,
    'unpricedEventCount', v_summary.unpriced_event_count, 'breakdownInvalidCount', v_summary.breakdown_invalid_count,
    'costAvailability', v_summary.cost_availability, 'verifiedCostCoverage', v_summary.verified_cost_coverage,
    'coverageStatus', v_summary.coverage_status, 'costDetailsAvailable', true
  );

  WITH source AS (
    SELECT *, TO_CHAR(timezone('Asia/Shanghai', TO_TIMESTAMP(timestamp_ms / 1000.0)), CASE WHEN p_period = '1d' THEN 'YYYY-MM-DD HH24:00' ELSE 'YYYY-MM-DD' END) AS bucket
    FROM public.tokend_effective_usage_events
    WHERE member_code = v_code AND model = p_model AND timestamp_ms >= v_from_ms
      AND COALESCE(channel, '') NOT IN ('', 'unknown') AND NOT (channel = 'cron' AND COALESCE(session_key, '') = '')
  ), aggregate AS (
    SELECT bucket,
      COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens, COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::BIGINT AS reasoning_tokens, COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS cache_write_tokens,
      COALESCE(SUM(input_tokens), 0)::BIGINT + COALESCE(SUM(output_tokens), 0)::BIGINT + COALESCE(SUM(reasoning_tokens), 0)::BIGINT + COALESCE(SUM(cache_read_tokens), 0)::BIGINT + COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS total_tokens,
      COALESCE(SUM(effective_input_cost), 0)::NUMERIC AS input_cost, COALESCE(SUM(effective_output_cost), 0)::NUMERIC AS output_cost,
      COALESCE(SUM(effective_reasoning_cost), 0)::NUMERIC AS reasoning_cost, COALESCE(SUM(effective_cache_read_cost), 0)::NUMERIC AS cache_read_cost,
      COALESCE(SUM(effective_cache_write_cost), 0)::NUMERIC AS cache_write_cost, COALESCE(SUM(effective_unallocated_cost), 0)::NUMERIC AS unallocated_cost,
      COALESCE(SUM(effective_total_cost), 0)::NUMERIC AS total_cost,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage)::BIGINT AS eligible_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'reported')::BIGINT AS reported_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'estimated')::BIGINT AS estimated_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'zero_rate')::BIGINT AS zero_rate_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'legacy')::BIGINT AS legacy_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'unpriced')::BIGINT AS unpriced_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_breakdown_status = 'invalid')::BIGINT AS breakdown_invalid_count
    FROM source GROUP BY bucket
  ), envelope AS (
    SELECT aggregate.*,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count + legacy_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS cost_availability,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS verified_cost_coverage,
      CASE WHEN eligible_event_count = 0 THEN 'no_usage' WHEN unpriced_event_count = eligible_event_count THEN 'unpriced' WHEN zero_rate_event_count = eligible_event_count THEN 'zero_rate' WHEN unpriced_event_count > 0 AND unpriced_event_count < eligible_event_count THEN 'partial' WHEN unpriced_event_count = 0 AND legacy_event_count > 0 THEN 'legacy' ELSE 'complete' END AS coverage_status
    FROM aggregate
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'day', bucket, 'tokens', total_tokens, 'cost', total_cost,
      'inputTokens', input_tokens, 'outputTokens', output_tokens, 'reasoningTokens', reasoning_tokens,
      'cacheReadTokens', cache_read_tokens, 'cacheWriteTokens', cache_write_tokens, 'totalTokens', total_tokens,
      'inputCost', input_cost, 'outputCost', output_cost, 'reasoningCost', reasoning_cost,
      'cacheReadCost', cache_read_cost, 'cacheWriteCost', cache_write_cost, 'unallocatedCost', unallocated_cost, 'totalCost', total_cost,
      'eligibleEventCount', eligible_event_count, 'reportedEventCount', reported_event_count, 'estimatedEventCount', estimated_event_count,
      'zeroRateEventCount', zero_rate_event_count, 'legacyEventCount', legacy_event_count, 'unpricedEventCount', unpriced_event_count,
      'breakdownInvalidCount', breakdown_invalid_count, 'costAvailability', cost_availability,
      'verifiedCostCoverage', verified_cost_coverage, 'coverageStatus', coverage_status, 'costDetailsAvailable', true
    ) ORDER BY bucket), '[]'::JSONB) INTO v_trend FROM envelope;

  WITH aggregate AS (
    SELECT channel,
      COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens, COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::BIGINT AS reasoning_tokens, COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS cache_write_tokens,
      COALESCE(SUM(input_tokens), 0)::BIGINT + COALESCE(SUM(output_tokens), 0)::BIGINT + COALESCE(SUM(reasoning_tokens), 0)::BIGINT + COALESCE(SUM(cache_read_tokens), 0)::BIGINT + COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS total_tokens,
      COALESCE(SUM(effective_input_cost), 0)::NUMERIC AS input_cost, COALESCE(SUM(effective_output_cost), 0)::NUMERIC AS output_cost,
      COALESCE(SUM(effective_reasoning_cost), 0)::NUMERIC AS reasoning_cost, COALESCE(SUM(effective_cache_read_cost), 0)::NUMERIC AS cache_read_cost,
      COALESCE(SUM(effective_cache_write_cost), 0)::NUMERIC AS cache_write_cost, COALESCE(SUM(effective_unallocated_cost), 0)::NUMERIC AS unallocated_cost,
      COALESCE(SUM(effective_total_cost), 0)::NUMERIC AS total_cost, COUNT(*)::BIGINT AS call_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage)::BIGINT AS eligible_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'reported')::BIGINT AS reported_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'estimated')::BIGINT AS estimated_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'zero_rate')::BIGINT AS zero_rate_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'legacy')::BIGINT AS legacy_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'unpriced')::BIGINT AS unpriced_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_breakdown_status = 'invalid')::BIGINT AS breakdown_invalid_count
    FROM public.tokend_effective_usage_events
    WHERE member_code = v_code AND model = p_model AND timestamp_ms >= v_from_ms
      AND COALESCE(channel, '') NOT IN ('', 'unknown') AND NOT (channel = 'cron' AND COALESCE(session_key, '') = '')
    GROUP BY channel
  ), envelope AS (
    SELECT aggregate.*,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count + legacy_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS cost_availability,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS verified_cost_coverage,
      CASE WHEN eligible_event_count = 0 THEN 'no_usage' WHEN unpriced_event_count = eligible_event_count THEN 'unpriced' WHEN zero_rate_event_count = eligible_event_count THEN 'zero_rate' WHEN unpriced_event_count > 0 AND unpriced_event_count < eligible_event_count THEN 'partial' WHEN unpriced_event_count = 0 AND legacy_event_count > 0 THEN 'legacy' ELSE 'complete' END AS coverage_status
    FROM aggregate
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'channel', channel, 'calls', call_count, 'tokens', total_tokens, 'cost', total_cost,
      'inputTokens', input_tokens, 'outputTokens', output_tokens, 'reasoningTokens', reasoning_tokens,
      'cacheReadTokens', cache_read_tokens, 'cacheWriteTokens', cache_write_tokens, 'totalTokens', total_tokens,
      'inputCost', input_cost, 'outputCost', output_cost, 'reasoningCost', reasoning_cost,
      'cacheReadCost', cache_read_cost, 'cacheWriteCost', cache_write_cost, 'unallocatedCost', unallocated_cost, 'totalCost', total_cost,
      'eligibleEventCount', eligible_event_count, 'reportedEventCount', reported_event_count, 'estimatedEventCount', estimated_event_count,
      'zeroRateEventCount', zero_rate_event_count, 'legacyEventCount', legacy_event_count, 'unpricedEventCount', unpriced_event_count,
      'breakdownInvalidCount', breakdown_invalid_count, 'costAvailability', cost_availability,
      'verifiedCostCoverage', verified_cost_coverage, 'coverageStatus', coverage_status, 'costDetailsAvailable', true
    ) ORDER BY total_tokens DESC, channel), '[]'::JSONB) INTO v_mix FROM envelope;

  RETURN (jsonb_build_object(
    'ok', true, 'model', p_model, 'provider', v_summary.provider,
    'callCount', v_summary.call_count, 'sessionCount', v_summary.session_count,
    'avgTokensPerCall', CASE WHEN v_summary.call_count = 0 THEN 0 ELSE v_summary.total_tokens / v_summary.call_count END,
    'summary', v_envelope || jsonb_build_object(
      'model', p_model, 'provider', v_summary.provider, 'callCount', v_summary.call_count,
      'sessionCount', v_summary.session_count,
      'avgTokensPerCall', CASE WHEN v_summary.call_count = 0 THEN 0 ELSE v_summary.total_tokens / v_summary.call_count END
    ),
    'dailyTrend', v_trend, 'channelMix', v_mix
  ) || v_envelope)::JSON;
END
$function$;

CREATE OR REPLACE FUNCTION public.tokend_get_channel_detail_v3(
  p_token TEXT,
  p_channel TEXT,
  p_period TEXT DEFAULT '7d',
  p_timezone TEXT DEFAULT 'Asia/Shanghai'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_code TEXT;
  v_timezone TEXT := 'Asia/Shanghai';
  v_from_ms BIGINT;
  v_summary RECORD;
  v_envelope JSONB;
  v_trend JSONB;
  v_mix JSONB;
  v_sessions JSONB;
BEGIN
  SELECT member_code INTO v_code FROM public.tokend_members WHERE token = p_token LIMIT 1;
  IF NOT FOUND THEN RETURN json_build_object('ok', false, 'error', 'invalid_token'); END IF;
  SELECT COALESCE((SELECT name FROM pg_timezone_names WHERE name = p_timezone LIMIT 1), 'Asia/Shanghai') INTO v_timezone;
  IF p_period = '30d' THEN
    v_from_ms := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone(v_timezone, now())) - INTERVAL '29 days') AT TIME ZONE v_timezone)) * 1000)::BIGINT;
  ELSIF p_period = '1d' THEN v_from_ms := (EXTRACT(EPOCH FROM (now() - INTERVAL '24 hours')) * 1000)::BIGINT;
  ELSE v_from_ms := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone(v_timezone, now())) - INTERVAL '6 days') AT TIME ZONE v_timezone)) * 1000)::BIGINT;
  END IF;
  WITH aggregate AS (
    SELECT
      COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens, COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::BIGINT AS reasoning_tokens, COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS cache_write_tokens,
      COALESCE(SUM(input_tokens), 0)::BIGINT + COALESCE(SUM(output_tokens), 0)::BIGINT + COALESCE(SUM(reasoning_tokens), 0)::BIGINT + COALESCE(SUM(cache_read_tokens), 0)::BIGINT + COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS total_tokens,
      COALESCE(SUM(effective_input_cost), 0)::NUMERIC AS input_cost, COALESCE(SUM(effective_output_cost), 0)::NUMERIC AS output_cost,
      COALESCE(SUM(effective_reasoning_cost), 0)::NUMERIC AS reasoning_cost, COALESCE(SUM(effective_cache_read_cost), 0)::NUMERIC AS cache_read_cost,
      COALESCE(SUM(effective_cache_write_cost), 0)::NUMERIC AS cache_write_cost, COALESCE(SUM(effective_unallocated_cost), 0)::NUMERIC AS unallocated_cost,
      COALESCE(SUM(effective_total_cost), 0)::NUMERIC AS total_cost,
      COUNT(*)::BIGINT AS call_count, COUNT(DISTINCT session_id)::BIGINT AS session_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage)::BIGINT AS eligible_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'reported')::BIGINT AS reported_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'estimated')::BIGINT AS estimated_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'zero_rate')::BIGINT AS zero_rate_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'legacy')::BIGINT AS legacy_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'unpriced')::BIGINT AS unpriced_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_breakdown_status = 'invalid')::BIGINT AS breakdown_invalid_count
    FROM public.tokend_effective_usage_events
    WHERE member_code = v_code AND channel = p_channel AND timestamp_ms >= v_from_ms
      AND COALESCE(channel, '') NOT IN ('', 'unknown') AND NOT (channel = 'cron' AND COALESCE(session_key, '') = '')
  ), envelope AS (
    SELECT aggregate.*,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count + legacy_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS cost_availability,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS verified_cost_coverage,
      CASE WHEN eligible_event_count = 0 THEN 'no_usage' WHEN unpriced_event_count = eligible_event_count THEN 'unpriced' WHEN zero_rate_event_count = eligible_event_count THEN 'zero_rate' WHEN unpriced_event_count > 0 AND unpriced_event_count < eligible_event_count THEN 'partial' WHEN unpriced_event_count = 0 AND legacy_event_count > 0 THEN 'legacy' ELSE 'complete' END AS coverage_status
    FROM aggregate
  ) SELECT * INTO v_summary FROM envelope;
  v_envelope := jsonb_build_object(
    'inputTokens', v_summary.input_tokens, 'outputTokens', v_summary.output_tokens,
    'reasoningTokens', v_summary.reasoning_tokens, 'cacheReadTokens', v_summary.cache_read_tokens,
    'cacheWriteTokens', v_summary.cache_write_tokens, 'totalTokens', v_summary.total_tokens,
    'inputCost', v_summary.input_cost, 'outputCost', v_summary.output_cost,
    'reasoningCost', v_summary.reasoning_cost, 'cacheReadCost', v_summary.cache_read_cost,
    'cacheWriteCost', v_summary.cache_write_cost, 'unallocatedCost', v_summary.unallocated_cost,
    'totalCost', v_summary.total_cost, 'eligibleEventCount', v_summary.eligible_event_count,
    'reportedEventCount', v_summary.reported_event_count, 'estimatedEventCount', v_summary.estimated_event_count,
    'zeroRateEventCount', v_summary.zero_rate_event_count, 'legacyEventCount', v_summary.legacy_event_count,
    'unpricedEventCount', v_summary.unpriced_event_count, 'breakdownInvalidCount', v_summary.breakdown_invalid_count,
    'costAvailability', v_summary.cost_availability, 'verifiedCostCoverage', v_summary.verified_cost_coverage,
    'coverageStatus', v_summary.coverage_status, 'costDetailsAvailable', true
  );

  WITH source AS (
    SELECT *, TO_CHAR(timezone(v_timezone, TO_TIMESTAMP(timestamp_ms / 1000.0)), CASE WHEN p_period = '1d' THEN 'YYYY-MM-DD HH24:00' ELSE 'YYYY-MM-DD' END) AS bucket
    FROM public.tokend_effective_usage_events
    WHERE member_code = v_code AND channel = p_channel AND timestamp_ms >= v_from_ms
      AND COALESCE(channel, '') NOT IN ('', 'unknown') AND NOT (channel = 'cron' AND COALESCE(session_key, '') = '')
  ), aggregate AS (
    SELECT bucket,
      COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens, COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::BIGINT AS reasoning_tokens, COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS cache_write_tokens,
      COALESCE(SUM(input_tokens), 0)::BIGINT + COALESCE(SUM(output_tokens), 0)::BIGINT + COALESCE(SUM(reasoning_tokens), 0)::BIGINT + COALESCE(SUM(cache_read_tokens), 0)::BIGINT + COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS total_tokens,
      COALESCE(SUM(effective_input_cost), 0)::NUMERIC AS input_cost, COALESCE(SUM(effective_output_cost), 0)::NUMERIC AS output_cost,
      COALESCE(SUM(effective_reasoning_cost), 0)::NUMERIC AS reasoning_cost, COALESCE(SUM(effective_cache_read_cost), 0)::NUMERIC AS cache_read_cost,
      COALESCE(SUM(effective_cache_write_cost), 0)::NUMERIC AS cache_write_cost, COALESCE(SUM(effective_unallocated_cost), 0)::NUMERIC AS unallocated_cost,
      COALESCE(SUM(effective_total_cost), 0)::NUMERIC AS total_cost,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage)::BIGINT AS eligible_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'reported')::BIGINT AS reported_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'estimated')::BIGINT AS estimated_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'zero_rate')::BIGINT AS zero_rate_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'legacy')::BIGINT AS legacy_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'unpriced')::BIGINT AS unpriced_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_breakdown_status = 'invalid')::BIGINT AS breakdown_invalid_count
    FROM source GROUP BY bucket
  ), envelope AS (
    SELECT aggregate.*,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count + legacy_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS cost_availability,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS verified_cost_coverage,
      CASE WHEN eligible_event_count = 0 THEN 'no_usage' WHEN unpriced_event_count = eligible_event_count THEN 'unpriced' WHEN zero_rate_event_count = eligible_event_count THEN 'zero_rate' WHEN unpriced_event_count > 0 AND unpriced_event_count < eligible_event_count THEN 'partial' WHEN unpriced_event_count = 0 AND legacy_event_count > 0 THEN 'legacy' ELSE 'complete' END AS coverage_status
    FROM aggregate
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'day', bucket, 'tokens', total_tokens, 'cost', total_cost,
    'inputTokens', input_tokens, 'outputTokens', output_tokens, 'reasoningTokens', reasoning_tokens,
    'cacheReadTokens', cache_read_tokens, 'cacheWriteTokens', cache_write_tokens, 'totalTokens', total_tokens,
    'inputCost', input_cost, 'outputCost', output_cost, 'reasoningCost', reasoning_cost,
    'cacheReadCost', cache_read_cost, 'cacheWriteCost', cache_write_cost, 'unallocatedCost', unallocated_cost, 'totalCost', total_cost,
    'eligibleEventCount', eligible_event_count, 'reportedEventCount', reported_event_count, 'estimatedEventCount', estimated_event_count,
    'zeroRateEventCount', zero_rate_event_count, 'legacyEventCount', legacy_event_count, 'unpricedEventCount', unpriced_event_count,
    'breakdownInvalidCount', breakdown_invalid_count, 'costAvailability', cost_availability,
    'verifiedCostCoverage', verified_cost_coverage, 'coverageStatus', coverage_status, 'costDetailsAvailable', true
  ) ORDER BY bucket), '[]'::JSONB) INTO v_trend FROM envelope;

  WITH aggregate AS (
    SELECT model, MAX(provider) AS provider,
      COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens, COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::BIGINT AS reasoning_tokens, COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS cache_write_tokens,
      COALESCE(SUM(input_tokens), 0)::BIGINT + COALESCE(SUM(output_tokens), 0)::BIGINT + COALESCE(SUM(reasoning_tokens), 0)::BIGINT + COALESCE(SUM(cache_read_tokens), 0)::BIGINT + COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS total_tokens,
      COALESCE(SUM(effective_input_cost), 0)::NUMERIC AS input_cost, COALESCE(SUM(effective_output_cost), 0)::NUMERIC AS output_cost,
      COALESCE(SUM(effective_reasoning_cost), 0)::NUMERIC AS reasoning_cost, COALESCE(SUM(effective_cache_read_cost), 0)::NUMERIC AS cache_read_cost,
      COALESCE(SUM(effective_cache_write_cost), 0)::NUMERIC AS cache_write_cost, COALESCE(SUM(effective_unallocated_cost), 0)::NUMERIC AS unallocated_cost,
      COALESCE(SUM(effective_total_cost), 0)::NUMERIC AS total_cost, COUNT(*)::BIGINT AS call_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage)::BIGINT AS eligible_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'reported')::BIGINT AS reported_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'estimated')::BIGINT AS estimated_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'zero_rate')::BIGINT AS zero_rate_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'legacy')::BIGINT AS legacy_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'unpriced')::BIGINT AS unpriced_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_breakdown_status = 'invalid')::BIGINT AS breakdown_invalid_count
    FROM public.tokend_effective_usage_events
    WHERE member_code = v_code AND channel = p_channel AND timestamp_ms >= v_from_ms
      AND COALESCE(channel, '') NOT IN ('', 'unknown') AND NOT (channel = 'cron' AND COALESCE(session_key, '') = '')
    GROUP BY model
  ), envelope AS (
    SELECT aggregate.*,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count + legacy_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS cost_availability,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS verified_cost_coverage,
      CASE WHEN eligible_event_count = 0 THEN 'no_usage' WHEN unpriced_event_count = eligible_event_count THEN 'unpriced' WHEN zero_rate_event_count = eligible_event_count THEN 'zero_rate' WHEN unpriced_event_count > 0 AND unpriced_event_count < eligible_event_count THEN 'partial' WHEN unpriced_event_count = 0 AND legacy_event_count > 0 THEN 'legacy' ELSE 'complete' END AS coverage_status
    FROM aggregate
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'model', model, 'provider', provider, 'calls', call_count, 'tokens', total_tokens, 'cost', total_cost,
    'inputTokens', input_tokens, 'outputTokens', output_tokens, 'reasoningTokens', reasoning_tokens,
    'cacheReadTokens', cache_read_tokens, 'cacheWriteTokens', cache_write_tokens, 'totalTokens', total_tokens,
    'inputCost', input_cost, 'outputCost', output_cost, 'reasoningCost', reasoning_cost,
    'cacheReadCost', cache_read_cost, 'cacheWriteCost', cache_write_cost, 'unallocatedCost', unallocated_cost, 'totalCost', total_cost,
    'eligibleEventCount', eligible_event_count, 'reportedEventCount', reported_event_count, 'estimatedEventCount', estimated_event_count,
    'zeroRateEventCount', zero_rate_event_count, 'legacyEventCount', legacy_event_count, 'unpricedEventCount', unpriced_event_count,
    'breakdownInvalidCount', breakdown_invalid_count, 'costAvailability', cost_availability,
    'verifiedCostCoverage', verified_cost_coverage, 'coverageStatus', coverage_status, 'costDetailsAvailable', true
  ) ORDER BY total_tokens DESC, model), '[]'::JSONB) INTO v_mix FROM envelope;

  WITH aggregate AS (
    SELECT session_id,
      (ARRAY_AGG(agent ORDER BY timestamp_ms DESC, id DESC) FILTER (WHERE NULLIF(agent, '') IS NOT NULL))[1] AS agent,
      (ARRAY_AGG(project ORDER BY timestamp_ms DESC, id DESC) FILTER (WHERE NULLIF(project, '') IS NOT NULL))[1] AS project,
      (ARRAY_AGG(model ORDER BY timestamp_ms DESC, id DESC) FILTER (WHERE NULLIF(model, '') IS NOT NULL))[1] AS current_model,
      MIN(timestamp_ms)::BIGINT AS first_seen_at, MAX(timestamp_ms)::BIGINT AS last_seen_at,
      COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens, COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::BIGINT AS reasoning_tokens, COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS cache_write_tokens,
      COALESCE(SUM(input_tokens), 0)::BIGINT + COALESCE(SUM(output_tokens), 0)::BIGINT + COALESCE(SUM(reasoning_tokens), 0)::BIGINT + COALESCE(SUM(cache_read_tokens), 0)::BIGINT + COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS total_tokens,
      COALESCE(SUM(effective_input_cost), 0)::NUMERIC AS input_cost, COALESCE(SUM(effective_output_cost), 0)::NUMERIC AS output_cost,
      COALESCE(SUM(effective_reasoning_cost), 0)::NUMERIC AS reasoning_cost, COALESCE(SUM(effective_cache_read_cost), 0)::NUMERIC AS cache_read_cost,
      COALESCE(SUM(effective_cache_write_cost), 0)::NUMERIC AS cache_write_cost, COALESCE(SUM(effective_unallocated_cost), 0)::NUMERIC AS unallocated_cost,
      COALESCE(SUM(effective_total_cost), 0)::NUMERIC AS total_cost, COUNT(*)::BIGINT AS call_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage)::BIGINT AS eligible_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'reported')::BIGINT AS reported_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'estimated')::BIGINT AS estimated_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'zero_rate')::BIGINT AS zero_rate_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'legacy')::BIGINT AS legacy_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'unpriced')::BIGINT AS unpriced_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_breakdown_status = 'invalid')::BIGINT AS breakdown_invalid_count
    FROM public.tokend_effective_usage_events
    WHERE member_code = v_code AND channel = p_channel AND timestamp_ms >= v_from_ms
      AND COALESCE(channel, '') NOT IN ('', 'unknown') AND NOT (channel = 'cron' AND COALESCE(session_key, '') = '')
    GROUP BY session_id
  ), envelope AS (
    SELECT aggregate.*,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count + legacy_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS cost_availability,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS verified_cost_coverage,
      CASE WHEN eligible_event_count = 0 THEN 'no_usage' WHEN unpriced_event_count = eligible_event_count THEN 'unpriced' WHEN zero_rate_event_count = eligible_event_count THEN 'zero_rate' WHEN unpriced_event_count > 0 AND unpriced_event_count < eligible_event_count THEN 'partial' WHEN unpriced_event_count = 0 AND legacy_event_count > 0 THEN 'legacy' ELSE 'complete' END AS coverage_status
    FROM aggregate
  ), limited AS (SELECT * FROM envelope ORDER BY total_tokens DESC, session_id LIMIT 20)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'sessionId', session_id, 'agent', agent, 'title', COALESCE(NULLIF(project, ''), NULLIF(agent, ''), LEFT(session_id, 8)),
    'channel', p_channel, 'currentModel', current_model, 'firstSeenAt', first_seen_at,
    'lastSeenAt', last_seen_at, 'callCount', call_count, 'tokens', total_tokens, 'cost', total_cost,
    'inputTokens', input_tokens, 'outputTokens', output_tokens, 'reasoningTokens', reasoning_tokens,
    'cacheReadTokens', cache_read_tokens, 'cacheWriteTokens', cache_write_tokens, 'totalTokens', total_tokens,
    'inputCost', input_cost, 'outputCost', output_cost, 'reasoningCost', reasoning_cost,
    'cacheReadCost', cache_read_cost, 'cacheWriteCost', cache_write_cost, 'unallocatedCost', unallocated_cost, 'totalCost', total_cost,
    'eligibleEventCount', eligible_event_count, 'reportedEventCount', reported_event_count, 'estimatedEventCount', estimated_event_count,
    'zeroRateEventCount', zero_rate_event_count, 'legacyEventCount', legacy_event_count, 'unpricedEventCount', unpriced_event_count,
    'breakdownInvalidCount', breakdown_invalid_count, 'costAvailability', cost_availability,
    'verifiedCostCoverage', verified_cost_coverage, 'coverageStatus', coverage_status, 'costDetailsAvailable', true
  ) ORDER BY total_tokens DESC, session_id), '[]'::JSONB) INTO v_sessions FROM limited;

  RETURN (jsonb_build_object(
    'ok', true, 'channel', p_channel, 'callCount', v_summary.call_count, 'sessionCount', v_summary.session_count,
    'summary', v_envelope || jsonb_build_object('channel', p_channel, 'callCount', v_summary.call_count, 'sessionCount', v_summary.session_count),
    'dailyTrend', v_trend, 'modelMix', v_mix, 'topSessions', v_sessions
  ) || v_envelope)::JSON;
END
$function$;


CREATE OR REPLACE FUNCTION public.tokend_get_sessions_v2(
  p_token TEXT,
  p_period TEXT DEFAULT '7d',
  p_limit INTEGER DEFAULT 50
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_code TEXT;
  v_from_ms BIGINT;
  v_rows JSONB;
BEGIN
  SELECT member_code INTO v_code FROM public.tokend_members WHERE token = p_token LIMIT 1;
  IF NOT FOUND THEN RETURN json_build_object('ok', false, 'error', 'invalid_token'); END IF;
  IF p_period = '30d' THEN
    v_from_ms := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone('Asia/Shanghai', now())) - INTERVAL '29 days') AT TIME ZONE 'Asia/Shanghai')) * 1000)::BIGINT;
  ELSIF p_period = '1d' THEN v_from_ms := (EXTRACT(EPOCH FROM (now() - INTERVAL '24 hours')) * 1000)::BIGINT;
  ELSE v_from_ms := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone('Asia/Shanghai', now())) - INTERVAL '6 days') AT TIME ZONE 'Asia/Shanghai')) * 1000)::BIGINT;
  END IF;
  WITH selected_sessions AS (
    SELECT DISTINCT session_id
    FROM public.tokend_effective_usage_events
    WHERE member_code = v_code AND timestamp_ms >= v_from_ms
      AND COALESCE(channel, '') NOT IN ('', 'unknown') AND NOT (channel = 'cron' AND COALESCE(session_key, '') = '')
  ), source AS (
    SELECT * FROM public.tokend_effective_usage_events
    WHERE member_code = v_code
      AND session_id IN (SELECT session_id FROM selected_sessions)
      AND COALESCE(channel, '') NOT IN ('', 'unknown') AND NOT (channel = 'cron' AND COALESCE(session_key, '') = '')
  ), aggregate AS (
    SELECT session_id,
      (ARRAY_AGG(session_key ORDER BY timestamp_ms DESC, id DESC) FILTER (WHERE NULLIF(session_key, '') IS NOT NULL))[1] AS session_key,
      (ARRAY_AGG(agent ORDER BY timestamp_ms DESC, id DESC) FILTER (WHERE NULLIF(agent, '') IS NOT NULL))[1] AS agent,
      (ARRAY_AGG(project ORDER BY timestamp_ms DESC, id DESC) FILTER (WHERE NULLIF(project, '') IS NOT NULL))[1] AS project,
      (ARRAY_AGG(channel ORDER BY timestamp_ms DESC, id DESC) FILTER (WHERE NULLIF(channel, '') IS NOT NULL))[1] AS channel,
      (ARRAY_AGG(model ORDER BY timestamp_ms DESC, id DESC) FILTER (WHERE NULLIF(model, '') IS NOT NULL))[1] AS current_model,
      MIN(timestamp_ms)::BIGINT AS first_seen_at, MAX(timestamp_ms)::BIGINT AS last_seen_at,
      COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens, COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::BIGINT AS reasoning_tokens, COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS cache_write_tokens,
      COALESCE(SUM(input_tokens), 0)::BIGINT + COALESCE(SUM(output_tokens), 0)::BIGINT + COALESCE(SUM(reasoning_tokens), 0)::BIGINT + COALESCE(SUM(cache_read_tokens), 0)::BIGINT + COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS total_tokens,
      COALESCE(SUM(effective_input_cost), 0)::NUMERIC AS input_cost, COALESCE(SUM(effective_output_cost), 0)::NUMERIC AS output_cost,
      COALESCE(SUM(effective_reasoning_cost), 0)::NUMERIC AS reasoning_cost, COALESCE(SUM(effective_cache_read_cost), 0)::NUMERIC AS cache_read_cost,
      COALESCE(SUM(effective_cache_write_cost), 0)::NUMERIC AS cache_write_cost, COALESCE(SUM(effective_unallocated_cost), 0)::NUMERIC AS unallocated_cost,
      COALESCE(SUM(effective_total_cost), 0)::NUMERIC AS total_cost, COUNT(*)::BIGINT AS call_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage)::BIGINT AS eligible_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'reported')::BIGINT AS reported_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'estimated')::BIGINT AS estimated_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'zero_rate')::BIGINT AS zero_rate_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'legacy')::BIGINT AS legacy_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'unpriced')::BIGINT AS unpriced_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_breakdown_status = 'invalid')::BIGINT AS breakdown_invalid_count
    FROM source GROUP BY session_id
  ), envelope AS (
    SELECT aggregate.*,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count + legacy_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS cost_availability,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS verified_cost_coverage,
      CASE WHEN eligible_event_count = 0 THEN 'no_usage' WHEN unpriced_event_count = eligible_event_count THEN 'unpriced' WHEN zero_rate_event_count = eligible_event_count THEN 'zero_rate' WHEN unpriced_event_count > 0 AND unpriced_event_count < eligible_event_count THEN 'partial' WHEN unpriced_event_count = 0 AND legacy_event_count > 0 THEN 'legacy' ELSE 'complete' END AS coverage_status
    FROM aggregate
  ), limited AS (SELECT * FROM envelope ORDER BY last_seen_at DESC, session_id LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 0), 200))
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'sessionId', session_id, 'sessionKey', session_key, 'agent', agent,
    'title', COALESCE(NULLIF(project, ''), NULLIF(agent, ''), LEFT(session_id, 8)),
    'channel', channel, 'firstSeenAt', first_seen_at, 'lastSeenAt', last_seen_at,
    'currentModel', current_model, 'callCount', call_count, 'tokens', total_tokens, 'cost', total_cost,
    'inputTokens', input_tokens, 'outputTokens', output_tokens, 'reasoningTokens', reasoning_tokens,
    'cacheReadTokens', cache_read_tokens, 'cacheWriteTokens', cache_write_tokens, 'totalTokens', total_tokens,
    'inputCost', input_cost, 'outputCost', output_cost, 'reasoningCost', reasoning_cost,
    'cacheReadCost', cache_read_cost, 'cacheWriteCost', cache_write_cost, 'unallocatedCost', unallocated_cost,
    'totalCost', total_cost, 'eligibleEventCount', eligible_event_count, 'reportedEventCount', reported_event_count,
    'estimatedEventCount', estimated_event_count, 'zeroRateEventCount', zero_rate_event_count,
    'legacyEventCount', legacy_event_count, 'unpricedEventCount', unpriced_event_count,
    'breakdownInvalidCount', breakdown_invalid_count, 'costAvailability', cost_availability,
    'verifiedCostCoverage', verified_cost_coverage, 'coverageStatus', coverage_status,
    'costDetailsAvailable', true
  ) ORDER BY last_seen_at DESC, session_id), '[]'::JSONB) INTO v_rows FROM limited;
  RETURN json_build_object('ok', true, 'sessions', v_rows);
END
$function$;

CREATE OR REPLACE FUNCTION public.tokend_get_top_projects_v3(
  p_token TEXT,
  p_period TEXT DEFAULT '7d'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_code TEXT;
  v_from_ms BIGINT;
  v_rows JSONB;
BEGIN
  SELECT member_code INTO v_code FROM public.tokend_members WHERE token = p_token LIMIT 1;
  IF NOT FOUND THEN RETURN json_build_object('ok', false, 'error', 'invalid_token'); END IF;
  IF p_period = '30d' THEN
    v_from_ms := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone('Asia/Shanghai', now())) - INTERVAL '29 days') AT TIME ZONE 'Asia/Shanghai')) * 1000)::BIGINT;
  ELSIF p_period = '1d' THEN v_from_ms := (EXTRACT(EPOCH FROM (now() - INTERVAL '24 hours')) * 1000)::BIGINT;
  ELSE v_from_ms := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone('Asia/Shanghai', now())) - INTERVAL '6 days') AT TIME ZONE 'Asia/Shanghai')) * 1000)::BIGINT;
  END IF;
  WITH source AS (
    SELECT *, COALESCE(NULLIF(TRIM(agent), ''), NULLIF(TRIM(project), '')) AS project_name
    FROM public.tokend_effective_usage_events
    WHERE member_code = v_code AND timestamp_ms >= v_from_ms
      AND COALESCE(channel, '') NOT IN ('', 'unknown') AND NOT (channel = 'cron' AND COALESCE(session_key, '') = '')
      AND COALESCE(NULLIF(TRIM(agent), ''), NULLIF(TRIM(project), '')) IS NOT NULL
      AND COALESCE(NULLIF(TRIM(agent), ''), NULLIF(TRIM(project), '')) NOT IN ('unknown', '~', '')
  ), aggregate AS (
    SELECT project_name, channel,
      COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens, COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::BIGINT AS reasoning_tokens, COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS cache_write_tokens,
      COALESCE(SUM(input_tokens), 0)::BIGINT + COALESCE(SUM(output_tokens), 0)::BIGINT + COALESCE(SUM(reasoning_tokens), 0)::BIGINT + COALESCE(SUM(cache_read_tokens), 0)::BIGINT + COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS total_tokens,
      COALESCE(SUM(effective_input_cost), 0)::NUMERIC AS input_cost, COALESCE(SUM(effective_output_cost), 0)::NUMERIC AS output_cost,
      COALESCE(SUM(effective_reasoning_cost), 0)::NUMERIC AS reasoning_cost, COALESCE(SUM(effective_cache_read_cost), 0)::NUMERIC AS cache_read_cost,
      COALESCE(SUM(effective_cache_write_cost), 0)::NUMERIC AS cache_write_cost, COALESCE(SUM(effective_unallocated_cost), 0)::NUMERIC AS unallocated_cost,
      COALESCE(SUM(effective_total_cost), 0)::NUMERIC AS total_cost, COUNT(*)::BIGINT AS call_count,
      COUNT(DISTINCT session_id)::BIGINT AS session_count, MAX(timestamp_ms)::BIGINT AS last_seen,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage)::BIGINT AS eligible_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'reported')::BIGINT AS reported_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'estimated')::BIGINT AS estimated_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'zero_rate')::BIGINT AS zero_rate_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'legacy')::BIGINT AS legacy_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'unpriced')::BIGINT AS unpriced_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_breakdown_status = 'invalid')::BIGINT AS breakdown_invalid_count
    FROM source GROUP BY project_name, channel
  ), envelope AS (
    SELECT aggregate.*,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count + legacy_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS cost_availability,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS verified_cost_coverage,
      CASE WHEN eligible_event_count = 0 THEN 'no_usage' WHEN unpriced_event_count = eligible_event_count THEN 'unpriced' WHEN zero_rate_event_count = eligible_event_count THEN 'zero_rate' WHEN unpriced_event_count > 0 AND unpriced_event_count < eligible_event_count THEN 'partial' WHEN unpriced_event_count = 0 AND legacy_event_count > 0 THEN 'legacy' ELSE 'complete' END AS coverage_status
    FROM aggregate
  ), limited AS (SELECT * FROM envelope ORDER BY total_tokens DESC, total_cost DESC, project_name, channel LIMIT 8)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'project', project_name, 'channel', channel, 'tokens', total_tokens, 'cost', total_cost,
    'calls', call_count, 'sessions', session_count, 'lastAt', last_seen,
    'inputTokens', input_tokens, 'outputTokens', output_tokens, 'reasoningTokens', reasoning_tokens,
    'cacheReadTokens', cache_read_tokens, 'cacheWriteTokens', cache_write_tokens, 'totalTokens', total_tokens,
    'inputCost', input_cost, 'outputCost', output_cost, 'reasoningCost', reasoning_cost,
    'cacheReadCost', cache_read_cost, 'cacheWriteCost', cache_write_cost, 'unallocatedCost', unallocated_cost,
    'totalCost', total_cost, 'eligibleEventCount', eligible_event_count, 'reportedEventCount', reported_event_count,
    'estimatedEventCount', estimated_event_count, 'zeroRateEventCount', zero_rate_event_count,
    'legacyEventCount', legacy_event_count, 'unpricedEventCount', unpriced_event_count,
    'breakdownInvalidCount', breakdown_invalid_count, 'costAvailability', cost_availability,
    'verifiedCostCoverage', verified_cost_coverage, 'coverageStatus', coverage_status,
    'costDetailsAvailable', true
  ) ORDER BY total_tokens DESC, total_cost DESC, project_name, channel), '[]'::JSONB) INTO v_rows FROM limited;
  RETURN json_build_object('ok', true, 'projects', v_rows);
END
$function$;

CREATE OR REPLACE FUNCTION public.tokend_get_session_detail_v2(
  p_token TEXT,
  p_session_id TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_code TEXT;
  v_summary RECORD;
  v_envelope JSONB;
  v_events JSONB;
BEGIN
  SELECT member_code INTO v_code FROM public.tokend_members WHERE token = p_token LIMIT 1;
  IF NOT FOUND THEN RETURN json_build_object('ok', false, 'error', 'invalid_token'); END IF;
  WITH aggregate AS (
    SELECT
      (ARRAY_AGG(session_key ORDER BY timestamp_ms DESC, id DESC) FILTER (WHERE NULLIF(session_key, '') IS NOT NULL))[1] AS session_key,
      (ARRAY_AGG(agent ORDER BY timestamp_ms DESC, id DESC) FILTER (WHERE NULLIF(agent, '') IS NOT NULL))[1] AS agent,
      (ARRAY_AGG(project ORDER BY timestamp_ms DESC, id DESC) FILTER (WHERE NULLIF(project, '') IS NOT NULL))[1] AS project,
      (ARRAY_AGG(channel ORDER BY timestamp_ms DESC, id DESC) FILTER (WHERE NULLIF(channel, '') IS NOT NULL))[1] AS channel,
      (ARRAY_AGG(model ORDER BY timestamp_ms DESC, id DESC) FILTER (WHERE NULLIF(model, '') IS NOT NULL))[1] AS current_model,
      MIN(timestamp_ms)::BIGINT AS first_seen_at, MAX(timestamp_ms)::BIGINT AS last_seen_at,
      COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens,
      COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::BIGINT AS reasoning_tokens,
      COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS cache_write_tokens,
      COALESCE(SUM(input_tokens), 0)::BIGINT + COALESCE(SUM(output_tokens), 0)::BIGINT + COALESCE(SUM(reasoning_tokens), 0)::BIGINT + COALESCE(SUM(cache_read_tokens), 0)::BIGINT + COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS total_tokens,
      COALESCE(SUM(effective_input_cost), 0)::NUMERIC AS input_cost,
      COALESCE(SUM(effective_output_cost), 0)::NUMERIC AS output_cost,
      COALESCE(SUM(effective_reasoning_cost), 0)::NUMERIC AS reasoning_cost,
      COALESCE(SUM(effective_cache_read_cost), 0)::NUMERIC AS cache_read_cost,
      COALESCE(SUM(effective_cache_write_cost), 0)::NUMERIC AS cache_write_cost,
      COALESCE(SUM(effective_unallocated_cost), 0)::NUMERIC AS unallocated_cost,
      COALESCE(SUM(effective_total_cost), 0)::NUMERIC AS total_cost,
      COUNT(*)::BIGINT AS call_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage)::BIGINT AS eligible_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'reported')::BIGINT AS reported_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'estimated')::BIGINT AS estimated_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'zero_rate')::BIGINT AS zero_rate_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'legacy')::BIGINT AS legacy_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'unpriced')::BIGINT AS unpriced_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_breakdown_status = 'invalid')::BIGINT AS breakdown_invalid_count
    FROM public.tokend_effective_usage_events
    WHERE member_code = v_code AND session_id = p_session_id
      AND COALESCE(channel, '') NOT IN ('', 'unknown') AND NOT (channel = 'cron' AND COALESCE(session_key, '') = '')
  ), envelope AS (
    SELECT aggregate.*,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count + legacy_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS cost_availability,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS verified_cost_coverage,
      CASE WHEN eligible_event_count = 0 THEN 'no_usage' WHEN unpriced_event_count = eligible_event_count THEN 'unpriced' WHEN zero_rate_event_count = eligible_event_count THEN 'zero_rate' WHEN unpriced_event_count > 0 AND unpriced_event_count < eligible_event_count THEN 'partial' WHEN unpriced_event_count = 0 AND legacy_event_count > 0 THEN 'legacy' ELSE 'complete' END AS coverage_status
    FROM aggregate
  ) SELECT * INTO v_summary FROM envelope;
  v_envelope := jsonb_build_object(
    'inputTokens', v_summary.input_tokens, 'outputTokens', v_summary.output_tokens,
    'reasoningTokens', v_summary.reasoning_tokens, 'cacheReadTokens', v_summary.cache_read_tokens,
    'cacheWriteTokens', v_summary.cache_write_tokens, 'totalTokens', v_summary.total_tokens,
    'inputCost', v_summary.input_cost, 'outputCost', v_summary.output_cost,
    'reasoningCost', v_summary.reasoning_cost, 'cacheReadCost', v_summary.cache_read_cost,
    'cacheWriteCost', v_summary.cache_write_cost, 'unallocatedCost', v_summary.unallocated_cost,
    'totalCost', v_summary.total_cost, 'eligibleEventCount', v_summary.eligible_event_count,
    'reportedEventCount', v_summary.reported_event_count, 'estimatedEventCount', v_summary.estimated_event_count,
    'zeroRateEventCount', v_summary.zero_rate_event_count, 'legacyEventCount', v_summary.legacy_event_count,
    'unpricedEventCount', v_summary.unpriced_event_count, 'breakdownInvalidCount', v_summary.breakdown_invalid_count,
    'costAvailability', v_summary.cost_availability, 'verifiedCostCoverage', v_summary.verified_cost_coverage,
    'coverageStatus', v_summary.coverage_status, 'costDetailsAvailable', true
  );

  WITH event_envelope AS (
    SELECT *,
      CASE WHEN eligible_for_cost_coverage THEN 1 ELSE 0 END::BIGINT AS eligible_event_count,
      CASE WHEN eligible_for_cost_coverage AND effective_pricing_status = 'reported' THEN 1 ELSE 0 END::BIGINT AS reported_event_count,
      CASE WHEN eligible_for_cost_coverage AND effective_pricing_status = 'estimated' THEN 1 ELSE 0 END::BIGINT AS estimated_event_count,
      CASE WHEN eligible_for_cost_coverage AND effective_pricing_status = 'zero_rate' THEN 1 ELSE 0 END::BIGINT AS zero_rate_event_count,
      CASE WHEN eligible_for_cost_coverage AND effective_pricing_status = 'legacy' THEN 1 ELSE 0 END::BIGINT AS legacy_event_count,
      CASE WHEN eligible_for_cost_coverage AND effective_pricing_status = 'unpriced' THEN 1 ELSE 0 END::BIGINT AS unpriced_event_count,
      CASE WHEN eligible_for_cost_coverage AND effective_breakdown_status = 'invalid' THEN 1 ELSE 0 END::BIGINT AS breakdown_invalid_count
    FROM public.tokend_effective_usage_events
    WHERE member_code = v_code AND session_id = p_session_id
      AND COALESCE(channel, '') NOT IN ('', 'unknown') AND NOT (channel = 'cron' AND COALESCE(session_key, '') = '')
  ), enriched AS (
    SELECT event_envelope.*,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count + legacy_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS cost_availability,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS verified_cost_coverage,
      CASE WHEN eligible_event_count = 0 THEN 'no_usage' WHEN unpriced_event_count = eligible_event_count THEN 'unpriced' WHEN zero_rate_event_count = eligible_event_count THEN 'zero_rate' WHEN unpriced_event_count > 0 AND unpriced_event_count < eligible_event_count THEN 'partial' WHEN unpriced_event_count = 0 AND legacy_event_count > 0 THEN 'legacy' ELSE 'complete' END AS coverage_status
    FROM event_envelope
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id, 'timestampMs', timestamp_ms, 'model', model, 'stopReason', stop_reason,
    'pricingStatus', effective_pricing_status, 'pricingTier', effective_pricing_tier,
    'catalogVersion', effective_catalog_version, 'breakdownStatus', effective_breakdown_status,
    'inputTokens', input_tokens, 'outputTokens', output_tokens, 'reasoningTokens', reasoning_tokens,
    'cacheReadTokens', cache_read_tokens, 'cacheWriteTokens', cache_write_tokens,
    'totalTokens', COALESCE(input_tokens, 0)::BIGINT
      + COALESCE(output_tokens, 0)::BIGINT
      + COALESCE(reasoning_tokens, 0)::BIGINT
      + COALESCE(cache_read_tokens, 0)::BIGINT
      + COALESCE(cache_write_tokens, 0)::BIGINT,
    'inputCost', effective_input_cost, 'outputCost', effective_output_cost,
    'reasoningCost', effective_reasoning_cost, 'cacheReadCost', effective_cache_read_cost,
    'cacheWriteCost', effective_cache_write_cost, 'unallocatedCost', effective_unallocated_cost,
    'totalCost', effective_total_cost, 'eligibleEventCount', eligible_event_count,
    'reportedEventCount', reported_event_count, 'estimatedEventCount', estimated_event_count,
    'zeroRateEventCount', zero_rate_event_count, 'legacyEventCount', legacy_event_count,
    'unpricedEventCount', unpriced_event_count, 'breakdownInvalidCount', breakdown_invalid_count,
    'costAvailability', cost_availability, 'verifiedCostCoverage', verified_cost_coverage,
    'coverageStatus', coverage_status, 'costDetailsAvailable', true
  ) ORDER BY timestamp_ms, id), '[]'::JSONB) INTO v_events FROM enriched;

  RETURN (jsonb_build_object(
    'ok', true, 'sessionId', p_session_id, 'sessionKey', v_summary.session_key,
    'agent', v_summary.agent, 'title', COALESCE(NULLIF(v_summary.project, ''), NULLIF(v_summary.agent, ''), LEFT(p_session_id, 8)),
    'channel', v_summary.channel, 'currentModel', v_summary.current_model,
    'firstSeenAt', v_summary.first_seen_at, 'lastSeenAt', v_summary.last_seen_at,
    'callCount', v_summary.call_count,
    'session', v_envelope || jsonb_build_object(
      'sessionId', p_session_id, 'sessionKey', v_summary.session_key, 'agent', v_summary.agent,
      'title', COALESCE(NULLIF(v_summary.project, ''), NULLIF(v_summary.agent, ''), LEFT(p_session_id, 8)),
      'channel', v_summary.channel, 'currentModel', v_summary.current_model,
      'firstSeenAt', v_summary.first_seen_at, 'lastSeenAt', v_summary.last_seen_at,
      'callCount', v_summary.call_count
    ), 'events', v_events
  ) || v_envelope)::JSON;
END
$function$;

REVOKE ALL ON FUNCTION public.tokend_get_summary_v5(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_get_daily_trend_v5(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_get_model_breakdown_v3(TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_get_model_detail_v2(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_get_channel_breakdown_v4(TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_get_channel_detail_v3(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_get_sessions_v2(TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_get_session_detail_v2(TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tokend_get_top_projects_v3(TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.tokend_get_summary_v5(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tokend_get_daily_trend_v5(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tokend_get_model_breakdown_v3(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tokend_get_model_detail_v2(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tokend_get_channel_breakdown_v4(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tokend_get_channel_detail_v3(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tokend_get_sessions_v2(TEXT, TEXT, INTEGER) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tokend_get_session_detail_v2(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tokend_get_top_projects_v3(TEXT, TEXT) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
