-- ============================================================
-- Tokend V2 RPCs — enhanced breakdowns + detail pages
-- Run in Supabase SQL Editor
-- ============================================================

-- ----------------------------------------------------------
-- 1. tokend_get_summary_v2
--    Adds: inputTokens, outputTokens, cacheReadTokens,
--          messageCount, modelDistribution, topConversations
-- ----------------------------------------------------------
CREATE OR REPLACE FUNCTION tokend_get_summary_v2(
  p_token  TEXT,
  p_period TEXT DEFAULT '7d'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code       TEXT;
  v_days       INTEGER;
  v_from_ms    BIGINT;
  v_prev_from  BIGINT;
  v_cur        RECORD;
  v_prev       RECORD;
  v_models     JSONB;
  v_convos     JSONB;
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

  v_from_ms   := (EXTRACT(EPOCH FROM (now() - (v_days || ' days')::INTERVAL)) * 1000)::BIGINT;
  v_prev_from := (EXTRACT(EPOCH FROM (now() - (v_days * 2 || ' days')::INTERVAL)) * 1000)::BIGINT;

  -- current period
  SELECT
    COALESCE(SUM(total_tokens), 0)::BIGINT         AS total_tokens,
    COALESCE(SUM(total_cost), 0)::REAL              AS total_cost,
    COALESCE(SUM(input_tokens), 0)::BIGINT          AS input_tokens,
    COALESCE(SUM(output_tokens), 0)::BIGINT         AS output_tokens,
    COALESCE(SUM(cache_read_tokens), 0)::BIGINT     AS cache_read_tokens,
    COUNT(*)::INTEGER                                AS call_count,
    COUNT(DISTINCT session_id)::INTEGER              AS session_count,
    COUNT(DISTINCT channel)::INTEGER                 AS channel_count
  INTO v_cur
  FROM tokend_usage_events
  WHERE member_code = v_code
    AND timestamp_ms >= v_from_ms;

  -- previous period
  SELECT
    COALESCE(SUM(total_tokens), 0)::BIGINT          AS total_tokens,
    COALESCE(SUM(total_cost), 0)::REAL               AS total_cost,
    COALESCE(SUM(input_tokens), 0)::BIGINT           AS input_tokens,
    COALESCE(SUM(output_tokens), 0)::BIGINT          AS output_tokens,
    COALESCE(SUM(cache_read_tokens), 0)::BIGINT      AS cache_read_tokens,
    COUNT(*)::INTEGER                                 AS call_count,
    COUNT(DISTINCT session_id)::INTEGER               AS session_count,
    COUNT(DISTINCT channel)::INTEGER                  AS channel_count
  INTO v_prev
  FROM tokend_usage_events
  WHERE member_code = v_code
    AND timestamp_ms >= v_prev_from
    AND timestamp_ms <  v_from_ms;

  -- model distribution (top 10 by tokens)
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('model', m.model, 'tokens', m.tokens)
    ORDER BY m.tokens DESC
  ), '[]'::jsonb)
  INTO v_models
  FROM (
    SELECT model, SUM(total_tokens)::BIGINT AS tokens
    FROM tokend_usage_events
    WHERE member_code = v_code AND timestamp_ms >= v_from_ms
    GROUP BY model
    ORDER BY tokens DESC
    LIMIT 10
  ) m;

  -- top conversations (top 10 sessions by tokens)
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'sessionId', c.session_id,
      'title',     COALESCE(c.agent, 'unknown'),
      'channel',   c.channel,
      'tokens',    c.tokens,
      'cost',      c.cost,
      'lastAt',    c.last_at
    ) ORDER BY c.tokens DESC
  ), '[]'::jsonb)
  INTO v_convos
  FROM (
    SELECT
      session_id,
      MAX(agent) AS agent,
      MAX(channel) AS channel,
      SUM(total_tokens)::BIGINT AS tokens,
      SUM(total_cost)::REAL AS cost,
      MAX(timestamp_ms)::BIGINT AS last_at
    FROM tokend_usage_events
    WHERE member_code = v_code AND timestamp_ms >= v_from_ms
    GROUP BY session_id
    ORDER BY tokens DESC
    LIMIT 10
  ) c;

  RETURN json_build_object(
    'ok', true,
    'current', json_build_object(
      'totalTokens',     v_cur.total_tokens,
      'totalCost',       v_cur.total_cost,
      'inputTokens',     v_cur.input_tokens,
      'outputTokens',    v_cur.output_tokens,
      'cacheReadTokens', v_cur.cache_read_tokens,
      'callCount',       v_cur.call_count,
      'sessionCount',    v_cur.session_count,
      'channelCount',    v_cur.channel_count,
      'messageCount',    v_cur.call_count,
      'userMessageCount', NULL
    ),
    'previous', json_build_object(
      'totalTokens',     v_prev.total_tokens,
      'totalCost',       v_prev.total_cost,
      'inputTokens',     v_prev.input_tokens,
      'outputTokens',    v_prev.output_tokens,
      'cacheReadTokens', v_prev.cache_read_tokens,
      'callCount',       v_prev.call_count,
      'sessionCount',    v_prev.session_count,
      'channelCount',    v_prev.channel_count,
      'messageCount',    v_prev.call_count,
      'userMessageCount', NULL
    ),
    'modelDistribution', v_models,
    'topConversations',  v_convos
  );
