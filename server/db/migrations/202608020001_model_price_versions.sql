BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS model_price_versions (
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  valid_from_ms INTEGER NOT NULL,
  valid_to_ms INTEGER,
  input_price REAL NOT NULL,
  output_price REAL NOT NULL,
  cache_read_price REAL NOT NULL,
  cache_write_price REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  per_tokens INTEGER NOT NULL DEFAULT 1000000,
  cache_semantics TEXT NOT NULL CHECK (cache_semantics IN ('anthropic', 'hit_miss', 'generic')),
  context_window INTEGER,
  source_url TEXT NOT NULL,
  source_checked_at TEXT NOT NULL,
  PRIMARY KEY (model_id, valid_from_ms),
  CHECK (valid_to_ms IS NULL OR valid_to_ms > valid_from_ms)
);

CREATE INDEX IF NOT EXISTS idx_model_price_versions_lookup
  ON model_price_versions(model_id, valid_from_ms, valid_to_ms);

CREATE TABLE IF NOT EXISTS model_price_backfills (
  event_id TEXT PRIMARY KEY REFERENCES usage_events(id) ON DELETE CASCADE,
  migration_id TEXT NOT NULL,
  previous_input_cost REAL NOT NULL,
  previous_output_cost REAL NOT NULL,
  previous_reasoning_cost REAL NOT NULL,
  previous_cache_read_cost REAL NOT NULL,
  previous_cache_write_cost REAL NOT NULL,
  previous_total_cost REAL NOT NULL,
  backfilled_at INTEGER NOT NULL
);

INSERT INTO model_price_versions (
  model_id, provider, valid_from_ms, valid_to_ms,
  input_price, output_price, cache_read_price, cache_write_price,
  cache_semantics, context_window, source_url, source_checked_at
) VALUES
  (
    'deepseek-v4-flash', 'deepseek', 1776988800000, NULL,
    0.14, 0.28, 0.0028, NULL,
    'hit_miss', 1000000,
    'https://api-docs.deepseek.com/quick_start/pricing', '2026-08-02'
  ),
  (
    'deepseek-v4-pro', 'deepseek', 1776988800000, NULL,
    0.435, 0.87, 0.003625, NULL,
    'hit_miss', 1000000,
    'https://api-docs.deepseek.com/quick_start/pricing', '2026-08-02'
  ),
  (
    'mimo-v2.5', 'xiaomi', 1779811200000, NULL,
    0.14, 0.28, 0.0028, NULL,
    'hit_miss', 1000000,
    'https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go', '2026-08-02'
  ),
  (
    'mimo-v2.5-pro', 'xiaomi', 1779811200000, NULL,
    0.435, 0.87, 0.0036, NULL,
    'hit_miss', 1000000,
    'https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go', '2026-08-02'
  ),
  (
    'claude-opus-5', 'anthropic', 1784851200000, NULL,
    5, 25, 0.5, 6.25,
    'anthropic', 1000000,
    'https://platform.claude.com/docs/en/about-claude/pricing', '2026-08-02'
  ),
  (
    'claude-sonnet-5', 'anthropic', 1782777600000, 1788220800000,
    2, 10, 0.2, 2.5,
    'anthropic', 1000000,
    'https://platform.claude.com/docs/en/about-claude/pricing', '2026-08-02'
  ),
  (
    'claude-sonnet-5', 'anthropic', 1788220800000, NULL,
    3, 15, 0.3, 3.75,
    'anthropic', 1000000,
    'https://platform.claude.com/docs/en/about-claude/pricing', '2026-08-02'
  ),
  (
    'kimi-k2.7-code', 'moonshot', 1781222400000, NULL,
    0.95, 4, 0.19, NULL,
    'hit_miss', 262144,
    'https://platform.kimi.ai/docs/pricing/chat-k27-code.md', '2026-08-02'
  ),
  (
    'kimi-k3', 'moonshot', 1784160000000, NULL,
    3, 15, 0.3, NULL,
    'hit_miss', 1048576,
    'https://platform.kimi.ai/docs/pricing/chat-k3.md', '2026-08-02'
  )
ON CONFLICT(model_id, valid_from_ms) DO UPDATE SET
  provider = excluded.provider,
  valid_to_ms = excluded.valid_to_ms,
  input_price = excluded.input_price,
  output_price = excluded.output_price,
  cache_read_price = excluded.cache_read_price,
  cache_write_price = excluded.cache_write_price,
  currency = excluded.currency,
  per_tokens = excluded.per_tokens,
  cache_semantics = excluded.cache_semantics,
  context_window = excluded.context_window,
  source_url = excluded.source_url,
  source_checked_at = excluded.source_checked_at;

