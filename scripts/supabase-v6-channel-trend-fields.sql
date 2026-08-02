-- ============================================================
-- Tokend V6 — channel detail trend needs input/output split
-- ============================================================

CREATE OR REPLACE FUNCTION tokend_get_channel_detail(
  p_token   TEXT,
  p_channel TEXT,
  p_period  TEXT DEFAULT '7d'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code     TEXT;
  v_days     INTEGER;
  v_from_ms  BIGINT;
  v_fmt      TEXT;
  v_summary  RECORD;
  v_trend    JSONB;
  v_mix      JSONB;
  v_sessions JSONB;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  v_days := CASE p_period
    WHEN '1d'  THEN 1
    WHEN '7d'  THEN 7
    WHEN '30d' THEN 30
    ELSE 7
  END;
  v_from_ms := (EXTRACT(EPOCH FROM (now() - (v_days || ' days')::INTERVAL)) * 1000)::BIGINT;
  v_fmt := CASE WHEN p_period = '1d' THEN 'YYYY-MM-DD HH24:00' ELSE 'YYYY-MM-DD' END;

  -- summary
  SELECT
    SUM(total_tokens)::BIGINT                AS total_tokens,
    SUM(total_cost)::REAL                    AS total_cost,
    COUNT(*)::INTEGER                        AS call_count,
    COUNT(DISTINCT session_id)::INTEGER      AS session_count
  INTO v_summary
  FROM tokend_usage_events
  WHERE member_code = v_code
    AND channel = p_channel
    AND timestamp_ms >= v_from_ms;

  -- daily/hourly trend — with input/output split
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'day',          d.day,
      'tokens',       d.tokens,
      'cost',         d.cost,
      'inputTokens',  d.input_tokens,
      'outputTokens', d.output_tokens,
      'inputCost',    d.input_cost,
      'outputCost',   d.output_cost
    )
    ORDER BY d.day
  ), '[]'::jsonb)
  INTO v_trend
  FROM (
    SELECT
      TO_CHAR(TO_TIMESTAMP(timestamp_ms / 1000.0) AT TIME ZONE 'Asia/Shanghai', v_fmt) AS day,
      SUM(total_tokens)::BIGINT AS tokens,
      SUM(total_cost)::REAL AS cost,
      SUM(input_tokens)::BIGINT AS input_tokens,
      SUM(output_tokens)::BIGINT AS output_tokens,
      SUM(input_cost)::REAL AS input_cost,
      SUM(output_cost)::REAL AS output_cost
    FROM tokend_usage_events
    WHERE member_code = v_code AND channel = p_channel AND timestamp_ms >= v_from_ms
    GROUP BY 1
  ) d;

  -- model mix
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('model', m.model, 'calls', m.calls, 'tokens', m.tokens)
    ORDER BY m.tokens DESC
  ), '[]'::jsonb)
  INTO v_mix
  FROM (
    SELECT model, COUNT(*)::INTEGER AS calls, SUM(total_tokens)::BIGINT AS tokens
    FROM tokend_usage_events
    WHERE member_code = v_code AND channel = p_channel AND timestamp_ms >= v_from_ms
    GROUP BY model
  ) m;

  -- top sessions
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'sessionId',    s.session_id,
      'agent',        s.agent,
      'channel',      p_channel,
      'currentModel', s.current_model,
      'firstSeenAt',  s.first_seen,
      'lastSeenAt',   s.last_seen,
      'callCount',    s.calls,
      'totalTokens',  s.tokens,
      'totalCost',    s.cost
    ) ORDER BY s.tokens DESC
  ), '[]'::jsonb)
  INTO v_sessions
  FROM (
    SELECT
      session_id,
      MAX(agent) AS agent,
      MAX(model) AS current_model,
      MIN(timestamp_ms)::BIGINT AS first_seen,
      MAX(timestamp_ms)::BIGINT AS last_seen,
      COUNT(*)::INTEGER AS calls,
      SUM(total_tokens)::BIGINT AS tokens,
      SUM(total_cost)::REAL AS cost
    FROM tokend_usage_events
    WHERE member_code = v_code AND channel = p_channel AND timestamp_ms >= v_from_ms
    GROUP BY session_id
    ORDER BY tokens DESC
    LIMIT 20
  ) s;

  RETURN json_build_object(
    'ok', true,
    'summary', json_build_object(
      'channel',      p_channel,
      'totalTokens',  COALESCE(v_summary.total_tokens, 0),
      'totalCost',    COALESCE(v_summary.total_cost, 0),
      'callCount',    COALESCE(v_summary.call_count, 0),
      'sessionCount', COALESCE(v_summary.session_count, 0)
    ),
    'dailyTrend',  v_trend,
    'modelMix',    v_mix,
    'topSessions', v_sessions
  );
END;
$$;
