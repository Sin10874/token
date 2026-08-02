BEGIN IMMEDIATE;

UPDATE usage_events AS event
SET
  input_cost = backfill.previous_input_cost,
  output_cost = backfill.previous_output_cost,
  reasoning_cost = backfill.previous_reasoning_cost,
  cache_read_cost = backfill.previous_cache_read_cost,
  cache_write_cost = backfill.previous_cache_write_cost,
  total_cost = backfill.previous_total_cost
FROM model_price_backfills AS backfill
WHERE backfill.event_id = event.id
  AND backfill.migration_id = '202608020001_model_price_versions';

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

DELETE FROM model_prices
WHERE model_id IN (
  'claude-opus-5',
  'claude-sonnet-5',
  'kimi-k2.7-code',
  'kimi-k3',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'mimo-v2.5',
  'mimo-v2.5-pro'
)
AND source IN (
  'https://platform.claude.com/docs/en/about-claude/pricing',
  'https://platform.kimi.ai/docs/pricing/chat-k27-code.md',
  'https://platform.kimi.ai/docs/pricing/chat-k3.md',
  'https://api-docs.deepseek.com/quick_start/pricing',
  'https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go'
);

DROP TABLE IF EXISTS model_price_versions;
DROP TABLE IF EXISTS model_price_backfills;

COMMIT;
