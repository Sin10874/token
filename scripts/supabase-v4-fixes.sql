-- ============================================================
-- Tokend V4 — hourly 1d trends + missing platform metrics
-- Run in Supabase SQL Editor
-- ============================================================

-- 1. tokend_get_daily_trend_v2 — hourly for 1d, daily for 7d/30d
CREATE OR REPLACE FUNCTION tokend_get_daily_trend_v2(
  p_token  TEXT,
  p_period TEXT DEFAULT '7d'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code    TEXT;
  v_days    INTEGER;
  v_from_ms BIGINT;
  v_rows    JSONB;
  v_fmt     TEXT;
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

  -- Hourly for 1d, daily for 7d/30d
  v_fmt := CASE WHEN p_period = '1d' THEN 'YYYY-MM-DD HH24:00' ELSE 'YYYY-MM-DD' END;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'day',          d.day,
      'tokens',       d.tokens,
      'cost',         d.cost,
      'calls',        d.calls,
      'sessions',     d.sessions,
      'inputTokens',  d.input_tokens,
      'outputTokens', d.output_tokens,
      'inputCost',    d.input_cost,
      'outputCost',   d.output_cost
    ) ORDER BY d.day
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      TO_CHAR(
        TO_TIMESTAMP(timestamp_ms / 1000.0) AT TIME ZONE 'Asia/Shanghai',
        v_fmt
      )                                        AS day,
      SUM(total_tokens)::BIGINT                AS tokens,
      SUM(total_cost)::REAL                    AS cost,
      COUNT(*)::INTEGER                        AS calls,
      COUNT(DISTINCT session_id)::INTEGER      AS sessions,
      SUM(input_tokens)::BIGINT                AS input_tokens,
      SUM(output_tokens)::BIGINT               AS output_tokens,
      SUM(input_cost)::REAL                    AS input_cost,
      SUM(output_cost)::REAL                   AS output_cost
    FROM tokend_usage_events
    WHERE member_code = v_code
      AND timestamp_ms >= v_from_ms
    GROUP BY 1
  ) d;

  RETURN json_build_object('ok', true, 'days', v_rows);
END;
$$;

-- 2. tokend_get_channel_detail — hourly for 1d
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

  -- daily/hourly trend
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('day', d.day, 'tokens', d.tokens, 'cost', d.cost)
    ORDER BY d.day
  ), '[]'::jsonb)
  INTO v_trend
  FROM (
    SELECT
      TO_CHAR(TO_TIMESTAMP(timestamp_ms / 1000.0) AT TIME ZONE 'Asia/Shanghai', v_fmt) AS day,
      SUM(total_tokens)::BIGINT AS tokens,
      SUM(total_cost)::REAL AS cost
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

-- 3. tokend_get_model_detail — hourly for 1d
CREATE OR REPLACE FUNCTION tokend_get_model_detail(
  p_token  TEXT,
  p_model  TEXT,
  p_period TEXT DEFAULT '7d'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code    TEXT;
  v_days    INTEGER;
  v_from_ms BIGINT;
  v_fmt     TEXT;
  v_summary RECORD;
  v_trend   JSONB;
  v_mix     JSONB;
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
    MAX(provider)                             AS provider,
    SUM(total_tokens)::BIGINT                AS total_tokens,
    SUM(total_cost)::REAL                    AS total_cost,
    COUNT(*)::INTEGER                        AS call_count,
    SUM(input_tokens)::BIGINT                AS input_tokens,
    SUM(output_tokens)::BIGINT               AS output_tokens,
    SUM(cache_read_tokens)::BIGINT           AS cache_read_tokens,
    CASE WHEN COUNT(*) > 0
      THEN (SUM(total_tokens) / COUNT(*))::INTEGER
      ELSE 0
    END                                      AS avg_tokens_per_call
  INTO v_summary
  FROM tokend_usage_events
  WHERE member_code = v_code
    AND model = p_model
    AND timestamp_ms >= v_from_ms;

  -- daily/hourly trend
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('day', d.day, 'tokens', d.tokens, 'cost', d.cost)
    ORDER BY d.day
  ), '[]'::jsonb)
  INTO v_trend
  FROM (
    SELECT
      TO_CHAR(TO_TIMESTAMP(timestamp_ms / 1000.0) AT TIME ZONE 'Asia/Shanghai', v_fmt) AS day,
      SUM(total_tokens)::BIGINT AS tokens,
      SUM(total_cost)::REAL AS cost
    FROM tokend_usage_events
    WHERE member_code = v_code AND model = p_model AND timestamp_ms >= v_from_ms
    GROUP BY 1
  ) d;

  -- channel mix
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('channel', c.channel, 'calls', c.calls)
    ORDER BY c.calls DESC
  ), '[]'::jsonb)
  INTO v_mix
  FROM (
    SELECT channel, COUNT(*)::INTEGER AS calls
    FROM tokend_usage_events
    WHERE member_code = v_code AND model = p_model AND timestamp_ms >= v_from_ms
    GROUP BY channel
  ) c;

  RETURN json_build_object(
    'ok', true,
    'summary', json_build_object(
      'model',           p_model,
      'provider',        v_summary.provider,
      'totalTokens',     COALESCE(v_summary.total_tokens, 0),
      'totalCost',       COALESCE(v_summary.total_cost, 0),
      'callCount',       COALESCE(v_summary.call_count, 0),
      'inputTokens',     COALESCE(v_summary.input_tokens, 0),
      'outputTokens',    COALESCE(v_summary.output_tokens, 0),
      'cacheReadTokens', COALESCE(v_summary.cache_read_tokens, 0),
      'avgTokensPerCall', COALESCE(v_summary.avg_tokens_per_call, 0)
    ),
    'dailyTrend', v_trend,
    'channelMix', v_mix
  );
