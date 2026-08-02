-- v15: 新模型有效期价格 + 上传端零成本兜底
--
-- 执行顺序：
--   1. 整段执行本文件（表、目录、上传 RPC、回填 RPC）。
--   2. 反复执行 SELECT tokend_backfill_versioned_model_costs_batch(20000);
--      直到 repriced = 0。
--   3. 执行 SELECT tokend_rebuild_session_costs();
--
-- 本文件基于 v12 的 tokend_upload_events，保留 project/字段截断。
-- 不会覆盖客户端已报告的非零成本。Kimi 的 cache-miss input 不能映射为
-- Anthropic cache-write；含 cacheWriteTokens 的 Kimi 事件保持未计价。

BEGIN;

CREATE TABLE IF NOT EXISTS tokend_model_price_versions (
  model_id          TEXT        NOT NULL,
  provider          TEXT        NOT NULL,
  valid_from_ms     BIGINT      NOT NULL,
  valid_to_ms       BIGINT,
  input_price       REAL        NOT NULL,
  output_price      REAL        NOT NULL,
  cache_read_price  REAL        NOT NULL,
  cache_write_price REAL,
  per_tokens        BIGINT      NOT NULL DEFAULT 1000000,
  cache_semantics   TEXT        NOT NULL CHECK (cache_semantics IN ('anthropic', 'hit_miss', 'generic')),
  context_window    BIGINT,
  source_url        TEXT        NOT NULL,
  source_checked_at DATE        NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, valid_from_ms),
  CHECK (valid_to_ms IS NULL OR valid_to_ms > valid_from_ms)
);

ALTER TABLE tokend_model_price_versions ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_tokend_model_price_versions_lookup
  ON tokend_model_price_versions(model_id, valid_from_ms, valid_to_ms);

CREATE TABLE IF NOT EXISTS tokend_model_price_backfills (
  event_id                  TEXT        NOT NULL,
  member_code               TEXT        NOT NULL,
  migration_id              TEXT        NOT NULL,
  previous_input_cost       REAL        NOT NULL,
  previous_output_cost      REAL        NOT NULL,
  previous_reasoning_cost   REAL        NOT NULL,
  previous_cache_read_cost  REAL        NOT NULL,
  previous_cache_write_cost REAL        NOT NULL,
  previous_total_cost       REAL        NOT NULL,
  backfilled_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, member_code, migration_id)
);

ALTER TABLE tokend_model_price_backfills ENABLE ROW LEVEL SECURITY;

INSERT INTO tokend_model_price_versions (
  model_id, provider, valid_from_ms, valid_to_ms,
  input_price, output_price, cache_read_price, cache_write_price,
  cache_semantics, context_window, source_url, source_checked_at
) VALUES
  (
    'claude-opus-5', 'anthropic', 1784851200000, NULL,
    5, 25, 0.5, 6.25, 'anthropic', 1000000,
    'https://platform.claude.com/docs/en/about-claude/pricing', DATE '2026-08-02'
  ),
  (
    'claude-sonnet-5', 'anthropic', 1782777600000, 1788220800000,
    2, 10, 0.2, 2.5, 'anthropic', 1000000,
    'https://platform.claude.com/docs/en/about-claude/pricing', DATE '2026-08-02'
  ),
  (
    'claude-sonnet-5', 'anthropic', 1788220800000, NULL,
    3, 15, 0.3, 3.75, 'anthropic', 1000000,
    'https://platform.claude.com/docs/en/about-claude/pricing', DATE '2026-08-02'
  ),
  (
    'kimi-k2.7-code', 'moonshot', 1781222400000, NULL,
    0.95, 4, 0.19, NULL, 'hit_miss', 262144,
    'https://platform.kimi.ai/docs/pricing/chat-k27-code.md', DATE '2026-08-02'
  ),
  (
    'kimi-k3', 'moonshot', 1784160000000, NULL,
    3, 15, 0.3, NULL, 'hit_miss', 1048576,
    'https://platform.kimi.ai/docs/pricing/chat-k3.md', DATE '2026-08-02'
  )
ON CONFLICT (model_id, valid_from_ms) DO UPDATE SET
  provider = EXCLUDED.provider,
  valid_to_ms = EXCLUDED.valid_to_ms,
  input_price = EXCLUDED.input_price,
  output_price = EXCLUDED.output_price,
  cache_read_price = EXCLUDED.cache_read_price,
  cache_write_price = EXCLUDED.cache_write_price,
  per_tokens = EXCLUDED.per_tokens,
  cache_semantics = EXCLUDED.cache_semantics,
  context_window = EXCLUDED.context_window,
  source_url = EXCLUDED.source_url,
  source_checked_at = EXCLUDED.source_checked_at,
  updated_at = now();

