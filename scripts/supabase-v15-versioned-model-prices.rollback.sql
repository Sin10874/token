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

DELETE FROM tokend_model_prices
WHERE model_id IN ('claude-opus-5', 'claude-sonnet-5', 'kimi-k2.7-code', 'kimi-k3');

DROP FUNCTION IF EXISTS tokend_backfill_versioned_model_costs_batch(INTEGER);
DROP TABLE IF EXISTS tokend_model_price_versions;
DROP TABLE IF EXISTS tokend_model_price_backfills;

COMMIT;

-- 成本恢复后执行：SELECT tokend_rebuild_session_costs();
