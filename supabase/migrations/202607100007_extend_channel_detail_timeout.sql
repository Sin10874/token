-- Forward-only production runtime budget for the four-scan channel detail RPC.
-- The active pricing view adds audited revision resolution and the measured
-- production request needs about 3.7 seconds, beyond the role's 3 second
-- default. Bound this one exception to the same 8 second operational ceiling.

SET lock_timeout = '2s';

ALTER FUNCTION public.tokend_get_channel_detail_v3(TEXT, TEXT, TEXT, TEXT)
  SET statement_timeout = '8s';

RESET lock_timeout;
NOTIFY pgrst, 'reload schema';