-- 保持旧客户端读取 flat catalog 的兼容性；Sonnet 5 只暴露部署时生效区间。
INSERT INTO tokend_model_prices
  (model_id, provider, input_price, output_price, cache_read_price, cache_write_price, per_tokens)
VALUES
  ('claude-opus-5', 'anthropic', 5, 25, 0.5, 6.25, 1000000),
  (
    'claude-sonnet-5', 'anthropic',
    CASE WHEN extract(epoch FROM now()) * 1000 < 1788220800000 THEN 2 ELSE 3 END,
    CASE WHEN extract(epoch FROM now()) * 1000 < 1788220800000 THEN 10 ELSE 15 END,
    CASE WHEN extract(epoch FROM now()) * 1000 < 1788220800000 THEN 0.2 ELSE 0.3 END,
    CASE WHEN extract(epoch FROM now()) * 1000 < 1788220800000 THEN 2.5 ELSE 3.75 END,
    1000000
  ),
  ('kimi-k2.7-code', 'moonshot', 0.95, 4, 0.19, 0, 1000000),
  ('kimi-k3', 'moonshot', 3, 15, 0.3, 0, 1000000),
  ('deepseek-v4-flash', 'deepseek', 0.14, 0.28, 0.0028, 0, 1000000),
  ('deepseek-v4-pro', 'deepseek', 0.435, 0.87, 0.003625, 0, 1000000),
  ('mimo-v2.5', 'xiaomi', 0.14, 0.28, 0.0028, 0, 1000000),
  ('mimo-v2.5-pro', 'xiaomi', 0.435, 0.87, 0.0036, 0, 1000000),
  ('MiniMax-M2.7-highspeed', 'minimax', 0.6, 2.4, 0.06, 0.375, 1000000),
  ('MiniMax-M2.5', 'minimax', 0.3, 1.2, 0.03, 0.375, 1000000),
  ('MiniMax-M2.5-highspeed', 'minimax', 0.6, 2.4, 0.03, 0.375, 1000000)