END;
$$;

-- ----------------------------------------------------------
-- 2. tokend_get_daily_trend_v2
--    Adds: inputTokens, outputTokens, inputCost, outputCost
-- ----------------------------------------------------------
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
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  v_days    := CASE p_period
    WHEN '1d'  THEN 1
    WHEN '7d'  THEN 7
    WHEN '30d' THEN 30
    ELSE 7
  END;
  v_from_ms := (EXTRACT(EPOCH FROM (now() - (v_days || ' days')::INTERVAL)) * 1000)::BIGINT;

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
        'YYYY-MM-DD'
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

-- ----------------------------------------------------------
-- 3. tokend_get_model_breakdown_v2
--    Adds: inputTokens, outputTokens, cacheReadTokens,
--          sessionCount, lastSeen
-- ----------------------------------------------------------
CREATE OR REPLACE FUNCTION tokend_get_model_breakdown_v2(
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

  v_days    := CASE p_period
    WHEN '1d'  THEN 1
    WHEN '7d'  THEN 7
    WHEN '30d' THEN 30
    ELSE 7
  END;
  v_from_ms := (EXTRACT(EPOCH FROM (now() - (v_days || ' days')::INTERVAL)) * 1000)::BIGINT;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'model',           m.model,
      'provider',        m.provider,
      'tokens',          m.tokens,
      'cost',            m.cost,
      'calls',           m.calls,
      'inputTokens',     m.input_tokens,
      'outputTokens',    m.output_tokens,
      'cacheReadTokens', m.cache_read_tokens,
      'sessionCount',    m.session_count,
      'lastSeen',        m.last_seen
    ) ORDER BY m.tokens DESC
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      model,
      MAX(provider) AS provider,
      SUM(total_tokens)::BIGINT              AS tokens,
      SUM(total_cost)::REAL                  AS cost,
      COUNT(*)::INTEGER                      AS calls,
      SUM(input_tokens)::BIGINT              AS input_tokens,
      SUM(output_tokens)::BIGINT             AS output_tokens,
      SUM(cache_read_tokens)::BIGINT         AS cache_read_tokens,
      COUNT(DISTINCT session_id)::INTEGER    AS session_count,
      MAX(timestamp_ms)::BIGINT              AS last_seen
    FROM tokend_usage_events
    WHERE member_code = v_code
      AND timestamp_ms >= v_from_ms
    GROUP BY model
    ORDER BY tokens DESC
  ) m;

  RETURN json_build_object('ok', true, 'models', v_rows);
END;
$$;

-- ----------------------------------------------------------
-- 4. tokend_get_channel_breakdown_v2
--    Adds: inputTokens, outputTokens, messageCount, lastSeen
-- ----------------------------------------------------------
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

  v_days    := CASE p_period
    WHEN '1d'  THEN 1
    WHEN '7d'  THEN 7
    WHEN '30d' THEN 30
    ELSE 7
  END;
  v_from_ms := (EXTRACT(EPOCH FROM (now() - (v_days || ' days')::INTERVAL)) * 1000)::BIGINT;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'channel',      c.channel,
      'tokens',       c.tokens,
      'cost',         c.cost,
      'calls',        c.calls,
      'sessions',     c.sessions,
      'inputTokens',  c.input_tokens,
      'outputTokens', c.output_tokens,
      'messageCount', c.calls,
      'lastSeen',     c.last_seen
    ) ORDER BY c.tokens DESC
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      channel,
      SUM(total_tokens)::BIGINT              AS tokens,
      SUM(total_cost)::REAL                  AS cost,
      COUNT(*)::INTEGER                      AS calls,
      COUNT(DISTINCT session_id)::INTEGER    AS sessions,
      SUM(input_tokens)::BIGINT              AS input_tokens,
      SUM(output_tokens)::BIGINT             AS output_tokens,
      MAX(timestamp_ms)::BIGINT              AS last_seen
    FROM tokend_usage_events
    WHERE member_code = v_code
      AND timestamp_ms >= v_from_ms
    GROUP BY channel
    ORDER BY tokens DESC
  ) c;

  RETURN json_build_object('ok', true, 'channels', v_rows);
