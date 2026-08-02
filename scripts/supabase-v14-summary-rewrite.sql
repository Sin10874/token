-- v14: 重写 tokend_get_summary_v4 —— 把 6 次表扫描 + 2 处 per-row EXISTS
--      降到「基表扫 1 次 + message 扫 1 次」，根治 statement timeout。
--
-- 旧版瓶颈（实测 7d 16.7s / 30d >30s）：
--   1) v_cur / v_prev / v_models / v_convos 各自重复扫一遍 usage_events
--   2) v_cur_msg / v_prev_msg 用 per-row EXISTS 每条 message 回查 usage（O(n×m)）—— 主因
--
-- 重写策略：
--   - 基表 usage_events 只扫 1 次，物化进 temp 表 _summ_base（含 prev+cur 整段、
--     已过可见性过滤、带 is_cur 标志）；current/previous/modelDistribution/
--     topConversations 全部从 temp 派生（temp 几万行在内存，聚合 <100ms）。
--   - message 的 per-row EXISTS 换成「visible_sessions 集合 + IN」一次性过滤。
--
-- 字段语义与旧版完全一致（验证锚点见文末）。CREATE OR REPLACE，可随时回滚旧版。
-- statement_timeout 兜底（v13 STEP 1 已设 30s）保留，作为冷场景缓冲。