ON CONFLICT (model_id) DO UPDATE SET
  provider = EXCLUDED.provider,
  input_price = EXCLUDED.input_price,
  output_price = EXCLUDED.output_price,
  cache_read_price = EXCLUDED.cache_read_price,
  cache_write_price = EXCLUDED.cache_write_price,
  per_tokens = EXCLUDED.per_tokens,
  updated_at = now();

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

  WITH alias_map(raw_model, canonical_model) AS (
    VALUES
      ('k2p5', 'kimi-k2.5'),
      ('kimi-code/kimi-for-coding', 'kimi-k2.5'),
      ('kimi-for-coding', 'kimi-k2.5'),
      ('kimi-k2-thinking', 'kimi-k2.5'),
      ('deepseek-chat', 'deepseek-v4-flash'),
      ('deepseek-reasoner', 'deepseek-v4-flash'),
      ('mimo-v2-flash', 'mimo-v2.5'),
      ('mimo-v2-omni', 'mimo-v2.5'),
      ('mimo-v2-pro', 'mimo-v2.5-pro'),
      ('GLM-5.2', 'glm-5.2'),
      ('GLM-5.1', 'glm-5.1'),
      ('GLM-5-Turbo', 'glm-5-turbo'),
      ('GLM-5', 'glm-5'),
      ('GLM-4.7', 'glm-4.7'),
      ('GLM-4.5-Air', 'glm-4.5-air'),
      ('Pro/zai-org/GLM-5', 'glm-5'),
      ('zhanlu/glm-4.7', 'glm-4.7'),
      ('Pro/MiniMaxAI/MiniMax-M2.5', 'MiniMax-M2.5'),
      ('minimax-m2.5', 'MiniMax-M2.5'),
      ('minimax-m2.5-highspeed', 'MiniMax-M2.5-highspeed'),
      ('minimax-m2.7', 'MiniMax-M2.7'),
      ('minimax-m2.7-highspeed', 'MiniMax-M2.7-highspeed'),
      ('zhanlu/minimax-2.7', 'MiniMax-M2.7'),
      ('M-3', 'MiniMax-M3'),
      ('M-2.7', 'MiniMax-M2.7')
  ),
  deduped AS (
    SELECT DISTINCT ON (x->>'id') x
    FROM jsonb_array_elements(p_events) AS x
    ORDER BY x->>'id'
  ),
  normalized AS (
    SELECT d.x, COALESCE(alias_map.canonical_model, d.x->>'model') AS model_id
    FROM deduped d
    LEFT JOIN alias_map ON alias_map.raw_model = d.x->>'model'
  ),
  enriched AS (
    SELECT n.x, n.model_id,
      (COALESCE((n.x->>'totalCost')::REAL, 0) = 0
        AND COALESCE((n.x->>'totalTokens')::INTEGER, 0) > 0
        AND price.model_id IS NOT NULL
        AND NOT (
          price.cache_semantics = 'hit_miss'
          AND COALESCE((n.x->>'cacheWriteTokens')::INTEGER, 0) <> 0
        )
        AND NOT (
          price.cache_write_price IS NULL
          AND COALESCE((n.x->>'cacheWriteTokens')::INTEGER, 0) <> 0
        )) AS reprice,
      price.input_price, price.output_price, price.cache_read_price,
      price.cache_write_price, price.per_tokens
    FROM normalized n
    LEFT JOIN LATERAL (
      SELECT resolved.*
      FROM (
        SELECT
          version.model_id, version.input_price, version.output_price,
          version.cache_read_price, version.cache_write_price,
          version.per_tokens, version.cache_semantics, 0 AS priority
        FROM tokend_model_price_versions AS version
        WHERE version.model_id = n.model_id
          AND COALESCE((n.x->>'timestampMs')::BIGINT, 0) >= version.valid_from_ms
          AND (version.valid_to_ms IS NULL
            OR COALESCE((n.x->>'timestampMs')::BIGINT, 0) < version.valid_to_ms)

        UNION ALL

        SELECT
          flat.model_id, flat.input_price, flat.output_price,
          flat.cache_read_price, flat.cache_write_price,
          flat.per_tokens,
          CASE WHEN flat.provider = 'moonshot' THEN 'hit_miss' ELSE 'generic' END,
          1 AS priority
        FROM tokend_model_prices AS flat
        WHERE NOT EXISTS (
            SELECT 1 FROM tokend_model_price_versions AS known
            WHERE known.model_id = n.model_id
          )
          AND (
            flat.model_id = n.model_id
            OR (
              n.model_id ~ '-\d{8,}$'
              AND flat.model_id = regexp_replace(n.model_id, '-\d{8,}$', '')
              AND NOT EXISTS (
                SELECT 1 FROM tokend_model_price_versions AS canonical
                WHERE canonical.model_id = regexp_replace(n.model_id, '-\d{8,}$', '')
              )
            )
          )
      ) AS resolved
      ORDER BY resolved.priority
      LIMIT 1
    ) AS price ON TRUE
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
      LEFT(d.model_id, 512),
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
        THEN COALESCE((d.x->>'cacheWriteTokens')::INTEGER, 0) * COALESCE(d.cache_write_price, 0) / d.per_tokens
        ELSE COALESCE((d.x->>'cacheWriteCost')::REAL, 0) END,
      CASE WHEN d.reprice
        THEN (
          COALESCE((d.x->>'inputTokens')::INTEGER, 0) * d.input_price
          + COALESCE((d.x->>'outputTokens')::INTEGER, 0) * d.output_price
          + COALESCE((d.x->>'reasoningTokens')::INTEGER, 0) * d.output_price
          + COALESCE((d.x->>'cacheReadTokens')::INTEGER, 0) * d.cache_read_price
          + COALESCE((d.x->>'cacheWriteTokens')::INTEGER, 0) * COALESCE(d.cache_write_price, 0)
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
    parser_version = EXCLUDED.parser_version,
    last_sync_at = now();

  RETURN json_build_object('ok', true, 'inserted', v_count);
END;
$$;

CREATE OR REPLACE FUNCTION tokend_backfill_versioned_model_costs_batch(p_limit INTEGER DEFAULT 20000)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_repriced INTEGER;
BEGIN
  WITH alias_map(raw_model, canonical_model) AS (
    VALUES
      ('k2p5', 'kimi-k2.5'),
      ('kimi-code/kimi-for-coding', 'kimi-k2.5'),
      ('kimi-for-coding', 'kimi-k2.5'),
      ('kimi-k2-thinking', 'kimi-k2.5'),
      ('deepseek-chat', 'deepseek-v4-flash'),
      ('deepseek-reasoner', 'deepseek-v4-flash'),
      ('mimo-v2-flash', 'mimo-v2.5'),
      ('mimo-v2-omni', 'mimo-v2.5'),
      ('mimo-v2-pro', 'mimo-v2.5-pro'),
      ('GLM-5.2', 'glm-5.2'),
      ('GLM-5.1', 'glm-5.1'),
      ('GLM-5-Turbo', 'glm-5-turbo'),
      ('GLM-5', 'glm-5'),
      ('GLM-4.7', 'glm-4.7'),
      ('GLM-4.5-Air', 'glm-4.5-air'),
      ('Pro/zai-org/GLM-5', 'glm-5'),
      ('zhanlu/glm-4.7', 'glm-4.7'),
      ('Pro/MiniMaxAI/MiniMax-M2.5', 'MiniMax-M2.5'),
      ('minimax-m2.5', 'MiniMax-M2.5'),
      ('minimax-m2.5-highspeed', 'MiniMax-M2.5-highspeed'),
      ('minimax-m2.7', 'MiniMax-M2.7'),
      ('minimax-m2.7-highspeed', 'MiniMax-M2.7-highspeed'),
      ('zhanlu/minimax-2.7', 'MiniMax-M2.7'),
      ('M-3', 'MiniMax-M3'),
      ('M-2.7', 'MiniMax-M2.7')
  ),
  candidates AS (
    SELECT
      event.id,
      event.member_code,
      event.input_cost,
      event.output_cost,
      event.reasoning_cost,
      event.cache_read_cost,
      event.cache_write_cost,
      event.total_cost,
      event.input_tokens * price.input_price / price.per_tokens AS next_input_cost,
      event.output_tokens * price.output_price / price.per_tokens AS next_output_cost,
      event.reasoning_tokens * price.output_price / price.per_tokens AS next_reasoning_cost,
      event.cache_read_tokens * price.cache_read_price / price.per_tokens AS next_cache_read_cost,
      event.cache_write_tokens * COALESCE(price.cache_write_price, 0) / price.per_tokens AS next_cache_write_cost
    FROM tokend_usage_events AS event
    LEFT JOIN alias_map ON alias_map.raw_model = event.model
    JOIN tokend_model_price_versions AS price
      ON price.model_id = COALESCE(alias_map.canonical_model, event.model)
      AND event.timestamp_ms >= price.valid_from_ms
      AND (price.valid_to_ms IS NULL OR event.timestamp_ms < price.valid_to_ms)
    WHERE event.total_cost = 0
      AND event.total_tokens > 0
      AND NOT (price.cache_semantics = 'hit_miss' AND event.cache_write_tokens <> 0)
      AND NOT (price.cache_write_price IS NULL AND event.cache_write_tokens <> 0)
    ORDER BY event.timestamp_ms, event.id, event.member_code
    LIMIT p_limit
  ),
  audited AS (
    INSERT INTO tokend_model_price_backfills (
      event_id, member_code, migration_id,
      previous_input_cost, previous_output_cost, previous_reasoning_cost,
      previous_cache_read_cost, previous_cache_write_cost, previous_total_cost
    )
    SELECT
      candidate.id, candidate.member_code, '202608020001_versioned_model_prices',
      candidate.input_cost, candidate.output_cost, candidate.reasoning_cost,
      candidate.cache_read_cost, candidate.cache_write_cost, candidate.total_cost
    FROM candidates AS candidate
    ON CONFLICT (event_id, member_code, migration_id) DO NOTHING
    RETURNING event_id, member_code
  ),
  updated AS (
    UPDATE tokend_usage_events AS event
    SET
      input_cost = candidate.next_input_cost,
      output_cost = candidate.next_output_cost,
      reasoning_cost = candidate.next_reasoning_cost,
      cache_read_cost = candidate.next_cache_read_cost,
      cache_write_cost = candidate.next_cache_write_cost,
      total_cost = candidate.next_input_cost + candidate.next_output_cost
        + candidate.next_reasoning_cost + candidate.next_cache_read_cost
        + candidate.next_cache_write_cost
    FROM candidates AS candidate
    JOIN audited
      ON audited.event_id = candidate.id
      AND audited.member_code = candidate.member_code
    WHERE event.id = candidate.id
      AND event.member_code = candidate.member_code
      AND event.total_cost = candidate.total_cost
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_repriced FROM updated;

  RETURN json_build_object('ok', true, 'repriced', v_repriced);
END;
$$;

COMMIT;
