-- Supabase PostgREST applies function proconfig before invoking an RPC. Give
-- only the service-role preflight enough time for the production-wide audit;
-- user-facing RPCs and role/global timeouts remain unchanged.

SET lock_timeout = '2s';

ALTER FUNCTION public.tokend_pricing_preflight()
  SET statement_timeout = '25s';

RESET lock_timeout;
NOTIFY pgrst, 'reload schema';
