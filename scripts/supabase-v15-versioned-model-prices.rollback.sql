-- v15 rollback
-- 前置：先重新执行 scripts/supabase-v12-truncate-project.sql，恢复旧上传 RPC。
-- 本文件只恢复 v15 审计记录过的成本，不触碰客户端原本报告的成本。

BEGIN;

UPDATE tokend_usage_events AS event
SET
  input_cost = audit.previous_input_cost,
  output_cost = audit.previous_output_cost,
  reasoning_cost = audit.previous_reasoning_cost,
  cache_read_cost = audit.previous_cache_read_cost,
  cache_write_cost = audit.previous_cache_write_cost,
  total_cost = audit.previous_total_cost
FROM tokend_model_price_backfills AS audit
WHERE audit.event_id = event.id
  AND audit.member_code = event.member_code
  AND audit.migration_id = '202608020001_versioned_model_prices';

INSERT INTO tokend_model_prices (
  model_id, provider, input_price, output_price,
  cache_read_price, cache_write_price, per_tokens, updated_at
)
SELECT
  snapshot.model_id,
  snapshot.provider,
  snapshot.input_price,
  snapshot.output_price,
  snapshot.cache_read_price,
  snapshot.cache_write_price,
  snapshot.per_tokens,
  snapshot.updated_at
FROM tokend_model_prices_pre_v15 AS snapshot
ON CONFLICT (model_id) DO UPDATE SET
  provider          = EXCLUDED.provider,
  input_price       = EXCLUDED.input_price,
  output_price      = EXCLUDED.output_price,
  cache_read_price  = EXCLUDED.cache_read_price,
  cache_write_price = EXCLUDED.cache_write_price,
  per_tokens        = EXCLUDED.per_tokens,
  updated_at        = EXCLUDED.updated_at;

DELETE FROM tokend_model_prices
WHERE model_id IN (
  'claude-opus-5',
  'claude-sonnet-5',
  'kimi-k2.7-code',
  'kimi-k3',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'mimo-v2.5',
  'mimo-v2.5-pro',
  'MiniMax-M2.7-highspeed',
  'MiniMax-M2.5',
  'MiniMax-M2.5-highspeed'
)
AND NOT EXISTS (
  SELECT 1
  FROM tokend_model_prices_pre_v15 AS snapshot
  WHERE snapshot.model_id = tokend_model_prices.model_id
);

DELETE FROM tokend_model_prices
WHERE model_id = 'MiniMax-M2.5-highspeed';

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

ALTER FUNCTION tokend_upload_events(TEXT, JSONB, JSONB)
  OWNER TO postgres;

ALTER FUNCTION tokend_upload_events(TEXT, JSONB, JSONB)
  SET search_path TO public, pg_temp;

DROP FUNCTION IF EXISTS tokend_backfill_versioned_model_costs_batch(INTEGER);
DROP TABLE IF EXISTS tokend_model_price_versions;
DROP TABLE IF EXISTS tokend_model_price_backfills;
DROP TABLE IF EXISTS tokend_model_prices_pre_v15;

COMMIT;

-- 成本恢复后执行：SELECT tokend_rebuild_session_costs();
