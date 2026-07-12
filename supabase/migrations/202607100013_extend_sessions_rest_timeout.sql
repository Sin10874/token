-- The active pricing view makes the bounded sessions list slightly slower
-- than the anonymous role's three-second REST budget on production data.
-- Keep the exception scoped to this RPC and under the eight-second UI gate.

SET lock_timeout = '2s';

ALTER FUNCTION public.tokend_get_sessions_v2(TEXT, TEXT, INTEGER)
  SET statement_timeout = '8s';

RESET lock_timeout;
NOTIFY pgrst, 'reload schema';
