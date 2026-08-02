-- Independent cleanup for the pre-v15 concurrent candidate index.
-- Run standalone; v15 rollback intentionally does not drop this index.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_tokend_usage_events_v15_backfill_candidates;
