-- ============================================================
-- Tokend V5 — fix top projects + top conversations logic
-- Match local version exactly
-- ============================================================

-- 1. tokend_get_top_projects — only coding channels, use agent field
DROP FUNCTION IF EXISTS tokend_get_top_projects(text,text);

CREATE OR REPLACE FUNCTION tokend_get_top_projects(
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

  -- Match local: group by channel + agent, only coding channels, filter empty/unknown/~
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'project',  p.agent_name,
      'channel',  p.channel,
      'tokens',   p.tokens,
      'cost',     p.cost,
      'calls',    p.calls,
      'sessions', p.sessions,
      'lastAt',   p.last_at
    ) ORDER BY p.tokens DESC
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      COALESCE(NULLIF(TRIM(agent), ''), NULLIF(TRIM(project), '')) AS agent_name,
      channel,
      (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0))::BIGINT AS tokens,
      (COALESCE(SUM(input_cost), 0) + COALESCE(SUM(output_cost), 0) + COALESCE(SUM(cache_read_cost), 0))::REAL AS cost,
      COUNT(*)::INTEGER AS calls,
      COUNT(DISTINCT session_id)::INTEGER AS sessions,
      MAX(timestamp_ms)::BIGINT AS last_at
    FROM tokend_usage_events
    WHERE member_code = v_code
      AND timestamp_ms >= v_from_ms
      AND channel IN ('claude-code', 'codex', 'gemini-cli', 'copilot-cli', 'opencode', 'kimi-code', 'qwen-code')
      AND COALESCE(NULLIF(TRIM(agent), ''), NULLIF(TRIM(project), '')) IS NOT NULL
      AND COALESCE(NULLIF(TRIM(agent), ''), NULLIF(TRIM(project), '')) NOT IN ('unknown', '~', '')
    GROUP BY channel, agent_name
    ORDER BY tokens DESC, cost DESC
    LIMIT 8
  ) p;

  RETURN json_build_object('ok', true, 'projects', v_rows);
END;
$$;

-- 2. tokend_get_summary_v2 — fix topConversations: exclude cron, use project→agent fallback, sessionId for display
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
  v_cur_msg    RECORD;
  v_prev_msg   RECORD;
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

  -- current period usage
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

  -- previous period usage
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

  -- current period messages
  SELECT
    COUNT(*)::INTEGER AS total_messages,
    COUNT(*) FILTER (WHERE kind = 'user')::INTEGER AS user_messages
  INTO v_cur_msg
  FROM tokend_message_events
  WHERE member_code = v_code
    AND timestamp_ms >= v_from_ms;

  -- previous period messages
  SELECT
    COUNT(*)::INTEGER AS total_messages,
    COUNT(*) FILTER (WHERE kind = 'user')::INTEGER AS user_messages
  INTO v_prev_msg
  FROM tokend_message_events
  WHERE member_code = v_code
    AND timestamp_ms >= v_prev_from
    AND timestamp_ms <  v_from_ms;

  -- model distribution
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

  -- top conversations: exclude cron, use project→agent→sessionId for title
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'sessionId', c.session_id,
      'title',     COALESCE(NULLIF(c.project, ''), NULLIF(c.agent, ''), LEFT(c.session_id, 8)),
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
      MAX(project) AS project,
      MAX(channel) AS channel,
      (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0))::BIGINT AS tokens,
      (COALESCE(SUM(input_cost), 0) + COALESCE(SUM(output_cost), 0) + COALESCE(SUM(cache_read_cost), 0))::REAL AS cost,
      MAX(timestamp_ms)::BIGINT AS last_at
    FROM tokend_usage_events
    WHERE member_code = v_code
      AND timestamp_ms >= v_from_ms
      AND channel != 'cron'
    GROUP BY session_id
    ORDER BY tokens DESC
    LIMIT 8
  ) c;

  RETURN json_build_object(
    'ok', true,
    'current', json_build_object(
      'totalTokens',      v_cur.total_tokens,
      'totalCost',        v_cur.total_cost,
      'inputTokens',      v_cur.input_tokens,
      'outputTokens',     v_cur.output_tokens,
      'cacheReadTokens',  v_cur.cache_read_tokens,
      'callCount',        v_cur.call_count,
      'sessionCount',     v_cur.session_count,
      'channelCount',     v_cur.channel_count,
      'messageCount',     CASE WHEN v_cur_msg.total_messages > 0 THEN v_cur_msg.total_messages ELSE v_cur.call_count END,
      'userMessageCount', CASE WHEN v_cur_msg.user_messages > 0 THEN v_cur_msg.user_messages ELSE NULL END
    ),
    'previous', json_build_object(
      'totalTokens',      v_prev.total_tokens,
      'totalCost',        v_prev.total_cost,
      'inputTokens',      v_prev.input_tokens,
      'outputTokens',     v_prev.output_tokens,
      'cacheReadTokens',  v_prev.cache_read_tokens,
      'callCount',        v_prev.call_count,
      'sessionCount',     v_prev.session_count,
      'channelCount',     v_prev.channel_count,
      'messageCount',     CASE WHEN v_prev_msg.total_messages > 0 THEN v_prev_msg.total_messages ELSE v_prev.call_count END,
      'userMessageCount', CASE WHEN v_prev_msg.user_messages > 0 THEN v_prev_msg.user_messages ELSE NULL END
    ),
    'modelDistribution', v_models,
    'topConversations',  v_convos
  );
END;
$$;