INSERT INTO model_prices (
  model_id, provider, input_price, output_price, cache_read_price,
  cache_write_price, currency, per_tokens, source, updated_at
) VALUES
  (
    'claude-opus-5', 'anthropic', 5, 25, 0.5, 6.25,
    'USD', 1000000,
    'https://platform.claude.com/docs/en/about-claude/pricing',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  (
    'claude-sonnet-5', 'anthropic',
    CASE WHEN CAST(strftime('%s', 'now') AS INTEGER) * 1000 < 1788220800000 THEN 2 ELSE 3 END,
    CASE WHEN CAST(strftime('%s', 'now') AS INTEGER) * 1000 < 1788220800000 THEN 10 ELSE 15 END,
    CASE WHEN CAST(strftime('%s', 'now') AS INTEGER) * 1000 < 1788220800000 THEN 0.2 ELSE 0.3 END,
    CASE WHEN CAST(strftime('%s', 'now') AS INTEGER) * 1000 < 1788220800000 THEN 2.5 ELSE 3.75 END,
    'USD', 1000000,
    'https://platform.claude.com/docs/en/about-claude/pricing',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  (
    'kimi-k2.7-code', 'moonshot', 0.95, 4, 0.19, 0,
    'USD', 1000000,
    'https://platform.kimi.ai/docs/pricing/chat-k27-code.md',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  (
    'kimi-k3', 'moonshot', 3, 15, 0.3, 0,
    'USD', 1000000,
    'https://platform.kimi.ai/docs/pricing/chat-k3.md',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  (
    'deepseek-v4-flash', 'deepseek', 0.14, 0.28, 0.0028, 0,
    'USD', 1000000,
    'https://api-docs.deepseek.com/quick_start/pricing',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  (
    'deepseek-v4-pro', 'deepseek', 0.435, 0.87, 0.003625, 0,
    'USD', 1000000,
    'https://api-docs.deepseek.com/quick_start/pricing',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  (
    'mimo-v2.5', 'xiaomi', 0.14, 0.28, 0.0028, 0,
    'USD', 1000000,
    'https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  (
    'mimo-v2.5-pro', 'xiaomi', 0.435, 0.87, 0.0036, 0,
    'USD', 1000000,
    'https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  (
    'MiniMax-M2.7-highspeed', 'minimax', 0.6, 2.4, 0.06, 0.375,
    'USD', 1000000,
    'https://platform.minimaxi.com/docs/guides/pricing-paygo',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  (
    'MiniMax-M2.5', 'minimax', 0.3, 1.2, 0.03, 0.375,
    'USD', 1000000,
    'https://platform.minimaxi.com/docs/guides/pricing-paygo',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  (
    'MiniMax-M2.5-highspeed', 'minimax', 0.6, 2.4, 0.03, 0.375,
    'USD', 1000000,
    'https://platform.minimaxi.com/docs/guides/pricing-paygo',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  )
ON CONFLICT(model_id) DO UPDATE SET
  provider = excluded.provider,
  input_price = excluded.input_price,
  output_price = excluded.output_price,
  cache_read_price = excluded.cache_read_price,
  cache_write_price = excluded.cache_write_price,
  currency = excluded.currency,
  per_tokens = excluded.per_tokens,
  source = excluded.source,
  updated_at = excluded.updated_at
WHERE model_prices.source != 'manual';

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
normalized AS (
  SELECT
    event.*,
    COALESCE(alias_map.canonical_model, event.model) AS model_id
  FROM usage_events AS event
  LEFT JOIN alias_map
    ON alias_map.raw_model = event.model
)
INSERT OR IGNORE INTO model_price_backfills (
  event_id, migration_id,
  previous_input_cost, previous_output_cost, previous_reasoning_cost,
  previous_cache_read_cost, previous_cache_write_cost, previous_total_cost,
  backfilled_at
)
SELECT
  event.id, '202608020001_model_price_versions',
  event.input_cost, event.output_cost, event.reasoning_cost,
  event.cache_read_cost, event.cache_write_cost, event.total_cost,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM normalized AS event
JOIN model_price_versions AS price
  ON price.model_id = event.model_id
  AND event.timestamp_ms >= price.valid_from_ms
  AND (price.valid_to_ms IS NULL OR event.timestamp_ms < price.valid_to_ms)
WHERE event.total_cost = 0
  AND event.total_tokens > 0
  AND NOT (price.cache_semantics = 'hit_miss' AND event.cache_write_tokens <> 0)
  AND NOT EXISTS (
    SELECT 1 FROM model_prices AS manual
    WHERE manual.model_id = event.model_id AND manual.source = 'manual'
  );

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
)
UPDATE usage_events AS event
SET
  input_cost = (event.input_tokens * price.input_price) / price.per_tokens,
  output_cost = (event.output_tokens * price.output_price) / price.per_tokens,
  reasoning_cost = (event.reasoning_tokens * price.output_price) / price.per_tokens,
  cache_read_cost = (event.cache_read_tokens * price.cache_read_price) / price.per_tokens,
  cache_write_cost = (event.cache_write_tokens * COALESCE(price.cache_write_price, 0)) / price.per_tokens,
  total_cost = (
    (event.input_tokens * price.input_price)
    + (event.output_tokens * price.output_price)
    + (event.reasoning_tokens * price.output_price)
    + (event.cache_read_tokens * price.cache_read_price)
    + (event.cache_write_tokens * COALESCE(price.cache_write_price, 0))
  ) / price.per_tokens
FROM model_price_versions AS price, model_price_backfills AS backfill
WHERE backfill.event_id = event.id
  AND backfill.migration_id = '202608020001_model_price_versions'
  AND price.model_id = COALESCE((SELECT canonical_model FROM alias_map WHERE raw_model = event.model), event.model)
  AND event.timestamp_ms >= price.valid_from_ms
  AND (price.valid_to_ms IS NULL OR event.timestamp_ms < price.valid_to_ms)
  AND event.total_cost = backfill.previous_total_cost;

UPDATE sessions AS session
SET total_cost = (
  SELECT COALESCE(SUM(event.total_cost), 0)
  FROM usage_events AS event
  WHERE event.session_id = session.session_id
)
WHERE session.session_id IN (
  SELECT DISTINCT event.session_id
  FROM usage_events AS event
  JOIN model_price_backfills AS backfill ON backfill.event_id = event.id
  WHERE backfill.migration_id = '202608020001_model_price_versions'
);

COMMIT;