END;
$$;

-- 4. tokend_get_channel_breakdown_v2 — add cacheReadTokens + userMessageCount
CREATE OR REPLACE FUNCTION tokend_get_channel_breakdown_v2(
  p_token  TEXT,
  p_period TEXT DEFAULT '7d'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code    TEXT;
  v_days    INTEGER;
  v_from_ms BIGINT;
  v_rows    JSONB;
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

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'channel',          c.channel,
      'tokens',           c.tokens,
      'cost',             c.cost,
      'calls',            c.calls,
      'sessions',         c.sessions,
      'inputTokens',      c.input_tokens,
      'outputTokens',     c.output_tokens,
      'cacheReadTokens',  c.cache_read_tokens,
      'messageCount',     COALESCE(c.msg_count, c.calls),
      'userMessageCount', c.user_msg_count,
      'lastSeen',         c.last_seen
    ) ORDER BY c.tokens DESC
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      u.channel,
      SUM(u.total_tokens)::BIGINT              AS tokens,
      SUM(u.total_cost)::REAL                  AS cost,
      COUNT(*)::INTEGER                        AS calls,
      COUNT(DISTINCT u.session_id)::INTEGER    AS sessions,
      SUM(u.input_tokens)::BIGINT              AS input_tokens,
      SUM(u.output_tokens)::BIGINT             AS output_tokens,
      SUM(u.cache_read_tokens)::BIGINT         AS cache_read_tokens,
      MAX(u.timestamp_ms)::BIGINT              AS last_seen,
      (SELECT COUNT(*)::INTEGER FROM tokend_message_events m
       WHERE m.member_code = v_code AND m.channel = u.channel
         AND m.timestamp_ms >= v_from_ms) AS msg_count,
      (SELECT COUNT(*)::INTEGER FROM tokend_message_events m
       WHERE m.member_code = v_code AND m.channel = u.channel
         AND m.timestamp_ms >= v_from_ms AND m.kind = 'user') AS user_msg_count
    FROM tokend_usage_events u
    WHERE u.member_code = v_code
      AND u.timestamp_ms >= v_from_ms
    GROUP BY u.channel
    ORDER BY tokens DESC
  ) c;

  RETURN json_build_object('ok', true, 'channels', v_rows);
END;
$$;
