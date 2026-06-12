-- v10: 服务端价格表 + 零成本回填 + 入库兜底计价（分批修订版）
--
-- 背景：成本由 CLI 端价格表(cli/prices.ts)计算后上传。CLI 价格表过旧时，
-- 新模型(fable-5/opus-4-8/gpt-5.5 等)事件以 total_cost=0 入库，且
-- tokend_upload_events 的 ON CONFLICT 只更新 project，成本永不被覆盖。
--
-- ⚠️ SQL Editor 有 ~60s 网关超时，整个文件一次 Run 会超时回滚。
-- 必须按下面四步分开执行：
--
--   STEP 1  执行「PART 1」整段（表+价格+RPC+函数定义，秒级）
--   STEP 2  执行「PART 2」的建索引语句（一条，加速回填）
--   STEP 3  反复执行  SELECT tokend_backfill_zero_costs_batch(50000);
--           直到返回 repriced = 0（每次约几秒；行数多就多点几次 Run）
--           如果单批仍超时，把 50000 改小（如 20000）
--   STEP 4  执行  SELECT tokend_rebuild_session_costs();
--           然后执行「PART 4」末尾的清理语句删除临时索引
--
-- 完成后验证（正常只剩 free/订阅内置模型）：
--   SELECT model, COUNT(*) FROM tokend_usage_events
--   WHERE total_cost=0 AND total_tokens>0 GROUP BY model ORDER BY 2 DESC;

-- ============================================================
-- PART 1（STEP 1 执行本段全部）
-- ============================================================

