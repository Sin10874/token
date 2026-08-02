-- v13: 修复 summary / daily_trend RPC 在 7d/30d 大数据量下 statement timeout (57014)
--
-- 背景：大规模回填后单 member 的 usage_events 行数暴涨（实测单 member 30d
-- 可见行 55,230、单日峰值 7,152 calls）。summary_v4 做 6 次全窗口扫描 +
-- 2 处 per-row 相关 EXISTS，7d 就翻越 ~4-5s 的 statement_timeout 被掐断，
-- 30d 稳定超时。前端 Promise.all 遇超时整批失败 → 仪表盘不刷新/白屏。
-- 单次扫描类 RPC（daily_trend/top_projects/channel_breakdown）7d 全部 3s 内通过，
-- 印证瓶颈是"扫描次数 × 宽行 heap fetch"，不是基表本身。
--
-- 两步，按顺序执行：
--   STEP 1（秒级，零风险，立刻止白屏）：抬高这两个 RPC 的单函数 statement_timeout，
--          让 30d 即使慢也能返回，而不是被掐断。ALTER FUNCTION 不重定义函数体。
--   STEP 2（治本提速）：建 covering index，让全窗口扫描走 index-only scan，
--          砍掉宽行 heap fetch。建完 ANALYZE。
--
-- 执行后用文末查询复核。

-- ============================================================
-- STEP 1：单函数 statement_timeout 兜底（先跑，立刻止超时白屏）
-- ============================================================
ALTER FUNCTION tokend_get_summary_v4(text, text, text)     SET statement_timeout = '30s';
ALTER FUNCTION tokend_get_daily_trend_v4(text, text, text) SET statement_timeout = '30s';
-- fallback 链上的旧版也一起兜底（存在才生效，不存在报错可忽略该行）
ALTER FUNCTION tokend_get_summary_v2(text, text)           SET statement_timeout = '30s';

-- ============================================================
-- STEP 2：covering index（治本提速）
-- INCLUDE 覆盖 summary_v4 聚合用到的全部列 → index-only scan，免回宽行 heap
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_usage_events_summary_covering
  ON tokend_usage_events (member_code, timestamp_ms)
  INCLUDE (input_tokens, output_tokens, cache_read_tokens,
           input_cost, output_cost, cache_read_cost,
           session_id, channel, session_key, model, agent, project);

ANALYZE tokend_usage_events;

-- 若 STEP 2 在 SQL Editor 报网关超时（大表建索引慢）：
--   去 Supabase Dashboard → Database → Indexes 用 UI 建同名索引，
--   或改用 CREATE INDEX CONCURRENTLY（不锁写入、更慢、需单独一条执行）。

-- ============================================================
-- 复核：建完后在 SQL Editor 跑，确认计划走 index-only scan（把 <CODE> 换成任一 member_code）
-- ============================================================
-- EXPLAIN (ANALYZE, BUFFERS)
-- SELECT SUM(input_tokens), SUM(output_tokens), COUNT(DISTINCT session_id)
-- FROM tokend_usage_events
-- WHERE member_code = '<CODE>' AND timestamp_ms >= (EXTRACT(EPOCH FROM now() - INTERVAL '30 days')*1000)::bigint;
