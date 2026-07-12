-- A five-sample production REST gate showed one 25-second cancellation while
-- the other administrative preflight calls completed. Keep the exemption
-- function-scoped and below Supabase's 60-second Client API ceiling.

SET lock_timeout = '2s';

ALTER FUNCTION public.tokend_pricing_preflight()
  SET statement_timeout = '40s';

RESET lock_timeout;
NOTIFY pgrst, 'reload schema';
