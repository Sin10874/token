-- Forward-only production performance repair for tokend_get_sessions_v2.
-- Session eligibility depends only on immutable base event fields, so discover
-- active session ids through the indexed base table and evaluate the
-- security-barrier effective-cost view exactly once for aggregation. The
-- bounded ARRAY becomes one InitPlan-backed index condition instead of a
-- repeated dynamic semi-join through the security barrier.

SET lock_timeout = '2s';

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
  WITH selected_sessions AS MATERIALIZED (
    SELECT session_id
    FROM public.tokend_usage_events
    WHERE member_code = v_code AND timestamp_ms >= v_from_ms
      AND COALESCE(channel, '') NOT IN ('', 'unknown') AND NOT (channel = 'cron' AND COALESCE(session_key, '') = '')
    GROUP BY session_id
    ORDER BY MAX(timestamp_ms) DESC, session_id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 0), 200)
  ), source AS (
    SELECT * FROM public.tokend_effective_usage_events
    WHERE member_code = v_code
      AND session_id = ANY(ARRAY(SELECT session_id FROM selected_sessions))
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

REVOKE ALL ON FUNCTION public.tokend_get_sessions_v2(TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tokend_get_sessions_v2(TEXT, TEXT, INTEGER) TO anon, authenticated;

RESET lock_timeout;
NOTIFY pgrst, 'reload schema';
