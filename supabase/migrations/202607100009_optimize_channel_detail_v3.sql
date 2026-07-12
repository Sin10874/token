-- Evaluate the security-barrier effective usage relation once per channel
-- detail request, aggregate all four response grains in one grouping-sets
-- pass, then persist only the compact rollups. CREATE OR REPLACE preserves the
-- existing function OID.

SET lock_timeout = '2s';

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
SET statement_timeout = '8s'
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

  DROP TABLE IF EXISTS pg_temp.tokend_channel_detail_aggregates;
  CREATE TEMP TABLE tokend_channel_detail_aggregates ON COMMIT DROP AS
  WITH source AS (
    SELECT
      effective_event.*,
      TO_CHAR(
        timezone(v_timezone, TO_TIMESTAMP(effective_event.timestamp_ms / 1000.0)),
        CASE WHEN p_period = '1d' THEN 'YYYY-MM-DD HH24:00' ELSE 'YYYY-MM-DD' END
      ) AS bucket
    FROM public.tokend_effective_usage_events AS effective_event
    WHERE effective_event.member_code = v_code
      AND effective_event.channel = p_channel
      AND effective_event.timestamp_ms >= v_from_ms
      AND COALESCE(effective_event.channel, '') NOT IN ('', 'unknown')
      AND NOT (
        effective_event.channel = 'cron'
        AND COALESCE(effective_event.session_key, '') = ''
      )
  ), aggregate AS (
    SELECT
      CASE
        WHEN GROUPING(session_id) = 0 THEN 'session'
        WHEN GROUPING(model) = 0 THEN 'model'
        WHEN GROUPING(bucket) = 0 THEN 'day'
        ELSE 'summary'
      END AS row_kind,
      bucket,
      model,
      MAX(provider) AS provider,
      session_id,
      MIN(timestamp_ms)::BIGINT AS first_seen_at,
      MAX(timestamp_ms)::BIGINT AS last_seen_at,
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
      CASE WHEN GROUPING(session_id) = 0 THEN 1::BIGINT ELSE NULL::BIGINT END AS session_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage)::BIGINT AS eligible_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'reported')::BIGINT AS reported_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'estimated')::BIGINT AS estimated_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'zero_rate')::BIGINT AS zero_rate_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'legacy')::BIGINT AS legacy_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_pricing_status = 'unpriced')::BIGINT AS unpriced_event_count,
      COUNT(*) FILTER (WHERE eligible_for_cost_coverage AND effective_breakdown_status = 'invalid')::BIGINT AS breakdown_invalid_count
    FROM source
    GROUP BY GROUPING SETS ((), (bucket), (model), (session_id))
  )
  SELECT aggregate.*,
    CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count + legacy_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS cost_availability,
    CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC, (reported_event_count + estimated_event_count + zero_rate_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS verified_cost_coverage,
    CASE WHEN eligible_event_count = 0 THEN 'no_usage' WHEN unpriced_event_count = eligible_event_count THEN 'unpriced' WHEN zero_rate_event_count = eligible_event_count THEN 'zero_rate' WHEN unpriced_event_count > 0 AND unpriced_event_count < eligible_event_count THEN 'partial' WHEN unpriced_event_count = 0 AND legacy_event_count > 0 THEN 'legacy' ELSE 'complete' END AS coverage_status
  FROM aggregate;

  UPDATE pg_temp.tokend_channel_detail_aggregates AS summary_row
  SET session_count = session_rollup.session_count
  FROM (
    SELECT count(*)::BIGINT AS session_count
    FROM pg_temp.tokend_channel_detail_aggregates
    WHERE row_kind = 'session'
  ) AS session_rollup
  WHERE summary_row.row_kind = 'summary';

  ANALYZE pg_temp.tokend_channel_detail_aggregates;

  SELECT * INTO v_summary
  FROM pg_temp.tokend_channel_detail_aggregates
  WHERE row_kind = 'summary';
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

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'day', bucket, 'tokens', total_tokens, 'cost', total_cost,
    'inputTokens', input_tokens, 'outputTokens', output_tokens, 'reasoningTokens', reasoning_tokens,
    'cacheReadTokens', cache_read_tokens, 'cacheWriteTokens', cache_write_tokens, 'totalTokens', total_tokens,
    'inputCost', input_cost, 'outputCost', output_cost, 'reasoningCost', reasoning_cost,
    'cacheReadCost', cache_read_cost, 'cacheWriteCost', cache_write_cost, 'unallocatedCost', unallocated_cost, 'totalCost', total_cost,
    'eligibleEventCount', eligible_event_count, 'reportedEventCount', reported_event_count, 'estimatedEventCount', estimated_event_count,
    'zeroRateEventCount', zero_rate_event_count, 'legacyEventCount', legacy_event_count, 'unpricedEventCount', unpriced_event_count,
    'breakdownInvalidCount', breakdown_invalid_count, 'costAvailability', cost_availability,
    'verifiedCostCoverage', verified_cost_coverage, 'coverageStatus', coverage_status, 'costDetailsAvailable', true
  ) ORDER BY bucket), '[]'::JSONB) INTO v_trend
  FROM pg_temp.tokend_channel_detail_aggregates
  WHERE row_kind = 'day';

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'model', model, 'provider', provider, 'calls', call_count, 'tokens', total_tokens, 'cost', total_cost,
    'inputTokens', input_tokens, 'outputTokens', output_tokens, 'reasoningTokens', reasoning_tokens,
    'cacheReadTokens', cache_read_tokens, 'cacheWriteTokens', cache_write_tokens, 'totalTokens', total_tokens,
    'inputCost', input_cost, 'outputCost', output_cost, 'reasoningCost', reasoning_cost,
    'cacheReadCost', cache_read_cost, 'cacheWriteCost', cache_write_cost, 'unallocatedCost', unallocated_cost, 'totalCost', total_cost,
    'eligibleEventCount', eligible_event_count, 'reportedEventCount', reported_event_count, 'estimatedEventCount', estimated_event_count,
    'zeroRateEventCount', zero_rate_event_count, 'legacyEventCount', legacy_event_count, 'unpricedEventCount', unpriced_event_count,
    'breakdownInvalidCount', breakdown_invalid_count, 'costAvailability', cost_availability,
    'verifiedCostCoverage', verified_cost_coverage, 'coverageStatus', coverage_status, 'costDetailsAvailable', true
  ) ORDER BY total_tokens DESC, model), '[]'::JSONB) INTO v_mix
  FROM pg_temp.tokend_channel_detail_aggregates
  WHERE row_kind = 'model';

  WITH limited AS (
    SELECT *
    FROM pg_temp.tokend_channel_detail_aggregates
    WHERE row_kind = 'session'
    ORDER BY total_tokens DESC, session_id
    LIMIT 20
  ), metadata AS (
    SELECT
      usage_event.session_id,
      (ARRAY_AGG(usage_event.agent ORDER BY usage_event.timestamp_ms DESC, usage_event.id DESC)
        FILTER (WHERE NULLIF(usage_event.agent, '') IS NOT NULL))[1] AS agent,
      (ARRAY_AGG(usage_event.project ORDER BY usage_event.timestamp_ms DESC, usage_event.id DESC)
        FILTER (WHERE NULLIF(usage_event.project, '') IS NOT NULL))[1] AS project,
      (ARRAY_AGG(usage_event.model ORDER BY usage_event.timestamp_ms DESC, usage_event.id DESC)
        FILTER (WHERE NULLIF(usage_event.model, '') IS NOT NULL))[1] AS current_model
    FROM public.tokend_usage_events AS usage_event
    WHERE usage_event.member_code = v_code
      AND usage_event.channel = p_channel
      AND usage_event.timestamp_ms >= v_from_ms
      AND usage_event.session_id IN (SELECT session_id FROM limited)
    GROUP BY usage_event.session_id
  )
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
  ) ORDER BY total_tokens DESC, session_id), '[]'::JSONB) INTO v_sessions
  FROM limited
  LEFT JOIN metadata USING (session_id);

  RETURN (jsonb_build_object(
    'ok', true, 'channel', p_channel, 'callCount', v_summary.call_count, 'sessionCount', v_summary.session_count,
    'summary', v_envelope || jsonb_build_object('channel', p_channel, 'callCount', v_summary.call_count, 'sessionCount', v_summary.session_count),
    'dailyTrend', v_trend, 'modelMix', v_mix, 'topSessions', v_sessions
  ) || v_envelope)::JSON;
END
$function$;

REVOKE ALL ON FUNCTION public.tokend_get_channel_detail_v3(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tokend_get_channel_detail_v3(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

RESET lock_timeout;
NOTIFY pgrst, 'reload schema';
