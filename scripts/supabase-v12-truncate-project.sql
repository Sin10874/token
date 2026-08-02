-- v12: 修复超长 project 导致的同步失败
--
-- 背景：codex 渠道把会话 title 当 project 上传，某些 codex 会话的
-- title 是整段 agent history prompt（实测最长 46KB），超过 Postgres
-- B-tree 单索引行 8191 字节上限，tokend_upload_events 整批失败：
--   "index row requires 9208 bytes, maximum size is 8191"
-- 且 sync.ts 抛错中止 → 受影响用户的同步从出现超长会话起一直断流。
--
-- 修复：入库时 LEFT(project, 256) 截断；agent/session_key/model/
-- channel/stop_reason 做 512 防御性截断（id/session_id 是语义键不动）。
-- CLI 端 2.3.1 同步修复（stripEvent 截断），本 SQL 兜底未升级用户。
--
-- 基于 v10 版本重写（保留入库兜底计价逻辑）。

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
      LEFT(d.x->>'sessionKey', 512),
      LEFT(d.x->>'agent', 512),
      LEFT(d.x->>'provider', 512),
      LEFT(d.x->>'model', 512),
      LEFT(COALESCE(d.x->>'channel', 'unknown'), 512),
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
      LEFT(d.x->>'stopReason', 512),
      LEFT(d.x->>'project', 256)
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
