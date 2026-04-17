-- Hermes rollout validation
-- Replace YOUR_TOKEN_HERE before running.

WITH target AS (
  SELECT 'YOUR_TOKEN_HERE'::TEXT AS token
)
SELECT proname
FROM pg_proc
WHERE proname IN (
  'tokend_get_hermes_session_totals',
  'tokend_rebuild_sessions'
)
ORDER BY proname;

WITH target AS (
  SELECT 'YOUR_TOKEN_HERE'::TEXT AS token
)
SELECT tokend_get_hermes_session_totals(
  (SELECT token FROM target),
  ARRAY['20260415_091635_14970634']
) AS hermes_remote_totals;

WITH target AS (
  SELECT 'YOUR_TOKEN_HERE'::TEXT AS token
),
member AS (
  SELECT member_code
  FROM tokend_members
  WHERE token = (SELECT token FROM target)
)
SELECT
  channel,
  COUNT(DISTINCT session_id) AS sessions,
  COALESCE(SUM(input_tokens), 0)::BIGINT      AS input_tokens,
  COALESCE(SUM(output_tokens), 0)::BIGINT     AS output_tokens,
  COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
  (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0))::BIGINT AS active_tokens,
  (COALESCE(SUM(input_cost), 0) + COALESCE(SUM(output_cost), 0) + COALESCE(SUM(cache_read_cost), 0))::REAL AS estimated_cost
FROM tokend_usage_events
WHERE member_code = (SELECT member_code FROM member)
  AND channel = 'hermes'
  AND timestamp_ms >= (EXTRACT(EPOCH FROM (NOW() - INTERVAL '7 day')) * 1000)::BIGINT
GROUP BY channel;

WITH target AS (
  SELECT 'YOUR_TOKEN_HERE'::TEXT AS token
),
member AS (
  SELECT member_code
  FROM tokend_members
  WHERE token = (SELECT token FROM target)
)
SELECT
  session_id,
  title,
  agent,
  channel,
  current_model,
  total_tokens,
  total_cost,
  last_seen_at
FROM tokend_sessions
WHERE member_code = (SELECT member_code FROM member)
  AND channel = 'hermes'
ORDER BY last_seen_at DESC
LIMIT 10;
