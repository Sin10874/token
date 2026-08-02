-- Pre-v15 helper. Run this file as a standalone statement stream; never wrap it
-- in BEGIN/COMMIT because CREATE INDEX CONCURRENTLY rejects transaction blocks.
--
-- A valid same-name index makes this retry-safe. An invalid/unready same-name
-- index raises before IF NOT EXISTS can silently skip it; run the cleanup script
-- before retrying. v15 rollback does not remove this independent performance index.

SELECT current_setting('tokend.v15_invalid_backfill_candidate_index')
WHERE EXISTS (
  SELECT 1
  FROM pg_class AS index_class
  JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_class.relnamespace
  JOIN pg_index AS index_meta ON index_meta.indexrelid = index_class.oid
  WHERE index_namespace.nspname = 'public'
    AND index_class.relname = 'idx_tokend_usage_events_v15_backfill_candidates'
    AND (NOT index_meta.indisvalid OR NOT index_meta.indisready)
);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tokend_usage_events_v15_backfill_candidates
  ON public.tokend_usage_events (timestamp_ms, id, member_code)
  WHERE total_cost = 0
    AND total_tokens > 0
    AND model IN (
      'claude-opus-5',
      'claude-sonnet-5',
      'kimi-k2.7-code',
      'kimi-k3',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'mimo-v2.5',
      'mimo-v2.5-pro',
      'deepseek-chat',
      'deepseek-reasoner',
      'mimo-v2-flash',
      'mimo-v2-omni',
      'mimo-v2-pro'
    );