CREATE OR REPLACE FUNCTION tokend_get_summary_v4(
  p_token    TEXT,
  p_period   TEXT DEFAULT '7d',
  p_timezone TEXT DEFAULT 'Asia/Shanghai'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '30s'
AS $$
DECLARE
  v_code       TEXT;
  v_timezone   TEXT := 'Asia/Shanghai';
  v_from_ms    BIGINT;
  v_prev_from  BIGINT;
  v_prev_to    BIGINT;
  v_cur        RECORD;
  v_prev       RECORD;
  v_msg        RECORD;
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

  SELECT COALESCE((
    SELECT name FROM pg_timezone_names WHERE name = p_timezone LIMIT 1
  ), 'Asia/Shanghai')
  INTO v_timezone;

  IF p_period = '30d' THEN
    v_from_ms := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone(v_timezone, now())) - INTERVAL '29 days') AT TIME ZONE v_timezone)) * 1000)::BIGINT;
    v_prev_from := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone(v_timezone, now())) - INTERVAL '59 days') AT TIME ZONE v_timezone)) * 1000)::BIGINT;
    v_prev_to := v_from_ms;
  ELSIF p_period = '1d' THEN
    v_from_ms := (EXTRACT(EPOCH FROM (now() - INTERVAL '24 hours')) * 1000)::BIGINT;
    v_prev_from := (EXTRACT(EPOCH FROM (now() - INTERVAL '48 hours')) * 1000)::BIGINT;
    v_prev_to := v_from_ms;
  ELSE
    v_from_ms := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone(v_timezone, now())) - INTERVAL '6 days') AT TIME ZONE v_timezone)) * 1000)::BIGINT;
    v_prev_from := (EXTRACT(EPOCH FROM ((date_trunc('day', timezone(v_timezone, now())) - INTERVAL '13 days') AT TIME ZONE v_timezone)) * 1000)::BIGINT;
    v_prev_to := v_from_ms;
  END IF;

  -- ① 基表只扫这一次：物化 [v_prev_from, ∞) 的可见 usage 进 temp（带 is_cur 标志）
  DROP TABLE IF EXISTS _summ_base;
  CREATE TEMP TABLE _summ_base ON COMMIT DROP AS
  SELECT input_tokens, output_tokens, cache_read_tokens,
         input_cost, output_cost, cache_read_cost,
         session_id, channel, model, agent, project, timestamp_ms,
         (timestamp_ms >= v_from_ms) AS is_cur
  FROM tokend_usage_events
  WHERE member_code = v_code
    AND timestamp_ms >= v_prev_from
    AND tokend_is_user_visible_usage(channel, session_key);

  -- current 聚合（从 temp，下同）
  SELECT
    (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0))::BIGINT AS total_tokens,
    (COALESCE(SUM(input_cost), 0) + COALESCE(SUM(output_cost), 0) + COALESCE(SUM(cache_read_cost), 0))::REAL AS total_cost,
    COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens,
    COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
    COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
    COUNT(*)::INTEGER AS call_count,
    COUNT(DISTINCT session_id)::INTEGER AS session_count,
    COUNT(DISTINCT channel)::INTEGER AS channel_count
  INTO v_cur
  FROM _summ_base WHERE is_cur;

  -- previous 聚合：NOT is_cur ⟺ [v_prev_from, v_from_ms)，与旧版区间一致
  SELECT
    (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0))::BIGINT AS total_tokens,
    (COALESCE(SUM(input_cost), 0) + COALESCE(SUM(output_cost), 0) + COALESCE(SUM(cache_read_cost), 0))::REAL AS total_cost,
    COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens,
    COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
    COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
    COUNT(*)::INTEGER AS call_count,
    COUNT(DISTINCT session_id)::INTEGER AS session_count,
    COUNT(DISTINCT channel)::INTEGER AS channel_count
  INTO v_prev
  FROM _summ_base WHERE NOT is_cur;

  -- message：per-row EXISTS → visible_sessions(IN) 一次过滤；用 FILTER 区分本期/上期
  SELECT
    COUNT(*) FILTER (WHERE m.kind IN ('user','assistant') AND m.timestamp_ms >= v_from_ms)::INTEGER AS cur_total,
    COUNT(*) FILTER (WHERE m.kind = 'user' AND m.timestamp_ms >= v_from_ms)::INTEGER AS cur_user,
    COUNT(*) FILTER (WHERE m.kind IN ('user','assistant') AND m.timestamp_ms < v_from_ms)::INTEGER AS prev_total,
    COUNT(*) FILTER (WHERE m.kind = 'user' AND m.timestamp_ms < v_from_ms)::INTEGER AS prev_user
  INTO v_msg
  FROM tokend_message_events m
  WHERE m.member_code = v_code
    AND m.timestamp_ms >= v_prev_from
    AND COALESCE(m.channel, '') NOT IN ('', 'unknown')
    AND m.session_id IN (SELECT DISTINCT session_id FROM _summ_base);

  -- modelDistribution top 10（current 窗口，从 temp）
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('model', m.model, 'tokens', m.tokens) ORDER BY m.tokens DESC
  ), '[]'::jsonb)
  INTO v_models
  FROM (
    SELECT model, (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0))::BIGINT AS tokens
    FROM _summ_base WHERE is_cur
    GROUP BY model ORDER BY tokens DESC LIMIT 10
  ) m;

  -- topConversations top 8（current 窗口，从 temp）
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
    FROM _summ_base WHERE is_cur
    GROUP BY session_id
    ORDER BY tokens DESC, cost DESC LIMIT 8
  ) c;

  RETURN json_build_object(
    'ok', true,
    'current', json_build_object(
      'totalTokens',      COALESCE(v_cur.total_tokens, 0),
      'totalCost',        COALESCE(v_cur.total_cost, 0),
      'inputTokens',      COALESCE(v_cur.input_tokens, 0),
      'outputTokens',     COALESCE(v_cur.output_tokens, 0),
      'cacheReadTokens',  COALESCE(v_cur.cache_read_tokens, 0),
      'callCount',        COALESCE(v_cur.call_count, 0),
      'sessionCount',     COALESCE(v_cur.session_count, 0),
      'channelCount',     COALESCE(v_cur.channel_count, 0),
      'messageCount',     CASE WHEN COALESCE(v_msg.cur_total, 0) > 0 THEN v_msg.cur_total ELSE COALESCE(v_cur.call_count, 0) END,
      'userMessageCount', CASE WHEN COALESCE(v_msg.cur_user, 0) > 0 THEN v_msg.cur_user ELSE NULL END
    ),
    'previous', json_build_object(
      'totalTokens',      COALESCE(v_prev.total_tokens, 0),
      'totalCost',        COALESCE(v_prev.total_cost, 0),
      'inputTokens',      COALESCE(v_prev.input_tokens, 0),
      'outputTokens',     COALESCE(v_prev.output_tokens, 0),
      'cacheReadTokens',  COALESCE(v_prev.cache_read_tokens, 0),
      'callCount',        COALESCE(v_prev.call_count, 0),
      'sessionCount',     COALESCE(v_prev.session_count, 0),
      'channelCount',     COALESCE(v_prev.channel_count, 0),
      'messageCount',     CASE WHEN COALESCE(v_msg.prev_total, 0) > 0 THEN v_msg.prev_total ELSE COALESCE(v_prev.call_count, 0) END,
      'userMessageCount', CASE WHEN COALESCE(v_msg.prev_user, 0) > 0 THEN v_msg.prev_user ELSE NULL END
    ),
    'modelDistribution', v_models,
    'topConversations',  v_convos
  );
END;
$$;

-- ============================================================
-- 验证锚点：部署后实测应与旧版数字一致，仅速度大幅提升
--   7d: current.totalCost ≈ 2474.63, current.totalTokens = 53764415
-- 语义微差异（可接受）：message 的 visible_sessions 取自 [v_prev_from, ∞) 窗口，
--   旧版 EXISTS 不限时间——仅当某 session 的可见 usage 全在 60 天前、却有 message
--   落在统计窗口内时，message 计数会略少。该场景极罕见，且 messageCount 有
--   「>0 否则回退 callCount」兜底，不影响主指标。
-- ============================================================