-- 1a. 价格表（USD / per_tokens，默认百万 Token）
CREATE TABLE IF NOT EXISTS tokend_model_prices (
  model_id          TEXT        PRIMARY KEY,
  provider          TEXT,
  input_price       REAL        DEFAULT 0,
  output_price      REAL        DEFAULT 0,
  cache_read_price  REAL        DEFAULT 0,
  cache_write_price REAL        DEFAULT 0,
  per_tokens        BIGINT      DEFAULT 1000000,
  updated_at        TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE tokend_model_prices ENABLE ROW LEVEL SECURITY;
-- 无公开策略：仅 SECURITY DEFINER RPC 内部读取

INSERT INTO tokend_model_prices
  (model_id, provider, input_price, output_price, cache_read_price, cache_write_price)
VALUES
  -- anthropic
  ('claude-fable-5',            'anthropic', 10,   50,   1,     12.5),
  ('claude-opus-4-8',           'anthropic', 5,    25,   0.5,   6.25),
  ('claude-opus-4-7',           'anthropic', 5,    25,   0.5,   6.25),
  ('claude-opus-4-6',           'anthropic', 5,    25,   0.5,   6.25),
  ('claude-opus-4-5',           'anthropic', 5,    25,   0.5,   6.25),
  ('claude-opus-4-1',           'anthropic', 15,   75,   1.5,   18.75),
  ('claude-opus-4',             'anthropic', 15,   75,   1.5,   18.75),
  ('claude-sonnet-4-6',         'anthropic', 3,    15,   0.3,   3.75),
  ('claude-sonnet-4-5',         'anthropic', 3,    15,   0.3,   3.75),
  ('claude-sonnet-4',           'anthropic', 3,    15,   0.3,   3.75),
  ('claude-sonnet-3-7',         'anthropic', 3,    15,   0.3,   3.75),
  ('claude-haiku-4-5',          'anthropic', 1,    5,    0.1,   1.25),
  ('claude-haiku-3-5',          'anthropic', 0.8,  4,    0.08,  1),
  ('claude-haiku-3',            'anthropic', 0.25, 1.25, 0.03,  0.3),
  -- openai
  ('gpt-5.5',                   'openai',    5,    30,   0.5,   0),
  ('gpt-5.4',                   'openai',    2.5,  15,   0.25,  0),
  ('gpt-5-codex',               'openai',    1.25, 10,   0.125, 0),
  ('gpt-5.3-codex',             'openai',    1.75, 14,   0.175, 0),
  ('gpt-5.3-codex-spark',       'openai',    1.75, 14,   0.175, 0),
  ('codex-auto-review',         'openai',    0,    0,    0,     0),
  ('gpt-4o',                    'openai',    2.5,  10,   1.25,  0),
  -- google
  ('gemini-3-pro-preview',      'google',    2,    12,   0.2,   0),
  ('gemini-2.5-pro',            'google',    1.25, 10,   0.31,  0),
  -- moonshot（k2p5/k2p6/kimi-for-coding 为编程订阅渠道别名，按 API 列价计等效成本）
  ('kimi-k2.6',                 'moonshot',  0.95, 4,    0.16,  0),
  ('k2p6',                      'moonshot',  0.95, 4,    0.16,  0),
  ('kimi-k2.5',                 'moonshot',  0.6,  3,    0.1,   0),
  ('k2p5',                      'moonshot',  0.6,  3,    0.1,   0),
  ('kimi-for-coding',           'moonshot',  0.6,  3,    0.1,   0),
  ('kimi-code/kimi-for-coding', 'moonshot',  0.6,  3,    0.1,   0),
  ('kimi-k2-thinking',          'moonshot',  0.6,  2.5,  0.15,  0),
  -- zhipu
  ('glm-5.1',                   'zhipu',     1.4,  4.4,  0.26,  0),
  ('glm-5',                     'zhipu',     1,    3.2,  0.2,   0),
  ('glm-5-turbo',               'zhipu',     1.2,  4,    0.24,  0),
  ('glm-4.7',                   'zhipu',     0.6,  2.2,  0.11,  0),
  ('glm-4.7-flashx',            'zhipu',     0.07, 0.4,  0.01,  0),
  ('glm-4.5-air',               'zhipu',     0.2,  1.1,  0.03,  0),
  ('glm-4.7-free',              'zhipu',     0,    0,    0,     0),
  -- minimax（M3 缓存写未公布，按 M2.7 同款 1.25x input 估算；M-2.7/M-3 为渠道别名）
  ('MiniMax-M3',                'minimax',   0.3,  1.2,  0.06,  0.375),
  ('M-3',                       'minimax',   0.3,  1.2,  0.06,  0.375),
  ('MiniMax-M2.7',              'minimax',   0.3,  1.2,  0.06,  0.375),
  ('M-2.7',                     'minimax',   0.3,  1.2,  0.06,  0.375),
  ('minimax-m2.1-free',         'minimax',   0,    0,    0,     0),
  -- xai
  ('grok-code',                 'xai',       0.2,  1.5,  0.02,  0)
ON CONFLICT (model_id) DO UPDATE SET
  provider          = EXCLUDED.provider,
  input_price       = EXCLUDED.input_price,
  output_price      = EXCLUDED.output_price,
  cache_read_price  = EXCLUDED.cache_read_price,
  cache_write_price = EXCLUDED.cache_write_price,
  updated_at        = now();

-- 1b. tokend_upload_events 重写：入库兜底计价
--     （基于 v5b 版本；唯一改动是 cost 字段的 CASE 计算）
CREATE OR REPLACE FUNCTION tokend_upload_events(
  p_token       TEXT,
  p_events      JSONB,
  p_sync_states JSONB
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code  TEXT;
  v_count INTEGER;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  WITH deduped AS (
    SELECT DISTINCT ON (x->>'id') x
    FROM jsonb_array_elements(p_events) AS x
    ORDER BY x->>'id'
  ),
  -- 客户端报零成本但有 token 用量时，按服务端价格表计价
  enriched AS (
    SELECT d.x,
      (COALESCE((d.x->>'totalCost')::REAL, 0) = 0
        AND COALESCE((d.x->>'totalTokens')::INTEGER, 0) > 0
        AND pr.model_id IS NOT NULL)                          AS reprice,
      pr.input_price, pr.output_price, pr.cache_read_price,
      pr.cache_write_price, pr.per_tokens
    FROM deduped d
    LEFT JOIN LATERAL (
      SELECT p.* FROM tokend_model_prices p
      WHERE p.model_id = d.x->>'model'
         OR (d.x->>'model' ~ '-\d{8,}$'
             AND p.model_id = regexp_replace(d.x->>'model', '-\d{8,}$', ''))
      ORDER BY (p.model_id = d.x->>'model') DESC
      LIMIT 1
    ) pr ON TRUE
  ),
  ins AS (
    INSERT INTO tokend_usage_events (
      id, member_code, timestamp_ms, session_id, session_key,
      agent, provider, model, channel,
      input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens, total_tokens,
      input_cost, output_cost, reasoning_cost,
      cache_read_cost, cache_write_cost, total_cost,
      stop_reason, project
    )
    SELECT
      d.x->>'id',
      v_code,
      (d.x->>'timestampMs')::BIGINT,
      d.x->>'sessionId',
      d.x->>'sessionKey',
      d.x->>'agent',
      d.x->>'provider',
      d.x->>'model',
      COALESCE(d.x->>'channel', 'unknown'),
      COALESCE((d.x->>'inputTokens')::INTEGER, 0),
      COALESCE((d.x->>'outputTokens')::INTEGER, 0),
      COALESCE((d.x->>'reasoningTokens')::INTEGER, 0),
      COALESCE((d.x->>'cacheReadTokens')::INTEGER, 0),
      COALESCE((d.x->>'cacheWriteTokens')::INTEGER, 0),
      COALESCE((d.x->>'totalTokens')::INTEGER, 0),
      CASE WHEN d.reprice
        THEN COALESCE((d.x->>'inputTokens')::INTEGER, 0) * d.input_price / d.per_tokens
        ELSE COALESCE((d.x->>'inputCost')::REAL, 0) END,
      CASE WHEN d.reprice
        THEN COALESCE((d.x->>'outputTokens')::INTEGER, 0) * d.output_price / d.per_tokens
        ELSE COALESCE((d.x->>'outputCost')::REAL, 0) END,
      CASE WHEN d.reprice
        THEN COALESCE((d.x->>'reasoningTokens')::INTEGER, 0) * d.output_price / d.per_tokens
        ELSE COALESCE((d.x->>'reasoningCost')::REAL, 0) END,
      CASE WHEN d.reprice
        THEN COALESCE((d.x->>'cacheReadTokens')::INTEGER, 0) * d.cache_read_price / d.per_tokens
        ELSE COALESCE((d.x->>'cacheReadCost')::REAL, 0) END,
      CASE WHEN d.reprice
        THEN COALESCE((d.x->>'cacheWriteTokens')::INTEGER, 0) * d.cache_write_price / d.per_tokens
        ELSE COALESCE((d.x->>'cacheWriteCost')::REAL, 0) END,
      CASE WHEN d.reprice
        THEN (COALESCE((d.x->>'inputTokens')::INTEGER, 0) * d.input_price
            + COALESCE((d.x->>'outputTokens')::INTEGER, 0) * d.output_price
            + COALESCE((d.x->>'reasoningTokens')::INTEGER, 0) * d.output_price
            + COALESCE((d.x->>'cacheReadTokens')::INTEGER, 0) * d.cache_read_price
            + COALESCE((d.x->>'cacheWriteTokens')::INTEGER, 0) * d.cache_write_price
          ) / d.per_tokens
        ELSE COALESCE((d.x->>'totalCost')::REAL, 0) END,
      d.x->>'stopReason',
      d.x->>'project'
    FROM enriched d
    ON CONFLICT (id, member_code) DO UPDATE SET
      project = COALESCE(EXCLUDED.project, tokend_usage_events.project)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  WITH deduped_ss AS (
    SELECT DISTINCT ON (s->>'sourcePathHash') s
    FROM jsonb_array_elements(p_sync_states) AS s
    ORDER BY s->>'sourcePathHash'
  )
  INSERT INTO tokend_sync_state (
    member_code, source_path_hash, last_processed_lines,
    parser_version, last_sync_at
  )
  SELECT
    v_code,
    d.s->>'sourcePathHash',
    COALESCE((d.s->>'lastProcessedLines')::INTEGER, 0),
    COALESCE((d.s->>'parserVersion')::INTEGER, 1),
    now()
  FROM deduped_ss d
  ON CONFLICT (member_code, source_path_hash)
  DO UPDATE SET
    last_processed_lines = EXCLUDED.last_processed_lines,
    parser_version       = EXCLUDED.parser_version,
    last_sync_at         = now();

  RETURN json_build_object('ok', true, 'inserted', v_count);
END;
$$;

-- 1c. 分批回填函数：每次最多处理 p_limit 行，repriced = 0 即全部完成。
--     排除价格全 0 的免费模型（回填后 total_cost 仍为 0，不排除会死循环）
CREATE OR REPLACE FUNCTION tokend_backfill_zero_costs_batch(p_limit INTEGER DEFAULT 50000)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_repriced INTEGER;
BEGIN
  WITH batch AS (
    SELECT e.ctid AS row_id,
      e.input_tokens      * pr.input_price       / pr.per_tokens AS ic,
      e.output_tokens     * pr.output_price      / pr.per_tokens AS oc,
      e.reasoning_tokens  * pr.output_price      / pr.per_tokens AS rc,
      e.cache_read_tokens * pr.cache_read_price  / pr.per_tokens AS crc,
      e.cache_write_tokens * pr.cache_write_price / pr.per_tokens AS cwc
    FROM tokend_usage_events e
    JOIN LATERAL (
      SELECT p.* FROM tokend_model_prices p
      WHERE p.model_id = e.model
         OR (e.model ~ '-\d{8,}$'
             AND p.model_id = regexp_replace(e.model, '-\d{8,}$', ''))
      ORDER BY (p.model_id = e.model) DESC
      LIMIT 1
    ) pr ON TRUE
    WHERE e.total_cost = 0 AND e.total_tokens > 0
      AND (pr.input_price > 0 OR pr.output_price > 0
           OR pr.cache_read_price > 0 OR pr.cache_write_price > 0)
    LIMIT p_limit
  ),
  upd AS (
    UPDATE tokend_usage_events e SET
      input_cost       = b.ic,
      output_cost      = b.oc,
      reasoning_cost   = b.rc,
      cache_read_cost  = b.crc,
      cache_write_cost = b.cwc,
      total_cost       = b.ic + b.oc + b.rc + b.crc + b.cwc
    FROM batch b
    WHERE e.ctid = b.row_id
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_repriced FROM upd;

  RETURN json_build_object('ok', true, 'repriced', v_repriced);
END;
$$;

-- 1d. sessions 成本聚合重算（回填全部完成后执行一次）
CREATE OR REPLACE FUNCTION tokend_rebuild_session_costs()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_sessions INTEGER;
BEGIN
  WITH agg AS (
    SELECT member_code, session_id, SUM(total_cost)::REAL AS cost
    FROM tokend_usage_events
    GROUP BY member_code, session_id
  ),
  upd_s AS (
    UPDATE tokend_sessions s
    SET total_cost = agg.cost, updated_at = now()
    FROM agg
    WHERE s.member_code = agg.member_code
      AND s.session_id  = agg.session_id
      AND s.total_cost IS DISTINCT FROM agg.cost
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_sessions FROM upd_s;

  RETURN json_build_object('ok', true, 'sessions_updated', v_sessions);
END;
$$;

-- ============================================================
-- PART 2（STEP 2 单独执行）：临时部分索引，加速分批扫描
-- 回填完的行自动移出索引，批次越跑越快
-- ============================================================
-- CREATE INDEX IF NOT EXISTS idx_usage_events_zero_cost
--   ON tokend_usage_events (model)
--   WHERE total_cost = 0 AND total_tokens > 0;

-- ============================================================
-- PART 3（STEP 3 反复执行，直到 repriced = 0）
-- ============================================================
-- SELECT tokend_backfill_zero_costs_batch(50000);

-- ============================================================
-- PART 4（STEP 4 依次执行）
-- ============================================================
-- SELECT tokend_rebuild_session_costs();
-- DROP INDEX IF EXISTS idx_usage_events_zero_cost;