END;
$$;

-- ----------------------------------------------------------
-- 5. tokend_get_model_detail
--    Model detail: summary + daily trend + channel mix
-- ----------------------------------------------------------
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

  v_days    := CASE p_period
    WHEN '1d'  THEN 1
    WHEN '7d'  THEN 7
    WHEN '30d' THEN 30
    ELSE 7
  END;
  v_from_ms := (EXTRACT(EPOCH FROM (now() - (v_days || ' days')::INTERVAL)) * 1000)::BIGINT;

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

  -- daily trend
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('day', d.day, 'tokens', d.tokens, 'cost', d.cost)
    ORDER BY d.day
  ), '[]'::jsonb)
  INTO v_trend
  FROM (
    SELECT
      TO_CHAR(TO_TIMESTAMP(timestamp_ms / 1000.0) AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day,
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

-- ----------------------------------------------------------
-- 6. tokend_get_channel_detail
--    Channel detail: summary + daily trend + model mix + top sessions
-- ----------------------------------------------------------
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
  v_code    TEXT;
  v_days    INTEGER;
  v_from_ms BIGINT;
  v_summary RECORD;
  v_trend   JSONB;
  v_mix     JSONB;
  v_sessions JSONB;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  v_days    := CASE p_period
    WHEN '1d'  THEN 1
    WHEN '7d'  THEN 7
    WHEN '30d' THEN 30
    ELSE 7
  END;
  v_from_ms := (EXTRACT(EPOCH FROM (now() - (v_days || ' days')::INTERVAL)) * 1000)::BIGINT;

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

  -- daily trend
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('day', d.day, 'tokens', d.tokens, 'cost', d.cost)
    ORDER BY d.day
  ), '[]'::jsonb)
  INTO v_trend
  FROM (
    SELECT
      TO_CHAR(TO_TIMESTAMP(timestamp_ms / 1000.0) AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day,
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

-- ----------------------------------------------------------
-- 7. tokend_get_session_detail
--    Session detail: session info + events list
-- ----------------------------------------------------------
CREATE OR REPLACE FUNCTION tokend_get_session_detail(
  p_token      TEXT,
  p_session_id TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code    TEXT;
  v_session RECORD;
  v_events  JSONB;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  -- session aggregate
  SELECT
    MAX(agent)                                 AS agent,
    MAX(channel)                               AS channel,
    MAX(model)                                 AS current_model,
    MIN(timestamp_ms)::BIGINT                  AS first_seen_at,
    MAX(timestamp_ms)::BIGINT                  AS last_seen_at,
    COUNT(*)::INTEGER                          AS call_count,
    SUM(total_tokens)::BIGINT                  AS total_tokens,
    SUM(total_cost)::REAL                      AS total_cost,
    SUM(input_tokens)::BIGINT                  AS input_tokens,
    SUM(output_tokens)::BIGINT                 AS output_tokens,
    SUM(cache_read_tokens)::BIGINT             AS cache_read_tokens
  INTO v_session
  FROM tokend_usage_events
  WHERE member_code = v_code
    AND session_id = p_session_id;

  -- events list
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',           e.id,
      'timestampMs',  e.timestamp_ms,
      'model',        e.model,
      'inputTokens',  e.input_tokens,
      'outputTokens', e.output_tokens,
      'totalTokens',  e.total_tokens,
      'totalCost',    e.total_cost,
      'stopReason',   e.stop_reason
    ) ORDER BY e.timestamp_ms
  ), '[]'::jsonb)
  INTO v_events
  FROM tokend_usage_events e
  WHERE e.member_code = v_code
    AND e.session_id = p_session_id;

  RETURN json_build_object(
    'ok', true,
    'session', json_build_object(
      'sessionId',       p_session_id,
      'agent',           v_session.agent,
      'channel',         v_session.channel,
      'currentModel',    v_session.current_model,
      'firstSeenAt',     v_session.first_seen_at,
      'lastSeenAt',      v_session.last_seen_at,
      'callCount',       v_session.call_count,
      'totalTokens',     COALESCE(v_session.total_tokens, 0),
      'totalCost',       COALESCE(v_session.total_cost, 0),
      'inputTokens',     COALESCE(v_session.input_tokens, 0),
      'outputTokens',    COALESCE(v_session.output_tokens, 0),
      'cacheReadTokens', COALESCE(v_session.cache_read_tokens, 0)
    ),
    'events', v_events
  );
END;
$$;

-- ============================================================
-- Done. 7 new/enhanced RPCs ready.
-- ============================================================
