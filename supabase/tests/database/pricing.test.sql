CREATE EXTENSION IF NOT EXISTS pgtap;
SET search_path = public, extensions;

-- Fixture-only production-compatible objects in the ephemeral pgTAP database.
CREATE TABLE public.tokend_members (
  member_code TEXT PRIMARY KEY,
  token TEXT UNIQUE
);

CREATE TABLE public.tokend_usage_events (
  id TEXT NOT NULL,
  member_code TEXT NOT NULL REFERENCES public.tokend_members(member_code),
  timestamp_ms BIGINT NOT NULL,
  session_id TEXT NOT NULL,
  session_key TEXT,
  agent TEXT,
  provider TEXT,
  model TEXT,
  channel TEXT DEFAULT 'unknown',
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  input_cost REAL DEFAULT 0,
  output_cost REAL DEFAULT 0,
  reasoning_cost REAL DEFAULT 0,
  cache_read_cost REAL DEFAULT 0,
  cache_write_cost REAL DEFAULT 0,
  total_cost REAL DEFAULT 0,
  stop_reason TEXT,
  project TEXT,
  uploaded_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (id, member_code)
);

CREATE TABLE public.tokend_sessions (
  session_id TEXT NOT NULL,
  member_code TEXT NOT NULL REFERENCES public.tokend_members(member_code),
  PRIMARY KEY (session_id, member_code)
);

CREATE TABLE public.tokend_sync_state (
  member_code TEXT NOT NULL REFERENCES public.tokend_members(member_code),
  source_path_hash TEXT NOT NULL,
  last_processed_lines INTEGER DEFAULT 0,
  parser_version INTEGER DEFAULT 1,
  last_sync_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (member_code, source_path_hash)
);

CREATE TABLE public.tokend_model_prices (
  model_id TEXT PRIMARY KEY,
  provider TEXT,
  input_price REAL DEFAULT 0,
  output_price REAL DEFAULT 0,
  cache_read_price REAL DEFAULT 0,
  cache_write_price REAL DEFAULT 0,
  per_tokens BIGINT DEFAULT 1000000,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.tokend_message_events (
  id TEXT NOT NULL,
  member_code TEXT NOT NULL REFERENCES public.tokend_members(member_code),
  timestamp_ms BIGINT NOT NULL,
  session_id TEXT NOT NULL,
  agent TEXT,
  channel TEXT DEFAULT 'unknown',
  kind TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (id, member_code)
);

\ir ../../migrations/202607100001_pricing_core.sql
\ir ../../migrations/202607100001_pricing_core.sql
\ir ../../migrations/202607100002_pricing_upload.sql
\ir ../../migrations/202607100002_pricing_upload.sql

-- Production already has these legacy RPCs. Minimal fixtures let this isolated
-- database prove that the additive vNext migration preserves their identities.
CREATE FUNCTION public.tokend_get_summary_v4(TEXT, TEXT, TEXT) RETURNS JSON
LANGUAGE SQL AS $$ SELECT '{"ok":true}'::JSON $$;
CREATE FUNCTION public.tokend_get_daily_trend_v4(TEXT, TEXT, TEXT) RETURNS JSON
LANGUAGE SQL AS $$ SELECT '{"ok":true}'::JSON $$;
CREATE FUNCTION public.tokend_get_model_breakdown_v2(TEXT, TEXT) RETURNS JSON
LANGUAGE SQL AS $$ SELECT '{"ok":true}'::JSON $$;
CREATE FUNCTION public.tokend_get_model_detail(TEXT, TEXT, TEXT) RETURNS JSON
LANGUAGE SQL AS $$ SELECT '{"ok":true}'::JSON $$;
CREATE FUNCTION public.tokend_get_channel_breakdown_v3(TEXT, TEXT) RETURNS JSON
LANGUAGE SQL AS $$ SELECT '{"ok":true}'::JSON $$;
CREATE FUNCTION public.tokend_get_channel_detail_v2(TEXT, TEXT, TEXT, TEXT) RETURNS JSON
LANGUAGE SQL AS $$ SELECT '{"ok":true}'::JSON $$;
CREATE FUNCTION public.tokend_get_sessions(TEXT, TEXT, INTEGER) RETURNS JSON
LANGUAGE SQL AS $$ SELECT '{"ok":true}'::JSON $$;
CREATE FUNCTION public.tokend_get_session_detail(TEXT, TEXT) RETURNS JSON
LANGUAGE SQL AS $$ SELECT '{"ok":true}'::JSON $$;
CREATE FUNCTION public.tokend_get_top_projects_v2(TEXT, TEXT) RETURNS JSON
LANGUAGE SQL AS $$ SELECT '{"ok":true}'::JSON $$;

CREATE TEMP TABLE legacy_function_oids AS
SELECT oid, proname, oidvectortypes(proargtypes) AS argument_types
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname = ANY (ARRAY[
    'tokend_get_summary_v4', 'tokend_get_daily_trend_v4',
    'tokend_get_model_breakdown_v2', 'tokend_get_model_detail',
    'tokend_get_channel_breakdown_v3', 'tokend_get_channel_detail_v2',
    'tokend_get_sessions', 'tokend_get_session_detail', 'tokend_get_top_projects_v2'
  ]);

\ir ../../migrations/202607100003_pricing_rpcs.sql
\ir ../../migrations/202607100003_pricing_rpcs.sql
\ir ../../migrations/202607100004_pricing_backfill.sql
\ir ../../migrations/202607100004_pricing_backfill.sql
\ir ../../migrations/202607100005_optimize_sessions_v2.sql
\ir ../../migrations/202607100005_optimize_sessions_v2.sql
\ir ../../migrations/202607100006_extend_reconcile_timeout.sql
\ir ../../migrations/202607100006_extend_reconcile_timeout.sql
\ir ../../migrations/202607100007_extend_channel_detail_timeout.sql
\ir ../../migrations/202607100007_extend_channel_detail_timeout.sql
\ir ../../migrations/202607100008_extend_activation_timeout.sql
\ir ../../migrations/202607100008_extend_activation_timeout.sql

CREATE TEMP TABLE channel_detail_v3_oid_before_hotfix AS
SELECT oid
FROM pg_proc
WHERE oid = 'public.tokend_get_channel_detail_v3(text,text,text,text)'::regprocedure;

\ir ../../migrations/202607100009_optimize_channel_detail_v3.sql
\ir ../../migrations/202607100009_optimize_channel_detail_v3.sql

CREATE TEMP TABLE pricing_preflight_oid_before_hotfix AS
SELECT oid
FROM pg_proc
WHERE oid = 'public.tokend_pricing_preflight()'::regprocedure;

\ir ../../migrations/202607100010_optimize_pricing_preflight.sql
\ir ../../migrations/202607100010_optimize_pricing_preflight.sql
\ir ../../migrations/202607100011_extend_preflight_rest_timeout.sql
\ir ../../migrations/202607100011_extend_preflight_rest_timeout.sql
\ir ../../migrations/202607100012_extend_preflight_rest_timeout_headroom.sql
\ir ../../migrations/202607100012_extend_preflight_rest_timeout_headroom.sql
\ir ../../migrations/202607100013_extend_sessions_rest_timeout.sql
\ir ../../migrations/202607100013_extend_sessions_rest_timeout.sql
\ir ../../migrations/202607100014_extend_session_detail_rest_timeout.sql
\ir ../../migrations/202607100014_extend_session_detail_rest_timeout.sql

BEGIN;
SET LOCAL search_path = public, extensions;

SELECT plan(206);

SELECT is(
  'public.tokend_pricing_preflight()'::regprocedure::OID,
  (SELECT oid FROM pricing_preflight_oid_before_hotfix),
  'pricing preflight hotfix preserves the function OID across both loads'
);

SELECT ok(
  COALESCE((
    SELECT proconfig @> ARRAY['statement_timeout=40s']
    FROM pg_proc
    WHERE oid = 'public.tokend_pricing_preflight()'::regprocedure
  ), FALSE),
  'pricing preflight declares the production-tested PostgREST administrative timeout exemption'
);

SELECT is(
  'public.tokend_get_channel_detail_v3(text,text,text,text)'::regprocedure::OID,
  (SELECT oid FROM channel_detail_v3_oid_before_hotfix),
  'channel detail v3 hotfix preserves the function OID across both loads'
);

SELECT ok(
  COALESCE((
    SELECT proconfig @> ARRAY['statement_timeout=8s']
    FROM pg_proc
    WHERE oid = 'public.tokend_get_channel_detail_v3(text,text,text,text)'::regprocedure
  ), FALSE),
  'channel detail v3 has the bounded production runtime budget'
);

SELECT ok(
  COALESCE((
    SELECT proconfig @> ARRAY['statement_timeout=8s']
    FROM pg_proc
    WHERE oid = 'public.tokend_get_sessions_v2(text,text,integer)'::regprocedure
  ), FALSE),
  'sessions v2 has the bounded production REST runtime budget'
);

SELECT ok(
  COALESCE((
    SELECT proconfig @> ARRAY['statement_timeout=8s']
    FROM pg_proc
    WHERE oid = 'public.tokend_get_session_detail_v2(text,text)'::regprocedure
  ), FALSE),
  'session detail v2 has the bounded production REST runtime budget'
);

SELECT ok(
  COALESCE((
    SELECT proconfig @> ARRAY['statement_timeout=15s']
    FROM pg_proc
    WHERE oid = 'public.tokend_pricing_activate(uuid)'::regprocedure
  ), FALSE),
  'pricing activation has the bounded production runtime budget'
);

SELECT is(
  (SELECT count(*)::INTEGER FROM public.tokend_pricing_catalogs),
  1,
  'exactly one catalog is published'
);

SELECT is(
  (SELECT hash FROM public.tokend_pricing_catalogs WHERE version = '2026-07-10'),
  'c08b7254af1f5e8d29d12b565a560e1ead0b0f882657836ec20c605831a61955',
  'published catalog hash matches TypeScript'
);

SELECT is(
  (SELECT count(*)::INTEGER FROM public.tokend_pricing_models WHERE version = '2026-07-10'),
  43,
  'every TypeScript price version is installed once'
);

SELECT is(
  (SELECT count(*)::INTEGER FROM public.tokend_pricing_aliases WHERE version = '2026-07-10'),
  11,
  'every TypeScript alias is installed once'
);

SELECT results_eq(
  $actual$
    SELECT
      version,
      model_id,
      provider,
      to_char(valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      standard_input_rate::TEXT,
      standard_output_rate::TEXT,
      standard_cache_read_rate::TEXT,
      standard_cache_write_rate::TEXT,
      long_context_input_rate::TEXT,
      long_context_output_rate::TEXT,
      long_context_cache_read_rate::TEXT,
      long_context_cache_write_rate::TEXT,
      long_context_threshold::TEXT,
      source_checked_at::TEXT,
      source_url
    FROM public.tokend_pricing_models
    WHERE model_id IN ('claude-fable-5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra')
    ORDER BY model_id
  $actual$,
  $expected$
    VALUES
      (
        '2026-07-10', 'claude-fable-5', 'anthropic', '2026-06-09T00:00:00Z',
        '10.0000000000', '50.0000000000', '1.0000000000', '12.5000000000',
        NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
        '2026-07-10', 'https://platform.claude.com/docs/en/about-claude/pricing'
      ),
      (
        '2026-07-10', 'gpt-5.6-luna', 'openai', '2026-06-26T00:00:00Z',
        '1.0000000000', '6.0000000000', '0.1000000000', '1.2500000000',
        '2.0000000000', '9.0000000000', '0.2000000000', '2.5000000000', '272000',
        '2026-07-10', 'https://developers.openai.com/api/docs/pricing'
      ),
      (
        '2026-07-10', 'gpt-5.6-sol', 'openai', '2026-06-26T00:00:00Z',
        '5.0000000000', '30.0000000000', '0.5000000000', '6.2500000000',
        '10.0000000000', '45.0000000000', '1.0000000000', '12.5000000000', '272000',
        '2026-07-10', 'https://developers.openai.com/api/docs/pricing'
      ),
      (
        '2026-07-10', 'gpt-5.6-terra', 'openai', '2026-06-26T00:00:00Z',
        '2.5000000000', '15.0000000000', '0.2500000000', '3.1250000000',
        '5.0000000000', '22.5000000000', '0.5000000000', '6.2500000000', '272000',
        '2026-07-10', 'https://developers.openai.com/api/docs/pricing'
      )
  $expected$,
  'four new models have exact effective dates, rates, and sources'
);

SELECT ok(
  (
    SELECT long_context_input_rate IS NULL
      AND long_context_output_rate IS NULL
      AND long_context_cache_read_rate IS NULL
      AND long_context_cache_write_rate IS NULL
      AND long_context_threshold IS NULL
    FROM public.tokend_pricing_models
    WHERE version = '2026-07-10' AND model_id = 'claude-fable-5'
  ),
  'Fable has no long-context tier'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM public.tokend_pricing_models
    WHERE model_id = 'claude-fable-5'
      AND source_url = 'https://platform.claude.com/docs/en/about-claude/pricing'
  ),
  1,
  'Fable has one official-source price version'
);

SELECT fk_ok(
  'public',
  'tokend_pricing_aliases',
  ARRAY['version', 'model_id'],
  'public',
  'tokend_pricing_canonical_models',
  ARRAY['version', 'model_id'],
  'pricing aliases reference the exact canonical-model key'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM pg_class
    WHERE oid = ANY (ARRAY[
      'public.tokend_pricing_catalogs'::regclass,
      'public.tokend_pricing_canonical_models'::regclass,
      'public.tokend_pricing_models'::regclass,
      'public.tokend_pricing_aliases'::regclass,
      'public.tokend_event_cost_revisions'::regclass,
      'public.tokend_pricing_state'::regclass,
      'public.tokend_pricing_backfill_runs'::regclass,
      'public.tokend_pricing_backfill_targets'::regclass,
      'public.tokend_pricing_shadow_sessions'::regclass,
      'public.tokend_pricing_audit'::regclass
    ])
      AND relrowsecurity
  ),
  10,
  'RLS is enabled on every new table'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM information_schema.role_table_grants
    WHERE grantee = 'anon'
      AND table_schema = 'public'
      AND table_name = ANY (ARRAY[
        'tokend_pricing_catalogs', 'tokend_pricing_canonical_models',
        'tokend_pricing_models', 'tokend_pricing_aliases',
        'tokend_event_cost_revisions', 'tokend_pricing_state',
        'tokend_pricing_backfill_runs', 'tokend_pricing_backfill_targets',
        'tokend_pricing_shadow_sessions', 'tokend_pricing_audit'
      ])
  ),
  0,
  'anon has no direct table privileges'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM information_schema.role_table_grants
    WHERE grantee = 'authenticated'
      AND table_schema = 'public'
      AND table_name = ANY (ARRAY[
        'tokend_pricing_catalogs', 'tokend_pricing_canonical_models',
        'tokend_pricing_models', 'tokend_pricing_aliases',
        'tokend_event_cost_revisions', 'tokend_pricing_state',
        'tokend_pricing_backfill_runs', 'tokend_pricing_backfill_targets',
        'tokend_pricing_shadow_sessions', 'tokend_pricing_audit'
      ])
  ),
  0,
  'authenticated has no direct table privileges'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM (VALUES
      ('tokend_pricing_catalogs'),
      ('tokend_pricing_canonical_models'),
      ('tokend_pricing_models'),
      ('tokend_pricing_aliases'),
      ('tokend_event_cost_revisions'),
      ('tokend_pricing_state'),
      ('tokend_pricing_backfill_runs'),
      ('tokend_pricing_backfill_targets'),
      ('tokend_pricing_shadow_sessions'),
      ('tokend_pricing_audit')
    ) AS expected_tables(table_name)
    WHERE has_table_privilege(
      'service_role',
      'public.' || table_name,
      'SELECT'
    )
  ),
  10,
  'service_role has SELECT on all ten pricing tables'
);

SELECT ok(
  has_table_privilege(
    'service_role',
    'public.tokend_event_cost_revisions',
    'DELETE'
  ),
  'service_role can delete event-cost revisions'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM (VALUES
      ('tokend_pricing_catalogs'),
      ('tokend_pricing_canonical_models'),
      ('tokend_pricing_models'),
      ('tokend_pricing_aliases'),
      ('tokend_pricing_state'),
      ('tokend_pricing_backfill_runs'),
      ('tokend_pricing_backfill_targets'),
      ('tokend_pricing_shadow_sessions'),
      ('tokend_pricing_audit')
    ) AS non_revision_tables(table_name)
    WHERE has_table_privilege(
      'service_role',
      'public.' || table_name,
      'DELETE'
    )
  ),
  0,
  'service_role has DELETE on no other pricing table'
);

SELECT results_eq(
  $actual$
    SELECT
      privilege,
      (
        SELECT count(*)::INTEGER
        FROM (VALUES
          ('tokend_pricing_catalogs'),
          ('tokend_pricing_canonical_models'),
          ('tokend_pricing_models'),
          ('tokend_pricing_aliases'),
          ('tokend_event_cost_revisions'),
          ('tokend_pricing_state'),
          ('tokend_pricing_backfill_runs'),
          ('tokend_pricing_backfill_targets'),
          ('tokend_pricing_shadow_sessions'),
          ('tokend_pricing_audit')
        ) AS pricing_tables(table_name)
        WHERE has_table_privilege(
          'service_role',
          'public.' || table_name,
          privilege
        )
      ) AS granted_count
    FROM (VALUES
      ('INSERT'),
      ('REFERENCES'),
      ('TRIGGER'),
      ('TRUNCATE'),
      ('UPDATE')
    ) AS forbidden_privileges(privilege)
    ORDER BY privilege
  $actual$,
  $expected$
    VALUES
      ('INSERT'::TEXT, 0::INTEGER),
      ('REFERENCES'::TEXT, 0::INTEGER),
      ('TRIGGER'::TEXT, 0::INTEGER),
      ('TRUNCATE'::TEXT, 0::INTEGER),
      ('UPDATE'::TEXT, 0::INTEGER)
  $expected$,
  'service_role has no write or DDL-adjacent table privileges beyond revision DELETE'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM (VALUES
      ('public.tokend_install_pricing_catalog(text,text,date)'),
      ('public.tokend_reject_pricing_catalog_mutation()'),
      ('public.tokend_guard_pricing_catalog_content()'),
      ('public.tokend_guard_pricing_backfill_target()')
    ) AS protected_functions(function_identity)
    WHERE has_function_privilege(
      'service_role',
      function_identity,
      'EXECUTE'
    )
  ),
  0,
  'service_role cannot execute the installer or trigger guard functions'
);

SELECT ok(
  (
    SELECT active_catalog_version IS NULL
      AND previous_catalog_version IS NULL
      AND active_backfill_run_id IS NULL
      AND previous_backfill_run_id IS NULL
    FROM public.tokend_pricing_state
    WHERE singleton
  ),
  'all four singleton pointers start null'
);

SELECT is(
  (
    SELECT pg_get_constraintdef(oid)
    FROM pg_constraint
    WHERE conrelid = 'public.tokend_usage_events'::regclass
      AND contype = 'p'
  ),
  'PRIMARY KEY (id, member_code)',
  'the existing usage-event primary key is unchanged'
);

SELECT throws_ok(
  $sql$
    SELECT public.tokend_install_pricing_catalog(
      '2026-07-10',
      '0000000000000000000000000000000000000000000000000000000000000000',
      '2026-07-10'::DATE
    )
  $sql$,
  '55000',
  'Published pricing catalog 2026-07-10 conflicts with generated header',
  'same version with a different hash is rejected'
);

SELECT is(
  (SELECT hash FROM public.tokend_pricing_catalogs WHERE version = '2026-07-10'),
  'c08b7254af1f5e8d29d12b565a560e1ead0b0f882657836ec20c605831a61955',
  'hash conflict leaves the published catalog unchanged'
);

UPDATE pg_temp.tokend_expected_pricing_models
SET standard_input_rate = 999
WHERE version = '2026-07-10' AND model_id = 'gpt-5.6-sol';

SELECT throws_ok(
  $sql$
    SELECT public.tokend_install_pricing_catalog(
      '2026-07-10',
      'c08b7254af1f5e8d29d12b565a560e1ead0b0f882657836ec20c605831a61955',
      '2026-07-10'::DATE
    )
  $sql$,
  '55000',
  'Published pricing catalog 2026-07-10 has different model prices',
  'same version and hash with a different rate is rejected'
);

UPDATE pg_temp.tokend_expected_pricing_models
SET standard_input_rate = 5
WHERE version = '2026-07-10' AND model_id = 'gpt-5.6-sol';

SELECT is(
  (
    SELECT standard_input_rate
    FROM public.tokend_pricing_models
    WHERE version = '2026-07-10' AND model_id = 'gpt-5.6-sol'
  ),
  5::NUMERIC,
  'rate conflict leaves the published model unchanged'
);

UPDATE pg_temp.tokend_expected_pricing_aliases
SET model_id = 'gpt-5.6-luna'
WHERE version = '2026-07-10' AND alias = 'gpt-5.6';

SELECT throws_ok(
  $sql$
    SELECT public.tokend_install_pricing_catalog(
      '2026-07-10',
      'c08b7254af1f5e8d29d12b565a560e1ead0b0f882657836ec20c605831a61955',
      '2026-07-10'::DATE
    )
  $sql$,
  '55000',
  'Published pricing catalog 2026-07-10 has different aliases',
  'same version and hash with different content is rejected'
);

UPDATE pg_temp.tokend_expected_pricing_aliases
SET model_id = 'gpt-5.6-sol'
WHERE version = '2026-07-10' AND alias = 'gpt-5.6';

SELECT is(
  (
    SELECT model_id
    FROM public.tokend_pricing_aliases
    WHERE version = '2026-07-10' AND alias = 'gpt-5.6'
  ),
  'gpt-5.6-sol',
  'content conflict leaves the published alias unchanged'
);

SELECT throws_ok(
  $sql$UPDATE public.tokend_pricing_catalogs SET hash = hash WHERE version = '2026-07-10'$sql$,
  '55000',
  'Published pricing catalog headers are immutable',
  'direct catalog update is rejected'
);

SELECT throws_ok(
  $sql$DELETE FROM public.tokend_pricing_catalogs WHERE version = '2026-07-10'$sql$,
  '55000',
  'Published pricing catalog headers are immutable',
  'direct catalog delete is rejected'
);

SELECT throws_ok(
  $sql$
    UPDATE public.tokend_pricing_canonical_models
    SET model_id = model_id
    WHERE version = '2026-07-10' AND model_id = 'gpt-5.6-sol'
  $sql$,
  '55000',
  'Published pricing catalog content is immutable',
  'direct canonical-model update is rejected'
);

SELECT throws_ok(
  $sql$
    DELETE FROM public.tokend_pricing_canonical_models
    WHERE version = '2026-07-10' AND model_id = 'gpt-5.6-sol'
  $sql$,
  '55000',
  'Published pricing catalog content is immutable',
  'direct canonical-model delete is rejected'
);

SELECT throws_ok(
  $sql$
    UPDATE public.tokend_pricing_models
    SET standard_input_rate = standard_input_rate
    WHERE version = '2026-07-10' AND model_id = 'gpt-5.6-sol'
  $sql$,
  '55000',
  'Published pricing catalog content is immutable',
  'direct model update is rejected'
);

SELECT throws_ok(
  $sql$
    DELETE FROM public.tokend_pricing_models
    WHERE version = '2026-07-10' AND model_id = 'gpt-5.6-sol'
  $sql$,
  '55000',
  'Published pricing catalog content is immutable',
  'direct model delete is rejected'
);

SELECT throws_ok(
  $sql$
    UPDATE public.tokend_pricing_aliases
    SET model_id = model_id
    WHERE version = '2026-07-10' AND alias = 'gpt-5.6'
  $sql$,
  '55000',
  'Published pricing catalog content is immutable',
  'direct alias update is rejected'
);

SELECT throws_ok(
  $sql$
    DELETE FROM public.tokend_pricing_aliases
    WHERE version = '2026-07-10' AND alias = 'gpt-5.6'
  $sql$,
  '55000',
  'Published pricing catalog content is immutable',
  'direct alias delete is rejected'
);

SELECT results_eq(
  $actual$
    SELECT relation_name, row_count
    FROM (
      SELECT 'aliases'::TEXT AS relation_name, count(*)::BIGINT AS row_count
      FROM public.tokend_pricing_aliases WHERE version = '2026-07-10'
      UNION ALL
      SELECT 'canonical', count(*)::BIGINT
      FROM public.tokend_pricing_canonical_models WHERE version = '2026-07-10'
      UNION ALL
      SELECT 'catalogs', count(*)::BIGINT
      FROM public.tokend_pricing_catalogs WHERE version = '2026-07-10'
      UNION ALL
      SELECT 'models', count(*)::BIGINT
      FROM public.tokend_pricing_models WHERE version = '2026-07-10'
    ) AS counts
    ORDER BY relation_name
  $actual$,
  $expected$
    VALUES
      ('aliases'::TEXT, 11::BIGINT),
      ('canonical'::TEXT, 43::BIGINT),
      ('catalogs'::TEXT, 1::BIGINT),
      ('models'::TEXT, 43::BIGINT)
  $expected$,
  'all failed mutations leave catalog row counts unchanged'
);

-- Pricing-aware upload RPC contract.

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = ANY (ARRAY[
        'tokend_price_event', 'tokend_upload_events_v2',
        'tokend_upload_events', 'tokend_pricing_preflight'
      ])
  ),
  4,
  'the four pricing upload functions have no overloads'
);

SELECT results_eq(
  $actual$
    SELECT proname, oidvectortypes(proargtypes), pg_get_function_result(oid)
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = ANY (ARRAY[
        'tokend_price_event', 'tokend_upload_events_v2',
        'tokend_upload_events', 'tokend_pricing_preflight'
      ])
    ORDER BY proname
  $actual$,
  $expected$
    VALUES
      ('tokend_price_event'::NAME, 'jsonb, text'::TEXT, 'jsonb'::TEXT),
      ('tokend_pricing_preflight'::NAME, ''::TEXT, 'json'::TEXT),
      ('tokend_upload_events'::NAME, 'text, jsonb, jsonb'::TEXT, 'json'::TEXT),
      ('tokend_upload_events_v2'::NAME, 'text, jsonb, jsonb'::TEXT, 'json'::TEXT)
  $expected$,
  'function argument and return types are exact'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = ANY (ARRAY[
        'tokend_price_event', 'tokend_upload_events_v2',
        'tokend_upload_events', 'tokend_pricing_preflight'
      ])
      AND prosecdef
  ),
  4,
  'all pricing upload functions are SECURITY DEFINER'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = ANY (ARRAY[
        'tokend_price_event', 'tokend_upload_events_v2',
        'tokend_upload_events', 'tokend_pricing_preflight'
      ])
      AND proconfig @> ARRAY['search_path=public, pg_temp']::TEXT[]
  ),
  4,
  'all pricing upload functions pin public and pg_temp search_path'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = ANY (ARRAY[
        'tokend_price_event', 'tokend_upload_events_v2',
        'tokend_upload_events', 'tokend_pricing_preflight'
      ])
      AND has_function_privilege('anon', oid, 'EXECUTE')
  ),
  2,
  'anon can execute only the two upload RPCs'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = ANY (ARRAY[
        'tokend_price_event', 'tokend_upload_events_v2',
        'tokend_upload_events', 'tokend_pricing_preflight'
      ])
      AND has_function_privilege('authenticated', oid, 'EXECUTE')
  ),
  2,
  'authenticated can execute only the two upload RPCs'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = ANY (ARRAY[
        'tokend_price_event', 'tokend_upload_events_v2',
        'tokend_upload_events', 'tokend_pricing_preflight'
      ])
      AND has_function_privilege('service_role', oid, 'EXECUTE')
  ),
  1,
  'service_role can execute only pricing preflight'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM pg_proc AS p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = ANY (ARRAY[
        'tokend_price_event', 'tokend_upload_events_v2',
        'tokend_upload_events', 'tokend_pricing_preflight'
      ])
      AND acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'
  ),
  0,
  'PUBLIC has no implicit execute privilege'
);

SELECT is(
  public.tokend_upload_events_v2('invalid', '[]'::JSONB, '[]'::JSONB)::JSONB,
  '{"ok":false,"error":"invalid_token"}'::JSONB,
  'invalid member keeps the legacy JSON error contract'
);

SELECT lives_ok(
  $sql$SELECT public.tokend_upload_events_v2('invalid', '{}'::JSONB, '{}'::JSONB)$sql$,
  'invalid token is returned before malformed batch validation'
);

INSERT INTO public.tokend_members (member_code, token)
VALUES ('ROLL_UPLOAD', 'tkd_test');

SELECT throws_ok(
  $sql$SELECT public.tokend_upload_events_v2('tkd_test', '{}'::JSONB, '[]'::JSONB)$sql$,
  '22023',
  'p_events must be a JSON array',
  'events container must be an array'
);

SELECT throws_ok(
  $sql$SELECT public.tokend_upload_events_v2('tkd_test', '[]'::JSONB, '{}'::JSONB)$sql$,
  '22023',
  'p_sync_states must be a JSON array',
  'sync-state container must be an array'
);

SELECT throws_ok(
  $sql$SELECT public.tokend_upload_events_v2('tkd_test', '[1]'::JSONB, '[]'::JSONB)$sql$,
  '22023',
  'event entries must be JSON objects',
  'event entries must be objects'
);

SELECT throws_ok(
  $sql$
    SELECT public.tokend_upload_events_v2(
      'tkd_test',
      '[{"id":"bad-missing","timestampMs":1783641600000,"sessionId":"s","model":"gpt-5.6-sol","outputTokens":0,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0}]'::JSONB,
      '[]'::JSONB
    )
  $sql$,
  '22023',
  'event inputTokens must be a bounded non-negative integer',
  'all five token buckets are required'
);

SELECT throws_ok(
  $sql$
    SELECT public.tokend_upload_events_v2(
      'tkd_test',
      '[{"id":"bad-fraction","timestampMs":1783641600000,"sessionId":"s","model":"gpt-5.6-sol","inputTokens":0.5,"outputTokens":0,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0}]'::JSONB,
      '[]'::JSONB
    )
  $sql$,
  '22023',
  'event inputTokens must be a bounded non-negative integer',
  'token buckets reject fractions'
);

SELECT throws_ok(
  $sql$
    SELECT public.tokend_upload_events_v2(
      'tkd_test',
      '[{"id":"bad-negative","timestampMs":1783641600000,"sessionId":"s","model":"gpt-5.6-sol","inputTokens":-1,"outputTokens":0,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0}]'::JSONB,
      '[]'::JSONB
    )
  $sql$,
  '22023',
  'event inputTokens must be a bounded non-negative integer',
  'token buckets reject negative values'
);

SELECT throws_ok(
  $sql$
    SELECT public.tokend_upload_events_v2(
      'tkd_test',
      '[{"id":"bad-overflow","timestampMs":1783641600000,"sessionId":"s","model":"gpt-5.6-sol","inputTokens":2147483648,"outputTokens":0,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0}]'::JSONB,
      '[]'::JSONB
    )
  $sql$,
  '22023',
  'event inputTokens must be a bounded non-negative integer',
  'token buckets reject storage overflow'
);

SELECT throws_ok(
  $sql$
    SELECT public.tokend_upload_events_v2(
      'tkd_test',
      '[{"id":"bad-time","timestampMs":"today","sessionId":"s","model":"gpt-5.6-sol","inputTokens":0,"outputTokens":0,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0}]'::JSONB,
      '[]'::JSONB
    )
  $sql$,
  '22023',
  'event timestampMs must be a valid bounded bigint timestamp',
  'timestamp must be a JSON integer'
);

SELECT throws_ok(
  $sql$
    SELECT public.tokend_upload_events_v2(
      'tkd_test',
      '[{"id":"bad-time-range","timestampMs":253402300800000,"sessionId":"s","model":"gpt-5.6-sol","inputTokens":0,"outputTokens":0,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0}]'::JSONB,
      '[]'::JSONB
    )
  $sql$,
  '22023',
  'event timestampMs must be a valid bounded bigint timestamp',
  'timestamp must fit the supported calendar range'
);

SELECT throws_ok(
  $sql$SELECT public.tokend_upload_events_v2('tkd_test', '[]'::JSONB, '[{"sourcePathHash":"x","lastProcessedLines":-1,"parserVersion":1}]'::JSONB)$sql$,
  '22023',
  'sync state lastProcessedLines must be a bounded non-negative integer',
  'malformed sync-state entries reject the whole batch'
);

DO $fixtures$
DECLARE
  v_version TEXT;
  v_hash TEXT;
BEGIN
  FOR v_version, v_hash IN
    SELECT * FROM (VALUES
      ('2026-07-09'::TEXT, repeat('a', 64)::TEXT),
      ('2026-07-08'::TEXT, repeat('b', 64)::TEXT)
    ) AS fixture_versions(version, hash)
  LOOP
    INSERT INTO public.tokend_pricing_catalogs (version, hash, source_checked_at)
    VALUES (v_version, v_hash, '2026-07-10'::DATE);
    PERFORM set_config('tokend.pricing_catalog_install', v_version, TRUE);
    INSERT INTO public.tokend_pricing_canonical_models (version, model_id)
    SELECT v_version, model_id
    FROM public.tokend_pricing_canonical_models
    WHERE version = '2026-07-10';
    INSERT INTO public.tokend_pricing_models (
      version, model_id, provider, valid_from, valid_to,
      standard_input_rate, standard_output_rate,
      standard_cache_read_rate, standard_cache_write_rate,
      long_context_input_rate, long_context_output_rate,
      long_context_cache_read_rate, long_context_cache_write_rate,
      long_context_threshold, source_checked_at, source_url
    )
    SELECT
      v_version, model_id, provider, valid_from, valid_to,
      CASE WHEN v_version = '2026-07-09' THEN standard_input_rate / 2 ELSE standard_input_rate END,
      CASE WHEN v_version = '2026-07-09' THEN standard_output_rate / 2 ELSE standard_output_rate END,
      CASE WHEN v_version = '2026-07-09' THEN standard_cache_read_rate / 2 ELSE standard_cache_read_rate END,
      CASE WHEN v_version = '2026-07-09' THEN standard_cache_write_rate / 2 ELSE standard_cache_write_rate END,
      CASE WHEN v_version = '2026-07-09' THEN long_context_input_rate / 2 ELSE long_context_input_rate END,
      CASE WHEN v_version = '2026-07-09' THEN long_context_output_rate / 2 ELSE long_context_output_rate END,
      CASE WHEN v_version = '2026-07-09' THEN long_context_cache_read_rate / 2 ELSE long_context_cache_read_rate END,
      CASE WHEN v_version = '2026-07-09' THEN long_context_cache_write_rate / 2 ELSE long_context_cache_write_rate END,
      long_context_threshold, source_checked_at, source_url
    FROM public.tokend_pricing_models
    WHERE version = '2026-07-10';
    INSERT INTO public.tokend_pricing_aliases (version, alias, model_id)
    SELECT v_version, alias, model_id
    FROM public.tokend_pricing_aliases
    WHERE version = '2026-07-10';
    PERFORM set_config('tokend.pricing_catalog_install', '', TRUE);
  END LOOP;

  INSERT INTO public.tokend_pricing_backfill_runs (
    run_id, catalog_version, status, snapshot_at, reconciliation_hash
  ) VALUES
    ('00000000-0000-0000-0000-000000000001', '2026-07-10', 'staging', '2026-07-01T00:00:00Z', 'hash-active'),
    ('00000000-0000-0000-0000-000000000002', '2026-07-09', 'reconciled', '2026-07-01T00:00:00Z', 'hash-previous'),
    ('00000000-0000-0000-0000-000000000003', '2026-07-08', 'staging', '2026-07-01T00:00:00Z', 'hash-staging');

  UPDATE public.tokend_pricing_state
  SET active_catalog_version = '2026-07-10',
      previous_catalog_version = '2026-07-09',
      active_backfill_run_id = '00000000-0000-0000-0000-000000000001',
      previous_backfill_run_id = '00000000-0000-0000-0000-000000000002'
  WHERE singleton;
END
$fixtures$;

SELECT is(
  (public.tokend_price_event(
    '{"model":"gpt-5.6-sol","timestampMs":1783641600000,"inputTokens":100000,"outputTokens":10000,"reasoningTokens":10000,"cacheReadTokens":100000,"cacheWriteTokens":30000,"tokenSemantics":"disjoint"}'::JSONB,
    '2026-07-10'
  )->>'totalCost')::NUMERIC,
  1.3375::NUMERIC,
  'Sol prices all five buckets to the exact fixture total'
);

SELECT is(
  public.tokend_price_event(
    '{"model":"gpt-5.6","timestampMs":1783641600000,"inputTokens":1,"outputTokens":0,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"tokenSemantics":"disjoint"}'::JSONB,
    '2026-07-10'
  )->>'matchedModelId',
  'gpt-5.6-sol',
  'exact alias resolution returns the canonical model'
);

SELECT is(
  public.tokend_price_event(
    '{"model":"gpt-5.6-sol-20260710","timestampMs":1783641600000,"inputTokens":1,"outputTokens":0,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"tokenSemantics":"disjoint"}'::JSONB,
    '2026-07-10'
  )->>'matchedModelId',
  'gpt-5.6-sol',
  'one strict real YYYYMMDD suffix may be stripped'
);

SELECT is(
  public.tokend_price_event(
    '{"model":"gpt-5.6-sol-20260230","timestampMs":1783641600000,"inputTokens":1,"outputTokens":0,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"tokenSemantics":"disjoint"}'::JSONB,
    '2026-07-10'
  )->>'status',
  'unpriced',
  'invalid calendar suffix is never stripped'
);

SELECT is(
  public.tokend_price_event(
    '{"model":"gpt-5.6-terra","timestampMs":1783641600000,"inputTokens":100000,"outputTokens":0,"reasoningTokens":0,"cacheReadTokens":100000,"cacheWriteTokens":72000,"tokenSemantics":"disjoint"}'::JSONB,
    '2026-07-10'
  )->>'tier',
  'standard',
  'Terra prompt sum exactly 272000 stays standard'
);

SELECT is(
  public.tokend_price_event(
    '{"model":"gpt-5.6-terra","timestampMs":1783641600000,"inputTokens":100000,"outputTokens":0,"reasoningTokens":0,"cacheReadTokens":100000,"cacheWriteTokens":72001,"tokenSemantics":"disjoint"}'::JSONB,
    '2026-07-10'
  )->>'tier',
  'long_context',
  'Terra prompt sum 272001 crosses via cache tokens'
);

SELECT is(
  (public.tokend_price_event(
    '{"model":"gpt-5.6-terra","timestampMs":1783641600000,"inputTokens":100000,"outputTokens":0,"reasoningTokens":0,"cacheReadTokens":100000,"cacheWriteTokens":72001,"tokenSemantics":"disjoint"}'::JSONB,
    '2026-07-10'
  )->>'totalCost')::NUMERIC,
  1.00000625::NUMERIC,
  'Terra long tier prices the cache boundary exactly'
);

SELECT is(
  public.tokend_price_event(
    '{"model":"gpt-5.6-terra","timestampMs":1783641600000,"inputTokens":272001,"outputTokens":0,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"tokenSemantics":"unknown"}'::JSONB,
    '2026-07-10'
  )->>'tier',
  'standard',
  'unknown token semantics disables long-context selection'
);

SELECT ok(
  public.tokend_price_event(
    '{"model":"gpt-5.6-terra","timestampMs":1783641600000,"inputTokens":272001,"outputTokens":0,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"tokenSemantics":"unknown"}'::JSONB,
    '2026-07-10'
  )->'warnings' @> '["unknown_token_semantics"]'::JSONB,
  'unknown token semantics emits a warning'
);

SELECT is(
  public.tokend_price_event(
    '{"model":"codex-auto-review","timestampMs":1783641600000,"inputTokens":1,"outputTokens":1,"reasoningTokens":1,"cacheReadTokens":1,"cacheWriteTokens":1,"tokenSemantics":"disjoint"}'::JSONB,
    '2026-07-10'
  )->>'status',
  'zero_rate',
  'only an explicit all-zero catalog row is zero_rate'
);

SELECT is(
  public.tokend_price_event(
    '{"model":"does-not-exist","timestampMs":1783641600000,"inputTokens":0,"outputTokens":0,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"tokenSemantics":"disjoint"}'::JSONB,
    '2026-07-10'
  )->>'status',
  'unpriced',
  'unknown model remains unpriced even with zero usage'
);

SELECT is(
  public.tokend_price_event(
    '{"model":"codex-auto-review","inputTokens":1,"outputTokens":1,"reasoningTokens":1,"cacheReadTokens":1,"cacheWriteTokens":1,"tokenSemantics":"disjoint"}'::JSONB,
    '2026-07-10'
  )->>'status',
  'unpriced',
  'missing event time is unpriced even for an explicit zero-rate model'
);

SELECT is(
  public.tokend_price_event(
    '{"model":"codex-auto-review","timestampMs":"bad","inputTokens":1,"outputTokens":1,"reasoningTokens":1,"cacheReadTokens":1,"cacheWriteTokens":1,"tokenSemantics":"disjoint"}'::JSONB,
    '2026-07-10'
  )->>'status',
  'unpriced',
  'invalid event time is unpriced rather than zero_rate'
);

-- Reported, legacy, estimated, revision, and preflight behavior (tests 68-101).
SELECT is(
  (
    public.tokend_upload_events_v2(
      'tkd_test',
      jsonb_build_array(jsonb_build_object(
        'id', 'reported-1', 'timestampMs', 1783641600000,
        'sessionId', 'session-report', 'sessionKey', 'key-report',
        'agent', 'codex', 'provider', 'openai', 'model', 'gpt-5.6-sol',
        'channel', 'cli', 'inputTokens', 1, 'outputTokens', 2,
        'reasoningTokens', 3, 'cacheReadTokens', 4, 'cacheWriteTokens', 5,
        'totalTokens', 15, 'inputCost', 0.1, 'outputCost', 0.2,
        'reasoningCost', 0.3, 'cacheReadCost', 0.4, 'cacheWriteCost', 0.5,
        'totalCost', 1.5, 'unallocatedCost', 0,
        'pricingStatus', 'reported', 'pricingTier', 'standard',
        'tokenSemantics', 'disjoint', 'breakdownStatus', 'reconciled',
        'project', 'initial-project'
      )),
      jsonb_build_array(
        jsonb_build_object('sourcePathHash', 'path-a', 'lastProcessedLines', 10, 'parserVersion', 1),
        jsonb_build_object('sourcePathHash', 'path-a', 'lastProcessedLines', 99, 'parserVersion', 9)
      )
    )::JSONB->>'inserted'
  )::INTEGER,
  1,
  'reported v2 first upload inserts one row'
);

SELECT is(
  (
    public.tokend_upload_events_v2(
      'tkd_test',
      jsonb_build_array(jsonb_build_object(
        'id', 'reported-1', 'timestampMs', 1782518400000,
        'sessionId', 'mutated-session', 'model', 'does-not-exist',
        'inputTokens', 9, 'outputTokens', 9, 'reasoningTokens', 9,
        'cacheReadTokens', 9, 'cacheWriteTokens', 9, 'totalTokens', 45,
        'inputCost', 9, 'outputCost', 9, 'reasoningCost', 9,
        'cacheReadCost', 9, 'cacheWriteCost', 9, 'totalCost', 45,
        'pricingStatus', 'estimated', 'tokenSemantics', 'unknown',
        'project', 'updated-project'
      )),
      jsonb_build_array(
        jsonb_build_object('sourcePathHash', 'path-a', 'lastProcessedLines', 20, 'parserVersion', 2)
      )
    )::JSONB->>'inserted'
  )::INTEGER,
  0,
  'reported v2 duplicate reports zero genuine inserts'
);

SELECT results_eq(
  $actual$
    SELECT
      pricing_status,
      round(input_cost::NUMERIC, 2), round(output_cost::NUMERIC, 2),
      round(reasoning_cost::NUMERIC, 2), round(cache_read_cost::NUMERIC, 2),
      round(cache_write_cost::NUMERIC, 2), round(total_cost::NUMERIC, 2),
      breakdown_status
    FROM public.tokend_usage_events
    WHERE member_code = 'ROLL_UPLOAD' AND id = 'reported-1'
  $actual$,
  $expected$
    VALUES (
      'reported'::TEXT,
      0.10::NUMERIC, 0.20::NUMERIC, 0.30::NUMERIC,
      0.40::NUMERIC, 0.50::NUMERIC, 1.50::NUMERIC,
      'reconciled'::TEXT
    )
  $expected$,
  'reported base preserves the five costs, total, and breakdown'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM public.tokend_event_cost_revisions
    WHERE member_code = 'ROLL_UPLOAD' AND event_id = 'reported-1'
  ),
  0,
  'reported base never creates catalog revisions'
);

SELECT results_eq(
  $actual$
    SELECT
      timestamp_ms, session_id, model, input_tokens, round(total_cost::NUMERIC, 2), project,
      (SELECT last_processed_lines FROM public.tokend_sync_state
       WHERE member_code = 'ROLL_UPLOAD' AND source_path_hash = 'path-a'),
      (SELECT parser_version FROM public.tokend_sync_state
       WHERE member_code = 'ROLL_UPLOAD' AND source_path_hash = 'path-a')
    FROM public.tokend_usage_events
    WHERE member_code = 'ROLL_UPLOAD' AND id = 'reported-1'
  $actual$,
  $expected$
    VALUES (
      1783641600000::BIGINT, 'session-report'::TEXT, 'gpt-5.6-sol'::TEXT,
      1::INTEGER, 1.50::NUMERIC, 'updated-project'::TEXT, 20::INTEGER, 2::INTEGER
    )
  $expected$,
  'reupload mutates only project and sync metadata'
);

SELECT is(
  (
    public.tokend_upload_events_v2(
      'tkd_test',
      '[{"id":"legacy-1","timestampMs":1783641600000,"sessionId":"session-legacy","model":"gpt-5.6-sol","inputTokens":10,"outputTokens":0,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"totalTokens":10,"inputCost":0.5,"outputCost":0,"reasoningCost":0,"cacheReadCost":0,"cacheWriteCost":0,"totalCost":0.5,"project":"legacy-project"}]'::JSONB,
      '[]'::JSONB
    )::JSONB->>'inserted'
  )::INTEGER,
  1,
  'metadata-free nonzero legacy first upload inserts one row'
);

SELECT is(
  (
    public.tokend_upload_events_v2(
      'tkd_test',
      '[{"id":"legacy-1","timestampMs":1783641600000,"sessionId":"session-legacy","model":"gpt-5.6-sol","inputTokens":10,"outputTokens":0,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"totalTokens":10,"inputCost":9,"outputCost":9,"reasoningCost":9,"cacheReadCost":9,"cacheWriteCost":9,"totalCost":45,"project":"legacy-project-2"}]'::JSONB,
      '[]'::JSONB
    )::JSONB->>'inserted'
  )::INTEGER,
  0,
  'metadata-free legacy duplicate reports zero genuine inserts'
);

SELECT results_eq(
  $actual$
    SELECT pricing_status, round(input_cost::NUMERIC, 2), round(total_cost::NUMERIC, 2), project
    FROM public.tokend_usage_events
    WHERE member_code = 'ROLL_UPLOAD' AND id = 'legacy-1'
  $actual$,
  $expected$
    VALUES ('legacy'::TEXT, 0.50::NUMERIC, 0.50::NUMERIC, 'legacy-project-2'::TEXT)
  $expected$,
  'legacy base preserves first costs while accepting a project update'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM public.tokend_event_cost_revisions
    WHERE member_code = 'ROLL_UPLOAD' AND event_id = 'legacy-1'
  ),
  0,
  'legacy base never creates catalog revisions'
);

SELECT is(
  (
    public.tokend_upload_events_v2(
      'tkd_test',
      '[{"id":"estimate-1","timestampMs":1783641600000,"sessionId":"session-estimate","model":"gpt-5.6-sol","inputTokens":100000,"outputTokens":10000,"reasoningTokens":10000,"cacheReadTokens":100000,"cacheWriteTokens":30000,"totalTokens":250000,"inputCost":999,"outputCost":999,"reasoningCost":999,"cacheReadCost":999,"cacheWriteCost":999,"totalCost":4995,"pricingStatus":"estimated","pricingTier":"long_context","priceVersion":"wrong","matchedModelId":"wrong","tokenSemantics":"disjoint","breakdownStatus":"invalid","project":"estimate-project"}]'::JSONB,
      '[]'::JSONB
    )::JSONB->>'inserted'
  )::INTEGER,
  1,
  'client-estimated first upload inserts one base row'
);

SELECT results_eq(
  $actual$
    SELECT
      pricing_status, input_cost::NUMERIC, output_cost::NUMERIC,
      reasoning_cost::NUMERIC, cache_read_cost::NUMERIC,
      cache_write_cost::NUMERIC, total_cost::NUMERIC,
      price_version, matched_model_id
    FROM public.tokend_usage_events
    WHERE member_code = 'ROLL_UPLOAD' AND id = 'estimate-1'
  $actual$,
  $expected$
    VALUES (
      'unpriced'::TEXT, 0::NUMERIC, 0::NUMERIC, 0::NUMERIC,
      0::NUMERIC, 0::NUMERIC, 0::NUMERIC, NULL::TEXT, NULL::TEXT
    )
  $expected$,
  'base ignores deliberate client estimate and never stores a server estimate'
);

SELECT results_eq(
  $actual$
    SELECT version
    FROM public.tokend_event_cost_revisions
    WHERE member_code = 'ROLL_UPLOAD' AND event_id = 'estimate-1'
    ORDER BY version
  $actual$,
  $expected$
    VALUES ('2026-07-08'::TEXT), ('2026-07-09'::TEXT), ('2026-07-10'::TEXT)
  $expected$,
  'active, previous, and staging catalogs create three distinct revisions'
);

SELECT results_eq(
  $actual$
    SELECT version, total_cost
    FROM public.tokend_event_cost_revisions
    WHERE member_code = 'ROLL_UPLOAD' AND event_id = 'estimate-1'
      AND pricing_status = 'estimated'
    ORDER BY version
  $actual$,
  $expected$
    VALUES
      ('2026-07-08'::TEXT, 1.3375000000::NUMERIC),
      ('2026-07-09'::TEXT, 0.6687500000::NUMERIC),
      ('2026-07-10'::TEXT, 1.3375000000::NUMERIC)
  $expected$,
  'all revision costs come from their distinct server catalogs'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM public.tokend_event_cost_revisions
    WHERE member_code = 'ROLL_UPLOAD' AND event_id = 'estimate-1'
      AND backfill_run_id IS NULL
  ),
  3,
  'live upload revisions keep backfill_run_id audit-only and null'
);

UPDATE public.tokend_pricing_state
SET active_catalog_version = NULL,
    previous_catalog_version = NULL,
    current_ingest_epoch = 1
WHERE singleton;

SELECT is(
  (
    public.tokend_upload_events_v2(
      'tkd_test',
      '[{"id":"late-1","timestampMs":1782518400000,"sessionId":"session-late","model":"gpt-5.6-sol","inputTokens":1000,"outputTokens":0,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"totalTokens":1000,"inputCost":123,"outputCost":0,"reasoningCost":0,"cacheReadCost":0,"cacheWriteCost":0,"totalCost":123,"pricingStatus":"estimated","tokenSemantics":"disjoint"}]'::JSONB,
      '[]'::JSONB
    )::JSONB->>'inserted'
  )::INTEGER,
  1,
  'late-arriving event inserts after run snapshots are captured'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM public.tokend_event_cost_revisions
    WHERE member_code = 'ROLL_UPLOAD' AND event_id = 'late-1'
      AND version = '2026-07-08' AND backfill_run_id IS NULL
  ),
  1,
  'late event still receives the unpointed staging-run catalog revision'
);

UPDATE public.tokend_pricing_state
SET active_catalog_version = '2026-07-10',
    previous_catalog_version = '2026-07-09'
WHERE singleton;

UPDATE public.tokend_event_cost_revisions
SET input_cost = 0, output_cost = 0, reasoning_cost = 0,
    cache_read_cost = 0, cache_write_cost = 0, unallocated_cost = 0,
    total_cost = 0, pricing_status = 'unpriced', pricing_tier = 'standard',
    matched_model_id = NULL, price_version = NULL,
    breakdown_status = 'reconciled'
WHERE version = '2026-07-10'
  AND member_code = 'ROLL_UPLOAD'
  AND event_id = 'estimate-1';

SELECT is(
  (
    public.tokend_upload_events_v2(
      'tkd_test',
      '[{"id":"estimate-1","timestampMs":1782518400000,"sessionId":"mutated-estimate","model":"does-not-exist","inputTokens":1,"outputTokens":1,"reasoningTokens":1,"cacheReadTokens":1,"cacheWriteTokens":1,"totalTokens":5,"pricingStatus":"unpriced","tokenSemantics":"unknown","project":"estimate-project-2"}]'::JSONB,
      '[]'::JSONB
    )::JSONB->>'inserted'
  )::INTEGER,
  0,
  'revision upgrade happens on a zero-insert reupload'
);

SELECT results_eq(
  $actual$
    SELECT pricing_status, total_cost,
      (SELECT project FROM public.tokend_usage_events
       WHERE member_code = 'ROLL_UPLOAD' AND id = 'estimate-1'),
      (SELECT total_cost FROM public.tokend_usage_events
       WHERE member_code = 'ROLL_UPLOAD' AND id = 'estimate-1')
    FROM public.tokend_event_cost_revisions
    WHERE version = '2026-07-10'
      AND member_code = 'ROLL_UPLOAD' AND event_id = 'estimate-1'
  $actual$,
  $expected$
    VALUES ('estimated'::TEXT, 1.3375::NUMERIC, 'estimate-project-2'::TEXT, 0::REAL)
  $expected$,
  'unpriced revision upgrades without changing the unpriced base cost'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM public.tokend_event_cost_revisions
    WHERE member_code = 'ROLL_UPLOAD' AND event_id = 'estimate-1'
  ),
  3,
  'revision primary key keeps one row per catalog member and event'
);

INSERT INTO public.tokend_pricing_backfill_targets (
  run_id, member_code, event_id, event_snapshot, snapshot_hash
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  'ROLL_UPLOAD',
  'estimate-1',
  '{}'::JSONB,
  repeat('a', 64)
);

INSERT INTO public.tokend_usage_events (
  id, member_code, timestamp_ms, session_id, model,
  input_tokens, output_tokens, reasoning_tokens,
  cache_read_tokens, cache_write_tokens, total_tokens,
  input_cost, output_cost, reasoning_cost,
  cache_read_cost, cache_write_cost, total_cost,
  pricing_status, pricing_tier, token_semantics,
  unallocated_cost, breakdown_status
) VALUES (
  'zero-token-preflight', 'ROLL_UPLOAD', 1783641600000, 'session-zero', 'gpt-5.6-sol',
  0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0,
  'unpriced', 'standard', 'disjoint', 0, 'reconciled'
);

UPDATE public.tokend_usage_events
SET uploaded_at = TIMESTAMPTZ '2026-06-30 00:00:00+00'
WHERE member_code = 'ROLL_UPLOAD'
  AND id IN ('reported-1', 'legacy-1', 'zero-token-preflight');

UPDATE public.tokend_usage_events
SET uploaded_at = TIMESTAMPTZ '2026-07-02 00:00:00+00'
WHERE member_code = 'ROLL_UPLOAD'
  AND id IN ('estimate-1', 'late-1');

SELECT results_eq(
  $actual$
    SELECT key
    FROM json_object_keys(public.tokend_pricing_preflight()) AS key
    ORDER BY key
  $actual$,
  $expected$
    VALUES
      ('activeCatalogVersion'::TEXT), ('activeReconciliationHash'::TEXT),
      ('activeRunId'::TEXT), ('activeRunStatus'::TEXT), ('authoritative'::TEXT),
      ('catalogHash'::TEXT),
      ('eligibleEventCount'::TEXT), ('eligibleZeroCostEventCount'::TEXT),
      ('eventCount'::TEXT), ('legacyPriceRowCount'::TEXT),
      ('membersOver2xCount'::TEXT), ('postSnapshotEventCount'::TEXT),
      ('previousCatalogVersion'::TEXT), ('previousRunId'::TEXT),
      ('rolloutFixtureCount'::TEXT), ('source'::TEXT), ('statusCounts'::TEXT),
      ('totalCost'::TEXT), ('unpricedEventCount'::TEXT), ('unpricedShare'::TEXT),
      ('zeroCostByModel'::TEXT), ('zeroCostByModelTruncated'::TEXT),
      ('zeroCostOtherEventCount'::TEXT)
  $expected$,
  'preflight returns exactly the aggregate-only key set'
);

SELECT ok(
  position('tkd_test' IN public.tokend_pricing_preflight()::TEXT) = 0
    AND position('ROLL_UPLOAD' IN public.tokend_pricing_preflight()::TEXT) = 0
    AND position('reported-1' IN public.tokend_pricing_preflight()::TEXT) = 0
    AND position('session-report' IN public.tokend_pricing_preflight()::TEXT) = 0,
  'preflight never returns tokens, member codes, sessions, or event ids'
);

SELECT results_eq(
  $actual$
    SELECT
      (p->>'eventCount')::BIGINT,
      (p->>'eligibleEventCount')::BIGINT,
      (p->>'eligibleZeroCostEventCount')::BIGINT,
      (p->>'unpricedEventCount')::BIGINT,
      (p->>'unpricedShare')::NUMERIC,
      p->'statusCounts'
    FROM (SELECT public.tokend_pricing_preflight()::JSONB AS p) AS preflight
  $actual$,
  $expected$
    VALUES (
      5::BIGINT, 4::BIGINT, 0::BIGINT, 0::BIGINT, 0::NUMERIC,
      '{"reported":1,"estimated":2,"zero_rate":0,"unpriced":0,"legacy":1,"unset":0}'::JSONB
    )
  $expected$,
  'preflight event and pricing-status aggregates use effective costs and statuses'
);

SELECT results_eq(
  $actual$
    SELECT
      (p->'statusCounts'->>'unpriced')::BIGINT,
      (
        SELECT COALESCE(sum(value::BIGINT), 0)::BIGINT
        FROM jsonb_each_text(p->'statusCounts')
      )
    FROM (SELECT public.tokend_pricing_preflight()::JSONB AS p) AS preflight
  $actual$,
  $expected$
    VALUES (0::BIGINT, 4::BIGINT)
  $expected$,
  'zero-token telemetry does not enter authoritative preflight statusCounts'
);

SELECT results_eq(
  $actual$
    SELECT item->>'model', (item->>'eventCount')::BIGINT, (item->>'totalTokens')::BIGINT
    FROM jsonb_array_elements(public.tokend_pricing_preflight()::JSONB->'zeroCostByModel') AS item
  $actual$,
  $expected$
    SELECT NULL::TEXT, NULL::BIGINT, NULL::BIGINT WHERE FALSE
  $expected$,
  'zero-cost-by-model uses effective eligible cost rather than raw base cost'
);

SELECT is(
  (public.tokend_pricing_preflight()::JSONB->>'postSnapshotEventCount')::BIGINT,
  1::BIGINT,
  'preflight counts the late live revision and excludes the frozen run target'
);

SELECT is(
  (public.tokend_pricing_preflight()::JSONB->>'rolloutFixtureCount')::BIGINT,
  1::BIGINT,
  'preflight aggregates ROLL-percent fixture members without exposing codes'
);

UPDATE public.tokend_event_cost_revisions
SET total_cost = 10
WHERE version = '2026-07-10'
  AND member_code = 'ROLL_UPLOAD'
  AND event_id = 'estimate-1';

SELECT is(
  (public.tokend_pricing_preflight()::JSONB->>'membersOver2xCount')::BIGINT,
  1::BIGINT,
  'membersOver2x compares active and previous member aggregates only'
);

UPDATE public.tokend_pricing_state
SET previous_catalog_version = NULL
WHERE singleton;

SELECT is(
  (public.tokend_pricing_preflight()::JSONB->>'membersOver2xCount')::BIGINT,
  0::BIGINT,
  'membersOver2x is zero when a comparison pointer is missing'
);

UPDATE public.tokend_pricing_state
SET previous_catalog_version = '2026-07-09'
WHERE singleton;

SELECT results_eq(
  $actual$
    SELECT
      p->>'activeCatalogVersion', p->>'activeRunId', p->>'previousCatalogVersion',
      p->>'previousRunId', p->>'activeRunStatus', p->>'activeReconciliationHash'
    FROM (SELECT public.tokend_pricing_preflight()::JSONB AS p) AS preflight
  $actual$,
  $expected$
    VALUES (
      '2026-07-10'::TEXT, '00000000-0000-0000-0000-000000000001'::TEXT,
      '2026-07-09'::TEXT, '00000000-0000-0000-0000-000000000002'::TEXT,
      'staging'::TEXT, 'hash-active'::TEXT
    )
  $expected$,
  'preflight exposes only aggregate rollout pointers and run state'
);

SELECT is(
  (
    public.tokend_upload_events(
      'tkd_test',
      '[{"id":"wrapper-1","timestampMs":1783641600000,"sessionId":"session-wrapper","model":"gpt-5.6-sol","inputTokens":100000,"outputTokens":10000,"reasoningTokens":10000,"cacheReadTokens":100000,"cacheWriteTokens":30000,"totalTokens":250000,"inputCost":888,"outputCost":888,"reasoningCost":888,"cacheReadCost":888,"cacheWriteCost":888,"totalCost":4440,"pricingStatus":"estimated","tokenSemantics":"disjoint"}]'::JSONB,
      '[]'::JSONB
    )::JSONB->>'inserted'
  )::INTEGER,
  1,
  'legacy exact wrapper delegates first upload to v2'
);

SELECT is(
  (
    public.tokend_upload_events(
      'tkd_test',
      '[{"id":"wrapper-1","timestampMs":1783641600000,"sessionId":"session-wrapper","model":"gpt-5.6-sol","inputTokens":100000,"outputTokens":10000,"reasoningTokens":10000,"cacheReadTokens":100000,"cacheWriteTokens":30000,"totalTokens":250000,"pricingStatus":"unpriced","tokenSemantics":"disjoint"}]'::JSONB,
      '[]'::JSONB
    )::JSONB->>'inserted'
  )::INTEGER,
  0,
  'legacy exact wrapper returns zero for duplicate upload'
);

SELECT results_eq(
  $actual$
    SELECT key
    FROM json_object_keys(public.tokend_upload_events('tkd_test', '[]'::JSONB, '[]'::JSONB)) AS key
    ORDER BY key
  $actual$,
  $expected$
    VALUES ('inserted'::TEXT), ('ok'::TEXT)
  $expected$,
  'legacy and v2 success responses retain exact ok and inserted keys'
);

SELECT results_eq(
  $actual$
    SELECT e.pricing_status, e.total_cost::NUMERIC, r.pricing_status, r.total_cost
    FROM public.tokend_usage_events AS e
    JOIN public.tokend_event_cost_revisions AS r
      ON r.event_id = e.id AND r.member_code = e.member_code
     AND r.version = '2026-07-10'
    WHERE e.member_code = 'ROLL_UPLOAD' AND e.id = 'wrapper-1'
  $actual$,
  $expected$
    VALUES ('unpriced'::TEXT, 0::NUMERIC, 'estimated'::TEXT, 1.3375::NUMERIC)
  $expected$,
  'legacy wrapper also ignores client estimates and stores server cost only in revision'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM public.tokend_event_cost_revisions
    WHERE member_code = 'ROLL_UPLOAD'
      AND event_id IN ('estimate-1', 'late-1', 'wrapper-1')
      AND backfill_run_id IS NOT NULL
  ),
  0,
  'every live revision remains detached from audit-only backfill ids'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('tokend_upload_events', 'tokend_upload_events_v2')
      AND oidvectortypes(proargtypes) = 'text, jsonb, jsonb'
  ),
  2,
  'schema reload surface has exactly one legacy and one v2 upload signature'
);

-- -------------------------------------------------------------------------
-- Effective-cost RPC fixtures. Every timestamp remains inside a 1d/7d window.
-- -------------------------------------------------------------------------
INSERT INTO public.tokend_members (member_code, token) VALUES
  ('RPC_FIX', 'rpc-token'),
  ('RPC_NO_USAGE', 'rpc-no-usage'),
  ('RPC_UNPRICED', 'rpc-unpriced'),
  ('RPC_ZERO', 'rpc-zero'),
  ('RPC_LEGACY', 'rpc-legacy'),
  ('RPC_COMPLETE', 'rpc-complete'),
  ('RPC_MISMATCH', 'rpc-mismatch'),
  ('RPC_INVALID', 'rpc-invalid'),
  ('RPC_BREAKDOWN', 'rpc-breakdown'),
  ('RPC_CROSS_SESSION', 'rpc-cross-session'),
  ('RPC_FLOAT', 'rpc-float'),
  ('RPC_TINY_BASE', 'rpc-tiny-base'),
  ('RPC_TINY_REVISION', 'rpc-tiny-revision'),
  ('RPC_OVERFLOW', 'rpc-overflow');

INSERT INTO public.tokend_usage_events (
  id, member_code, timestamp_ms, session_id, session_key, agent, provider, model, channel,
  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
  total_tokens, input_cost, output_cost, reasoning_cost, cache_read_cost, cache_write_cost,
  total_cost, stop_reason, project, pricing_status, pricing_tier, price_version,
  matched_model_id, token_semantics, unallocated_cost, breakdown_status
)
SELECT
  fixture.id, fixture.member_code,
  (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - fixture.age_ms,
  fixture.session_id, 'visible', 'rpc-agent', 'openai', fixture.model, 'coding',
  fixture.input_tokens, fixture.output_tokens, fixture.reasoning_tokens,
  fixture.cache_read_tokens, fixture.cache_write_tokens, fixture.total_tokens,
  fixture.input_cost, fixture.output_cost, fixture.reasoning_cost,
  fixture.cache_read_cost, fixture.cache_write_cost, fixture.total_cost,
  'stop', 'rpc-project', fixture.pricing_status, 'standard', fixture.price_version,
  NULL, 'disjoint', fixture.unallocated_cost, fixture.breakdown_status
FROM (VALUES
  ('rpc-reported', 'RPC_FIX', 60000::BIGINT, 'rpc-s-reported', 'gpt-5.6-sol', 10, 5, 3, 2, 1, 21, 1::REAL, 2::REAL, 0.6::REAL, 0.2::REAL, 0.2::REAL, 4::REAL, 'reported'::TEXT, 'client-report-v1'::TEXT, 0::NUMERIC, 'reconciled'::TEXT),
  ('rpc-legacy', 'RPC_FIX', 120000::BIGINT, 'rpc-s-legacy', 'gpt-5.6-sol', 10, 5, 2, 2, 1, 20, 1::REAL, 1::REAL, 1::REAL, 1::REAL, 1::REAL, 5::REAL, NULL::TEXT, NULL::TEXT, 0::NUMERIC, 'reconciled'::TEXT),
  ('rpc-estimated', 'RPC_FIX', 180000::BIGINT, 'rpc-s-estimated', 'gpt-5.6-sol', 10, 5, 5, 5, 5, 30, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 'unpriced'::TEXT, NULL::TEXT, 0::NUMERIC, 'reconciled'::TEXT),
  ('rpc-zero-rate', 'RPC_FIX', 240000::BIGINT, 'rpc-s-zero', 'gpt-5.6-sol', 10, 10, 10, 5, 5, 40, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 'unpriced'::TEXT, NULL::TEXT, 0::NUMERIC, 'reconciled'::TEXT),
  ('rpc-unpriced', 'RPC_FIX', 300000::BIGINT, 'rpc-s-unpriced', 'gpt-5.6-sol', 20, 10, 10, 5, 5, 50, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 'unpriced'::TEXT, NULL::TEXT, 0::NUMERIC, 'reconciled'::TEXT),
  ('rpc-telemetry', 'RPC_FIX', 360000::BIGINT, 'rpc-s-telemetry', 'gpt-5.6-sol', 0, 0, 0, 0, 0, 0, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 'unpriced'::TEXT, NULL::TEXT, 0::NUMERIC, 'reconciled'::TEXT),
  ('rpc-previous-reported', 'RPC_FIX', 691200000::BIGINT, 'rpc-s-previous', 'gpt-5.6-sol', 2, 1, 1, 1, 1, 6, 1::REAL, 1::REAL, 1::REAL, 1::REAL, 1::REAL, 5::REAL, 'reported'::TEXT, 'client-report-v1'::TEXT, 0::NUMERIC, 'reconciled'::TEXT),
  ('rpc-no-usage-event', 'RPC_NO_USAGE', 60000::BIGINT, 'rpc-no-usage-s', 'gpt-5.6-sol', 0, 0, 0, 0, 0, 0, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 'unpriced'::TEXT, NULL::TEXT, 0::NUMERIC, 'reconciled'::TEXT),
  ('rpc-unpriced-event', 'RPC_UNPRICED', 60000::BIGINT, 'rpc-unpriced-s', 'not-priced', 1, 0, 0, 0, 0, 1, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 'unpriced'::TEXT, NULL::TEXT, 0::NUMERIC, 'reconciled'::TEXT),
  ('rpc-zero-event', 'RPC_ZERO', 60000::BIGINT, 'rpc-zero-s', 'gpt-5.6-sol', 1, 0, 0, 0, 0, 1, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 'unpriced'::TEXT, NULL::TEXT, 0::NUMERIC, 'reconciled'::TEXT),
  ('rpc-legacy-event', 'RPC_LEGACY', 60000::BIGINT, 'rpc-legacy-s', 'gpt-5.6-sol', 1, 0, 0, 0, 0, 1, 1::REAL, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 1::REAL, NULL::TEXT, NULL::TEXT, 0::NUMERIC, 'reconciled'::TEXT),
  ('rpc-complete-event', 'RPC_COMPLETE', 60000::BIGINT, 'rpc-complete-s', 'gpt-5.6-sol', 1, 0, 0, 0, 0, 1, 1::REAL, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 1::REAL, 'reported'::TEXT, 'client-report-v1'::TEXT, 0::NUMERIC, 'reconciled'::TEXT),
  ('rpc-mismatch-event', 'RPC_MISMATCH', 60000::BIGINT, 'rpc-mismatch-s', 'not-priced', 0, 0, 0, 0, 0, 1, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 'unpriced'::TEXT, NULL::TEXT, 0::NUMERIC, 'reconciled'::TEXT),
  ('rpc-invalid-event', 'RPC_INVALID', 60000::BIGINT, 'rpc-invalid-s', 'gpt-5.6-sol', 1, 0, 0, 0, 0, 1, 5::REAL, 0::REAL, 0::REAL, 0::REAL, 0::REAL, 1::REAL, 'reported'::TEXT, 'client-report-v1'::TEXT, 0::NUMERIC, 'invalid'::TEXT)
) AS fixture(
  id, member_code, age_ms, session_id, model,
  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
  total_tokens, input_cost, output_cost, reasoning_cost, cache_read_cost, cache_write_cost,
  total_cost, pricing_status, price_version, unallocated_cost, breakdown_status
);

INSERT INTO public.tokend_message_events (
  id, member_code, timestamp_ms, session_id, agent, channel, kind
) VALUES
  ('rpc-msg-current-user-1', 'RPC_FIX', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - 50000, 'rpc-s-reported', 'rpc-agent', 'coding', 'user'),
  ('rpc-msg-current-user-2', 'RPC_FIX', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - 49000, 'rpc-s-reported', 'rpc-agent', 'coding', 'user'),
  ('rpc-msg-current-assistant', 'RPC_FIX', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - 48000, 'rpc-s-reported', 'rpc-agent', 'coding', 'assistant'),
  ('rpc-msg-current-tool', 'RPC_FIX', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - 47000, 'rpc-s-reported', 'rpc-agent', 'coding', 'tool_call'),
  ('rpc-msg-hidden-session', 'RPC_FIX', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - 46000, 'not-visible', 'rpc-agent', 'coding', 'user'),
  ('rpc-msg-previous-user', 'RPC_FIX', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - 691100000, 'rpc-s-previous', 'rpc-agent', 'coding', 'user'),
  ('rpc-msg-previous-assistant', 'RPC_FIX', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - 691000000, 'rpc-s-previous', 'rpc-agent', 'coding', 'assistant');

INSERT INTO public.tokend_usage_events (
  id, member_code, timestamp_ms, session_id, session_key, agent, provider, model, channel,
  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
  total_tokens, input_cost, output_cost, reasoning_cost, cache_read_cost, cache_write_cost,
  total_cost, stop_reason, project, pricing_status, pricing_tier, price_version,
  matched_model_id, token_semantics, unallocated_cost, breakdown_status
) VALUES
  ('rpc-breakdown-legacy-gap', 'RPC_BREAKDOWN', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - 10000,
    'rpc-breakdown-s1', 'visible', 'breakdown-agent', 'openai', 'gpt-5.6-sol', 'coding',
    1, 0, 0, 0, 0, 1, 6, 0, 0, 0, 0, 10, 'stop', 'breakdown-project',
    NULL, 'standard', NULL, NULL, 'disjoint', 99, NULL),
  ('rpc-breakdown-reported-invalid', 'RPC_BREAKDOWN', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - 9000,
    'rpc-breakdown-s2', 'visible', 'breakdown-agent', 'openai', 'gpt-5.6-sol', 'coding',
    1, 0, 0, 0, 0, 1, 6, 5, 0, 0, 0, 10, 'stop', 'breakdown-project',
    'reported', 'standard', 'client-report-v1', NULL, 'disjoint', 7, 'reconciled'),
  ('rpc-breakdown-legacy-invalid', 'RPC_BREAKDOWN', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - 8000,
    'rpc-breakdown-s3', 'visible', 'breakdown-agent', 'openai', 'gpt-5.6-sol', 'coding',
    1, 0, 0, 0, 0, 1, 7, 4, 0, 0, 0, 10, 'stop', 'breakdown-project',
    NULL, 'standard', NULL, NULL, 'disjoint', 8, NULL),
  ('rpc-cross-old', 'RPC_CROSS_SESSION', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - 691200000,
    'rpc-cross-main', 'old-key', 'old-agent', 'openai', 'gpt-5.6-luna', 'coding-old',
    2, 0, 0, 0, 0, 2, 2, 0, 0, 0, 0, 2, 'stop', 'old-project',
    'reported', 'standard', 'client-report-v1', NULL, 'disjoint', 0, 'reconciled'),
  ('rpc-cross-new', 'RPC_CROSS_SESSION', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - 40000,
    'rpc-cross-main', 'new-key', 'new-agent', 'openai', 'gpt-5.6-sol', 'coding-new',
    3, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 3, 'stop', 'new-project',
    'reported', 'standard', 'client-report-v1', NULL, 'disjoint', 0, 'reconciled'),
  ('rpc-cross-other', 'RPC_CROSS_SESSION', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - 80000,
    'rpc-cross-other', 'other-key', 'other-agent', 'openai', 'gpt-5.6-terra', 'coding-other',
    4, 0, 0, 0, 0, 4, 4, 0, 0, 0, 0, 4, 'stop', 'other-project',
    'reported', 'standard', 'client-report-v1', NULL, 'disjoint', 0, 'reconciled'),
  ('rpc-cross-old-only', 'RPC_CROSS_SESSION', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - 691100000,
    'rpc-cross-old-only', 'stale-key', 'stale-agent', 'openai', 'gpt-5.6-luna', 'coding-stale',
    5, 0, 0, 0, 0, 5, 5, 0, 0, 0, 0, 5, 'stop', 'stale-project',
    'reported', 'standard', 'client-report-v1', NULL, 'disjoint', 0, 'reconciled'),
  ('rpc-tie-a', 'RPC_CROSS_SESSION', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - 100000,
    'rpc-tie-main', 'tie-a-key', 'tie-a-agent', 'openai', 'gpt-5.6-luna', 'coding-tie-a',
    1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 'stop', 'tie-a-project',
    'reported', 'standard', 'client-report-v1', NULL, 'disjoint', 0, 'reconciled'),
  ('rpc-tie-b', 'RPC_CROSS_SESSION', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - 100000,
    'rpc-tie-main', 'tie-b-key', 'tie-b-agent', 'openai', 'gpt-5.6-terra', 'coding-tie-b',
    1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 'stop', 'tie-b-project',
    'reported', 'standard', 'client-report-v1', NULL, 'disjoint', 0, 'reconciled'),
  ('rpc-float-reconciled', 'RPC_FLOAT', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - 7000,
    'rpc-float-s', 'float-key', 'float-agent', 'openai', 'gpt-5.6-sol', 'coding',
    75009, 15208, 9826, 19405, 65473, 184921,
    0.375045::REAL, 0.45624::REAL, 0.29478::REAL, 0.0097025::REAL, 0.409206::REAL,
    1.54497::REAL, 'stop', 'float-project',
    'reported', 'standard', 'client-report-v1', NULL, 'disjoint', 0, NULL),
  ('rpc-float-bound-reconciled', 'RPC_FLOAT', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - 6750,
    'rpc-float-bound-s', 'float-bound-key', 'float-agent', 'openai', 'gpt-5.6-sol', 'coding',
    67569, 12815, 11452, 35374, 2074, 129284,
    0.337845::REAL, 0.38445::REAL, 0.34356::REAL, 0.017687::REAL, 0.0129625::REAL,
    1.0965::REAL, 'stop', 'float-bound-project',
    'reported', 'standard', 'client-report-v1', NULL, 'disjoint', 0, NULL),
  ('rpc-tiny-base-invalid', 'RPC_TINY_BASE', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - 6500,
    'rpc-tiny-base-s', 'tiny-key', 'tiny-agent', 'openai', 'gpt-5.6-sol', 'coding',
    1, 0, 0, 0, 0, 1,
    0.000002::REAL, 0, 0, 0, 0, 0.000001::REAL, 'stop', 'tiny-project',
    'reported', 'standard', 'client-report-v1', NULL, 'disjoint', 0, NULL),
  ('rpc-tiny-revision-gap', 'RPC_TINY_REVISION', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - 6250,
    'rpc-tiny-revision-s', 'tiny-revision-key', 'tiny-revision-agent', 'openai', 'gpt-5.6-sol', 'coding',
    1, 0, 0, 0, 0, 1,
    0, 0, 0, 0, 0, 0, 'stop', 'tiny-revision-project',
    'unpriced', 'standard', NULL, NULL, 'disjoint', 0, 'reconciled'),
  ('rpc-overflow-event', 'RPC_OVERFLOW', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - 6000,
    'rpc-overflow-s', 'overflow-key', 'overflow-agent', 'openai', 'gpt-5.6-sol', 'coding',
    500000000, 500000000, 500000000, 500000000, 500000000, 1,
    0, 0, 0, 0, 0, 0, 'stop', 'overflow-project',
    'reported', 'standard', 'client-report-v1', NULL, 'disjoint', 0, 'reconciled');

INSERT INTO public.tokend_event_cost_revisions (
  version, member_code, event_id, backfill_run_id,
  input_cost, output_cost, reasoning_cost, cache_read_cost, cache_write_cost,
  unallocated_cost, total_cost, pricing_status, pricing_tier, matched_model_id,
  price_version, breakdown_status
) VALUES
  ('2026-07-10', 'RPC_FIX', 'rpc-reported', '00000000-0000-0000-0000-000000000003', 20, 20, 20, 20, 19, 0, 99, 'estimated', 'standard', 'gpt-5.6-sol', '2026-07-10', 'reconciled'),
  ('2026-07-10', 'RPC_FIX', 'rpc-legacy', '00000000-0000-0000-0000-000000000003', 20, 20, 20, 20, 19, 0, 99, 'estimated', 'standard', 'gpt-5.6-sol', '2026-07-10', 'reconciled'),
  ('2026-07-10', 'RPC_FIX', 'rpc-estimated', '00000000-0000-0000-0000-000000000003', 1, 2, 1, 1, 1, 0, 6, 'estimated', 'standard', 'gpt-5.6-sol', '2026-07-10', 'reconciled'),
  ('2026-07-09', 'RPC_FIX', 'rpc-estimated', '00000000-0000-0000-0000-000000000002', 10, 20, 10, 10, 10, 0, 60, 'estimated', 'standard', 'gpt-5.6-sol', '2026-07-09', 'reconciled'),
  ('2026-07-10', 'RPC_FIX', 'rpc-zero-rate', NULL, 0, 0, 0, 0, 0, 0, 0, 'zero_rate', 'standard', 'gpt-5.6-sol', '2026-07-10', 'reconciled'),
  ('2026-07-10', 'RPC_FIX', 'rpc-unpriced', NULL, 0, 0, 0, 0, 0, 0, 0, 'unpriced', 'standard', NULL, NULL, 'reconciled'),
  ('2026-07-10', 'RPC_ZERO', 'rpc-zero-event', NULL, 0, 0, 0, 0, 0, 0, 0, 'zero_rate', 'standard', 'gpt-5.6-sol', '2026-07-10', 'reconciled'),
  ('2026-07-10', 'RPC_TINY_REVISION', 'rpc-tiny-revision-gap', NULL,
    1.0000000000, 0, 0, 0, 0, 0.0000000001, 1.0000000001,
    'estimated', 'standard', 'gpt-5.6-sol', '2026-07-10', 'unallocated');

CREATE FUNCTION pg_temp.rpc_envelope(p_payload JSONB)
RETURNS JSONB
LANGUAGE SQL
IMMUTABLE
AS $test$
  SELECT jsonb_build_object(
    'inputTokens', COALESCE((p_payload->>'inputTokens')::BIGINT, 0),
    'outputTokens', COALESCE((p_payload->>'outputTokens')::BIGINT, 0),
    'reasoningTokens', COALESCE((p_payload->>'reasoningTokens')::BIGINT, 0),
    'cacheReadTokens', COALESCE((p_payload->>'cacheReadTokens')::BIGINT, 0),
    'cacheWriteTokens', COALESCE((p_payload->>'cacheWriteTokens')::BIGINT, 0),
    'totalTokens', COALESCE((p_payload->>'totalTokens')::BIGINT, 0),
    'inputCost', COALESCE((p_payload->>'inputCost')::NUMERIC, 0),
    'outputCost', COALESCE((p_payload->>'outputCost')::NUMERIC, 0),
    'reasoningCost', COALESCE((p_payload->>'reasoningCost')::NUMERIC, 0),
    'cacheReadCost', COALESCE((p_payload->>'cacheReadCost')::NUMERIC, 0),
    'cacheWriteCost', COALESCE((p_payload->>'cacheWriteCost')::NUMERIC, 0),
    'unallocatedCost', COALESCE((p_payload->>'unallocatedCost')::NUMERIC, 0),
    'totalCost', COALESCE((p_payload->>'totalCost')::NUMERIC, 0),
    'eligibleEventCount', COALESCE((p_payload->>'eligibleEventCount')::BIGINT, 0),
    'reportedEventCount', COALESCE((p_payload->>'reportedEventCount')::BIGINT, 0),
    'estimatedEventCount', COALESCE((p_payload->>'estimatedEventCount')::BIGINT, 0),
    'zeroRateEventCount', COALESCE((p_payload->>'zeroRateEventCount')::BIGINT, 0),
    'legacyEventCount', COALESCE((p_payload->>'legacyEventCount')::BIGINT, 0),
    'unpricedEventCount', COALESCE((p_payload->>'unpricedEventCount')::BIGINT, 0),
    'breakdownInvalidCount', COALESCE((p_payload->>'breakdownInvalidCount')::BIGINT, 0),
    'costAvailability', COALESCE((p_payload->>'costAvailability')::NUMERIC, 0),
    'verifiedCostCoverage', COALESCE((p_payload->>'verifiedCostCoverage')::NUMERIC, 0),
    'coverageStatus', p_payload->>'coverageStatus',
    'costDetailsAvailable', p_payload->'costDetailsAvailable'
  )
$test$;

CREATE FUNCTION pg_temp.rpc_aggregate_envelopes(p_rows JSONB)
RETURNS JSONB
LANGUAGE SQL
IMMUTABLE
AS $test$
  WITH aggregate AS (
    SELECT
      COALESCE(SUM((row->>'inputTokens')::BIGINT), 0)::BIGINT AS input_tokens,
      COALESCE(SUM((row->>'outputTokens')::BIGINT), 0)::BIGINT AS output_tokens,
      COALESCE(SUM((row->>'reasoningTokens')::BIGINT), 0)::BIGINT AS reasoning_tokens,
      COALESCE(SUM((row->>'cacheReadTokens')::BIGINT), 0)::BIGINT AS cache_read_tokens,
      COALESCE(SUM((row->>'cacheWriteTokens')::BIGINT), 0)::BIGINT AS cache_write_tokens,
      COALESCE(SUM((row->>'totalTokens')::BIGINT), 0)::BIGINT AS total_tokens,
      COALESCE(SUM((row->>'inputCost')::NUMERIC), 0)::NUMERIC AS input_cost,
      COALESCE(SUM((row->>'outputCost')::NUMERIC), 0)::NUMERIC AS output_cost,
      COALESCE(SUM((row->>'reasoningCost')::NUMERIC), 0)::NUMERIC AS reasoning_cost,
      COALESCE(SUM((row->>'cacheReadCost')::NUMERIC), 0)::NUMERIC AS cache_read_cost,
      COALESCE(SUM((row->>'cacheWriteCost')::NUMERIC), 0)::NUMERIC AS cache_write_cost,
      COALESCE(SUM((row->>'unallocatedCost')::NUMERIC), 0)::NUMERIC AS unallocated_cost,
      COALESCE(SUM((row->>'totalCost')::NUMERIC), 0)::NUMERIC AS total_cost,
      COALESCE(SUM((row->>'eligibleEventCount')::BIGINT), 0)::BIGINT AS eligible_event_count,
      COALESCE(SUM((row->>'reportedEventCount')::BIGINT), 0)::BIGINT AS reported_event_count,
      COALESCE(SUM((row->>'estimatedEventCount')::BIGINT), 0)::BIGINT AS estimated_event_count,
      COALESCE(SUM((row->>'zeroRateEventCount')::BIGINT), 0)::BIGINT AS zero_rate_event_count,
      COALESCE(SUM((row->>'legacyEventCount')::BIGINT), 0)::BIGINT AS legacy_event_count,
      COALESCE(SUM((row->>'unpricedEventCount')::BIGINT), 0)::BIGINT AS unpriced_event_count,
      COALESCE(SUM((row->>'breakdownInvalidCount')::BIGINT), 0)::BIGINT AS breakdown_invalid_count
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::JSONB)) AS row
  ), envelope AS (
    SELECT aggregate.*,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC,
        (reported_event_count + estimated_event_count + zero_rate_event_count + legacy_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS cost_availability,
      CASE WHEN eligible_event_count = 0 THEN 0::NUMERIC ELSE LEAST(1::NUMERIC, GREATEST(0::NUMERIC,
        (reported_event_count + estimated_event_count + zero_rate_event_count)::NUMERIC / eligible_event_count::NUMERIC)) END AS verified_cost_coverage,
      CASE WHEN eligible_event_count = 0 THEN 'no_usage'
        WHEN unpriced_event_count = eligible_event_count THEN 'unpriced'
        WHEN zero_rate_event_count = eligible_event_count THEN 'zero_rate'
        WHEN unpriced_event_count > 0 AND unpriced_event_count < eligible_event_count THEN 'partial'
        WHEN unpriced_event_count = 0 AND legacy_event_count > 0 THEN 'legacy'
        ELSE 'complete' END AS coverage_status
    FROM aggregate
  )
  SELECT jsonb_build_object(
    'inputTokens', input_tokens, 'outputTokens', output_tokens,
    'reasoningTokens', reasoning_tokens, 'cacheReadTokens', cache_read_tokens,
    'cacheWriteTokens', cache_write_tokens, 'totalTokens', total_tokens,
    'inputCost', input_cost, 'outputCost', output_cost, 'reasoningCost', reasoning_cost,
    'cacheReadCost', cache_read_cost, 'cacheWriteCost', cache_write_cost,
    'unallocatedCost', unallocated_cost, 'totalCost', total_cost,
    'eligibleEventCount', eligible_event_count, 'reportedEventCount', reported_event_count,
    'estimatedEventCount', estimated_event_count, 'zeroRateEventCount', zero_rate_event_count,
    'legacyEventCount', legacy_event_count, 'unpricedEventCount', unpriced_event_count,
    'breakdownInvalidCount', breakdown_invalid_count, 'costAvailability', cost_availability,
    'verifiedCostCoverage', verified_cost_coverage, 'coverageStatus', coverage_status,
    'costDetailsAvailable', TRUE
  ) FROM envelope
$test$;

SELECT results_eq(
  $actual$
    SELECT id, effective_pricing_status, effective_total_cost
    FROM public.tokend_effective_usage_events
    WHERE member_code = 'RPC_FIX'
      AND id IN ('rpc-reported', 'rpc-legacy', 'rpc-estimated', 'rpc-zero-rate', 'rpc-unpriced')
    ORDER BY id
  $actual$,
  $expected$
    VALUES
      ('rpc-estimated'::TEXT, 'estimated'::TEXT, 6::NUMERIC),
      ('rpc-legacy'::TEXT, 'legacy'::TEXT, 5::NUMERIC),
      ('rpc-reported'::TEXT, 'reported'::TEXT, 4::NUMERIC),
      ('rpc-unpriced'::TEXT, 'unpriced'::TEXT, 0::NUMERIC),
      ('rpc-zero-rate'::TEXT, 'zero_rate'::TEXT, 0::NUMERIC)
  $expected$,
  'effective relation applies the one documented precedence chain'
);

SELECT is(
  (SELECT effective_total_cost FROM public.tokend_effective_usage_events WHERE member_code = 'RPC_FIX' AND id = 'rpc-estimated'),
  6::NUMERIC,
  'effective relation ignores stale catalog revisions'
);

SELECT is(
  (SELECT effective_backfill_run_id::TEXT FROM public.tokend_effective_usage_events WHERE member_code = 'RPC_FIX' AND id = 'rpc-estimated'),
  '00000000-0000-0000-0000-000000000003',
  'backfill run id remains audit metadata'
);

SELECT results_eq(
  $actual$
    SELECT id, effective_pricing_status, effective_total_cost
    FROM public.tokend_effective_usage_events
    WHERE member_code = 'RPC_FIX' AND id IN ('rpc-reported', 'rpc-legacy')
    ORDER BY id
  $actual$,
  $expected$
    VALUES
      ('rpc-legacy'::TEXT, 'legacy'::TEXT, 5::NUMERIC),
      ('rpc-reported'::TEXT, 'reported'::TEXT, 4::NUMERIC)
  $expected$,
  'reported and legacy base costs beat active revisions'
);

SELECT results_eq(
  $actual$
    SELECT
      (payload->>'callCount')::BIGINT,
      (payload->>'sessionCount')::BIGINT,
      (payload->>'eligibleEventCount')::BIGINT
    FROM (SELECT public.tokend_get_summary_v5('rpc-token')::JSONB AS payload) AS summary
  $actual$,
  $expected$ VALUES (6::BIGINT, 6::BIGINT, 5::BIGINT) $expected$,
  'zero-token telemetry remains in raw calls and sessions but not the coverage denominator'
);

SELECT results_eq(
  $actual$
    SELECT scope, message_count, user_message_count
    FROM (
      SELECT 'current'::TEXT AS scope,
        (payload->'current'->>'messageCount')::BIGINT AS message_count,
        (payload->'current'->>'userMessageCount')::BIGINT AS user_message_count
      FROM (SELECT public.tokend_get_summary_v5('rpc-token')::JSONB AS payload) AS summary
      UNION ALL
      SELECT 'previous',
        (payload->'previous'->>'messageCount')::BIGINT,
        (payload->'previous'->>'userMessageCount')::BIGINT
      FROM (SELECT public.tokend_get_summary_v5('rpc-token')::JSONB AS payload) AS summary
      UNION ALL
      SELECT 'fallback',
        (payload->'current'->>'messageCount')::BIGINT,
        NULLIF(payload->'current'->>'userMessageCount', '')::BIGINT
      FROM (SELECT public.tokend_get_summary_v5('rpc-complete')::JSONB AS payload) AS summary
      UNION ALL
      SELECT 'channel',
        (row->>'messageCount')::BIGINT,
        (row->>'userMessageCount')::BIGINT
      FROM jsonb_array_elements(public.tokend_get_channel_breakdown_v4('rpc-token')::JSONB->'channels') AS row
      WHERE row->>'channel' = 'coding'
    ) AS message_totals
    ORDER BY scope
  $actual$,
  $expected$
    VALUES
      ('channel'::TEXT, 4::BIGINT, 2::BIGINT),
      ('current'::TEXT, 3::BIGINT, 2::BIGINT),
      ('fallback'::TEXT, 1::BIGINT, NULL::BIGINT),
      ('previous'::TEXT, 2::BIGINT, 1::BIGINT)
  $expected$,
  'summary v5 preserves v14 visible-session message counts and no-message fallback'
);

SELECT results_eq(
  $actual$
    SELECT token, public.tokend_get_summary_v5(token)::JSONB->>'coverageStatus'
    FROM (VALUES
      ('rpc-no-usage'::TEXT), ('rpc-unpriced'::TEXT), ('rpc-zero'::TEXT),
      ('rpc-token'::TEXT), ('rpc-legacy'::TEXT), ('rpc-complete'::TEXT)
    ) AS cases(token)
    ORDER BY token
  $actual$,
  $expected$
    VALUES
      ('rpc-complete'::TEXT, 'complete'::TEXT),
      ('rpc-legacy'::TEXT, 'legacy'::TEXT),
      ('rpc-no-usage'::TEXT, 'no_usage'::TEXT),
      ('rpc-token'::TEXT, 'partial'::TEXT),
      ('rpc-unpriced'::TEXT, 'unpriced'::TEXT),
      ('rpc-zero'::TEXT, 'zero_rate'::TEXT)
  $expected$,
  'six coverage statuses follow the exact priority order'
);

SELECT results_eq(
  $actual$
    SELECT
      (payload->>'costAvailability')::NUMERIC,
      (payload->>'verifiedCostCoverage')::NUMERIC
    FROM (SELECT public.tokend_get_summary_v5('rpc-token')::JSONB AS payload) AS summary
  $actual$,
  $expected$ VALUES (0.8::NUMERIC, 0.6::NUMERIC) $expected$,
  'mixed coverage is exactly 0.8 available and 0.6 verified'
);

SELECT results_eq(
  $actual$
    SELECT
      (payload->>'eligibleEventCount')::BIGINT,
      (payload->>'totalTokens')::BIGINT,
      payload->>'coverageStatus'
    FROM (SELECT public.tokend_get_summary_v5('rpc-mismatch')::JSONB AS payload) AS summary
  $actual$,
  $expected$ VALUES (1::BIGINT, 0::BIGINT, 'unpriced'::TEXT) $expected$,
  'deployed total_tokens alone controls coverage eligibility while explicit buckets control token arithmetic'
);

SELECT results_eq(
  $actual$
    SELECT
      (payload->>'breakdownInvalidCount')::BIGINT,
      (payload->>'unallocatedCost')::NUMERIC,
      (payload->>'cacheReadCost')::NUMERIC,
      (payload->>'totalCost')::NUMERIC
    FROM (SELECT public.tokend_get_summary_v5('rpc-invalid')::JSONB AS payload) AS summary
  $actual$,
  $expected$ VALUES (1::BIGINT, 0::NUMERIC, 0::NUMERIC, 1::NUMERIC) $expected$,
  'invalid component breakdown never becomes unallocated or residual cache cost'
);

SELECT results_eq(
  $actual$
    SELECT id, effective_breakdown_status, effective_unallocated_cost,
      effective_total_cost,
      effective_input_cost + effective_output_cost + effective_reasoning_cost
        + effective_cache_read_cost + effective_cache_write_cost + effective_unallocated_cost AS six_part_total
    FROM public.tokend_effective_usage_events
    WHERE member_code = 'RPC_BREAKDOWN'
    ORDER BY id
  $actual$,
  $expected$
    VALUES
      ('rpc-breakdown-legacy-gap'::TEXT, 'unallocated'::TEXT, 4::NUMERIC, 10::NUMERIC, 10::NUMERIC),
      ('rpc-breakdown-legacy-invalid'::TEXT, 'invalid'::TEXT, 0::NUMERIC, 10::NUMERIC, 11::NUMERIC),
      ('rpc-breakdown-reported-invalid'::TEXT, 'invalid'::TEXT, 0::NUMERIC, 10::NUMERIC, 11::NUMERIC)
  $expected$,
  'reported and legacy effective breakdowns reconcile authoritative totals'
);

SELECT results_eq(
  $actual$
    SELECT
      (payload->>'breakdownInvalidCount')::BIGINT,
      (payload->>'unallocatedCost')::NUMERIC,
      (payload->>'totalCost')::NUMERIC
    FROM (SELECT public.tokend_get_summary_v5('rpc-breakdown')::JSONB AS payload) AS summary
  $actual$,
  $expected$ VALUES (2::BIGINT, 4::NUMERIC, 30::NUMERIC) $expected$,
  'breakdown reconciliation propagates through every aggregate envelope'
);

SELECT results_eq(
  $actual$
    SELECT effective_breakdown_status, effective_unallocated_cost,
      effective_input_cost + effective_output_cost + effective_reasoning_cost
        + effective_cache_read_cost + effective_cache_write_cost = effective_total_cost,
      effective_input_cost IS DISTINCT FROM input_cost::NUMERIC
        OR effective_output_cost IS DISTINCT FROM output_cost::NUMERIC
        OR effective_reasoning_cost IS DISTINCT FROM reasoning_cost::NUMERIC
        OR effective_cache_read_cost IS DISTINCT FROM cache_read_cost::NUMERIC
        OR effective_cache_write_cost IS DISTINCT FROM cache_write_cost::NUMERIC,
      (public.tokend_get_summary_v5('rpc-float')::JSONB->>'breakdownInvalidCount')::BIGINT
    FROM public.tokend_effective_usage_events
    WHERE member_code = 'RPC_FLOAT'
    ORDER BY id
  $actual$,
  $expected$
    VALUES
      ('reconciled'::TEXT, 0::NUMERIC, true, true, 0::BIGINT),
      ('reconciled'::TEXT, 0::NUMERIC, true, true, 0::BIGINT)
  $expected$,
  'REAL base costs use the aggregate float4 rounding bound and normalize exactly'
);

SELECT results_eq(
  $actual$
    SELECT effective_breakdown_status, effective_unallocated_cost
    FROM public.tokend_effective_usage_events
    WHERE member_code = 'RPC_TINY_BASE' AND id = 'rpc-tiny-base-invalid'
  $actual$,
  $expected$ VALUES ('invalid'::TEXT, 0::NUMERIC) $expected$,
  'small significant base mismatch is not hidden by a fixed epsilon floor'
);

SELECT results_eq(
  $actual$
    SELECT effective_breakdown_status, effective_unallocated_cost,
      effective_total_cost
        - effective_input_cost - effective_output_cost - effective_reasoning_cost
        - effective_cache_read_cost - effective_cache_write_cost
    FROM public.tokend_effective_usage_events
    WHERE member_code = 'RPC_TINY_REVISION' AND id = 'rpc-tiny-revision-gap'
  $actual$,
  $expected$ VALUES ('unallocated'::TEXT, 0.0000000001::NUMERIC, 0.0000000001::NUMERIC) $expected$,
  'NUMERIC revision discrepancies use zero epsilon'
);

SELECT lives_ok(
  $sql$SELECT public.tokend_get_session_detail_v2('rpc-overflow', 'rpc-overflow-s')$sql$,
  'session detail event token arithmetic widens before summing five buckets'
);

SELECT results_eq(
  $actual$
    SELECT
      (event->>'totalTokens')::BIGINT,
      (event->>'eligibleEventCount')::BIGINT,
      (detail->>'totalTokens')::BIGINT,
      (detail->>'eligibleEventCount')::BIGINT
    FROM (SELECT public.tokend_get_session_detail_v2('rpc-overflow', 'rpc-overflow-s')::JSONB AS detail) AS payload
    CROSS JOIN LATERAL jsonb_array_elements(payload.detail->'events') AS events(event)
  $actual$,
  $expected$ VALUES (2500000000::BIGINT, 1::BIGINT, 2500000000::BIGINT, 1::BIGINT) $expected$,
  'overflow-safe event totals keep coverage eligibility on deployed total_tokens'
);

SELECT is(
  pg_temp.rpc_envelope(public.tokend_get_summary_v5('rpc-token')::JSONB),
  pg_temp.rpc_aggregate_envelopes(public.tokend_get_summary_v5('rpc-token')::JSONB->'modelDistribution'),
  'summary child lists expose complete envelopes and reconcile on the controlled fixture'
);

SELECT is(
  pg_temp.rpc_envelope(public.tokend_get_summary_v5('rpc-token')::JSONB),
  pg_temp.rpc_aggregate_envelopes(public.tokend_get_summary_v5('rpc-token')::JSONB->'topConversations'),
  'summary top conversations preserve the complete effective-cost envelope'
);

SELECT results_eq(
  $actual$
    SELECT
      pg_temp.rpc_envelope(parent.row),
      pg_temp.rpc_envelope(public.tokend_get_session_detail_v2('rpc-cross-session', 'rpc-cross-main')::JSONB),
      parent.row->>'sessionKey', parent.row->>'agent', parent.row->>'title',
      parent.row->>'channel', parent.row->>'currentModel',
      (parent.row->>'callCount')::BIGINT, (parent.row->>'totalTokens')::BIGINT
    FROM jsonb_array_elements(public.tokend_get_sessions_v2('rpc-cross-session')::JSONB->'sessions') AS parent(row)
    WHERE parent.row->>'sessionId' = 'rpc-cross-main'
  $actual$,
  $expected$
    SELECT expected_envelope, expected_envelope,
      'new-key'::TEXT, 'new-agent'::TEXT, 'new-project'::TEXT,
      'coding-new'::TEXT, 'gpt-5.6-sol'::TEXT, 2::BIGINT, 5::BIGINT
    FROM (SELECT pg_temp.rpc_envelope(jsonb_build_object(
      'inputTokens', 5, 'outputTokens', 0, 'reasoningTokens', 0, 'cacheReadTokens', 0,
      'cacheWriteTokens', 0, 'totalTokens', 5, 'inputCost', 5, 'outputCost', 0,
      'reasoningCost', 0, 'cacheReadCost', 0, 'cacheWriteCost', 0, 'unallocatedCost', 0,
      'totalCost', 5, 'eligibleEventCount', 2, 'reportedEventCount', 2,
      'estimatedEventCount', 0, 'zeroRateEventCount', 0, 'legacyEventCount', 0,
      'unpricedEventCount', 0, 'breakdownInvalidCount', 0, 'costAvailability', 1,
      'verifiedCostCoverage', 1, 'coverageStatus', 'complete', 'costDetailsAvailable', TRUE
    )) AS expected_envelope) AS expected
  $expected$,
  'cross-window sessions use full history and latest non-empty metadata'
);

SELECT results_eq(
  $actual$
    SELECT
      parent.row->>'sessionKey', parent.row->>'agent', parent.row->>'title',
      parent.row->>'channel', parent.row->>'currentModel',
      detail->>'sessionKey', detail->>'agent', detail->>'title',
      detail->>'channel', detail->>'currentModel'
    FROM jsonb_array_elements(public.tokend_get_sessions_v2('rpc-cross-session')::JSONB->'sessions') AS parent(row)
    CROSS JOIN LATERAL (
      SELECT public.tokend_get_session_detail_v2('rpc-cross-session', 'rpc-tie-main')::JSONB AS detail
    ) AS session_detail
    WHERE parent.row->>'sessionId' = 'rpc-tie-main'
  $actual$,
  $expected$
    VALUES (
      'tie-b-key'::TEXT, 'tie-b-agent'::TEXT, 'tie-b-project'::TEXT,
      'coding-tie-b'::TEXT, 'gpt-5.6-terra'::TEXT,
      'tie-b-key'::TEXT, 'tie-b-agent'::TEXT, 'tie-b-project'::TEXT,
      'coding-tie-b'::TEXT, 'gpt-5.6-terra'::TEXT
    )
  $expected$,
  'same timestamp metadata resolves by id descending in parent and detail'
);

SELECT results_eq(
  $actual$
    SELECT scope, session_ids
    FROM (VALUES
      ('all'::TEXT, (SELECT jsonb_agg(row->>'sessionId' ORDER BY row->>'sessionId') FROM jsonb_array_elements(public.tokend_get_sessions_v2('rpc-cross-session', '7d', 50)::JSONB->'sessions') AS row)),
      ('huge'::TEXT, (SELECT jsonb_agg(row->>'sessionId' ORDER BY row->>'sessionId') FROM jsonb_array_elements(public.tokend_get_sessions_v2('rpc-cross-session', '7d', 999999)::JSONB->'sessions') AS row)),
      ('limit'::TEXT, (SELECT jsonb_agg(row->>'sessionId') FROM jsonb_array_elements(public.tokend_get_sessions_v2('rpc-cross-session', '7d', 1)::JSONB->'sessions') AS row)),
      ('negative'::TEXT, public.tokend_get_sessions_v2('rpc-cross-session', '7d', -1)::JSONB->'sessions')
    ) AS actual(scope, session_ids)
    ORDER BY scope
  $actual$,
  $expected$
    VALUES
      ('all'::TEXT, '["rpc-cross-main","rpc-cross-other","rpc-tie-main"]'::JSONB),
      ('huge'::TEXT, '["rpc-cross-main","rpc-cross-other","rpc-tie-main"]'::JSONB),
      ('limit'::TEXT, '["rpc-cross-main"]'::JSONB),
      ('negative'::TEXT, '[]'::JSONB)
  $expected$,
  'sessions period selection and limit remain exact; session limits clamp negative and oversized anonymous requests'
);

SELECT results_eq(
  $actual$
    SELECT
      pg_temp.rpc_envelope(public.tokend_get_summary_v5('rpc-token', '7d', 'Not/A_Timezone')::JSONB),
      public.tokend_get_daily_trend_v5('rpc-token', '7d', 'Not/A_Timezone')::JSONB->'days',
      pg_temp.rpc_envelope(public.tokend_get_channel_detail_v3('rpc-token', 'coding', '7d', 'Not/A_Timezone')::JSONB)
  $actual$,
  $expected$
    SELECT
      pg_temp.rpc_envelope(public.tokend_get_summary_v5('rpc-token', '7d', 'Asia/Shanghai')::JSONB),
      public.tokend_get_daily_trend_v5('rpc-token', '7d', 'Asia/Shanghai')::JSONB->'days',
      pg_temp.rpc_envelope(public.tokend_get_channel_detail_v3('rpc-token', 'coding', '7d', 'Asia/Shanghai')::JSONB)
  $expected$,
  'invalid timezone falls back to Asia Shanghai across timezone-aware RPCs'
);

SELECT is(
  pg_temp.rpc_envelope(public.tokend_get_summary_v5('rpc-token')::JSONB),
  pg_temp.rpc_aggregate_envelopes(public.tokend_get_daily_trend_v5('rpc-token')::JSONB->'days'),
  'summary aggregate equals daily aggregate'
);

SELECT is(
  pg_temp.rpc_envelope(public.tokend_get_summary_v5('rpc-token')::JSONB),
  pg_temp.rpc_aggregate_envelopes(public.tokend_get_model_breakdown_v3('rpc-token')::JSONB->'models'),
  'summary aggregate equals model rows'
);

SELECT is(
  pg_temp.rpc_envelope(public.tokend_get_summary_v5('rpc-token')::JSONB),
  pg_temp.rpc_aggregate_envelopes(public.tokend_get_channel_breakdown_v4('rpc-token')::JSONB->'channels'),
  'summary aggregate equals channel rows'
);

SELECT is(
  pg_temp.rpc_envelope(public.tokend_get_summary_v5('rpc-token')::JSONB),
  pg_temp.rpc_aggregate_envelopes(public.tokend_get_sessions_v2('rpc-token')::JSONB->'sessions'),
  'summary aggregate equals controlled session rows'
);

SELECT is(
  pg_temp.rpc_envelope(public.tokend_get_summary_v5('rpc-token')::JSONB),
  pg_temp.rpc_aggregate_envelopes(public.tokend_get_top_projects_v3('rpc-token')::JSONB->'projects'),
  'summary equals the sum of daily, model, channel, session, and project aggregates for the all-coding fixture'
);

SELECT is(
  pg_temp.rpc_envelope(public.tokend_get_model_detail_v2('rpc-token', 'gpt-5.6-sol')::JSONB),
  (
    SELECT pg_temp.rpc_envelope(row)
    FROM jsonb_array_elements(public.tokend_get_model_breakdown_v3('rpc-token')::JSONB->'models') AS row
    WHERE row->>'model' = 'gpt-5.6-sol'
  ),
  'model detail aggregate equals its parent row'
);

SELECT is(
  pg_temp.rpc_envelope(public.tokend_get_channel_detail_v3('rpc-token', 'coding')::JSONB),
  (
    SELECT pg_temp.rpc_envelope(row)
    FROM jsonb_array_elements(public.tokend_get_channel_breakdown_v4('rpc-token')::JSONB->'channels') AS row
    WHERE row->>'channel' = 'coding'
  ),
  'channel detail aggregate equals its parent row'
);

SELECT is(
  pg_temp.rpc_envelope(public.tokend_get_session_detail_v2('rpc-token', 'rpc-s-estimated')::JSONB),
  (
    SELECT pg_temp.rpc_envelope(row)
    FROM jsonb_array_elements(public.tokend_get_sessions_v2('rpc-token')::JSONB->'sessions') AS row
    WHERE row->>'sessionId' = 'rpc-s-estimated'
  ),
  'detail aggregates equal their parent rows including session detail'
);

SELECT results_eq(
  $actual$
    SELECT name, payload
    FROM (VALUES
      ('channel_breakdown', public.tokend_get_channel_breakdown_v4('invalid')::JSONB),
      ('channel_detail', public.tokend_get_channel_detail_v3('invalid', 'coding')::JSONB),
      ('daily', public.tokend_get_daily_trend_v5('invalid')::JSONB),
      ('model_breakdown', public.tokend_get_model_breakdown_v3('invalid')::JSONB),
      ('model_detail', public.tokend_get_model_detail_v2('invalid', 'x')::JSONB),
      ('projects', public.tokend_get_top_projects_v3('invalid')::JSONB),
      ('session_detail', public.tokend_get_session_detail_v2('invalid', 'x')::JSONB),
      ('sessions', public.tokend_get_sessions_v2('invalid')::JSONB),
      ('summary', public.tokend_get_summary_v5('invalid')::JSONB)
    ) AS responses(name, payload)
    ORDER BY name
  $actual$,
  $expected$
    SELECT name, '{"ok":false,"error":"invalid_token"}'::JSONB
    FROM (VALUES
      ('channel_breakdown'::TEXT), ('channel_detail'::TEXT), ('daily'::TEXT),
      ('model_breakdown'::TEXT), ('model_detail'::TEXT), ('projects'::TEXT),
      ('session_detail'::TEXT), ('sessions'::TEXT), ('summary'::TEXT)
    ) AS names(name)
    ORDER BY name
  $expected$,
  'all vNext RPCs preserve the invalid-token shape'
);

SELECT results_eq(
  $actual$
    SELECT old.proname, old.argument_types, old.oid
    FROM legacy_function_oids AS old
    ORDER BY old.proname, old.argument_types
  $actual$,
  $expected$
    SELECT current.proname, oidvectortypes(current.proargtypes), current.oid
    FROM pg_proc AS current
    WHERE current.pronamespace = 'public'::regnamespace
      AND current.proname = ANY (ARRAY[
        'tokend_get_summary_v4', 'tokend_get_daily_trend_v4',
        'tokend_get_model_breakdown_v2', 'tokend_get_model_detail',
        'tokend_get_channel_breakdown_v3', 'tokend_get_channel_detail_v2',
        'tokend_get_sessions', 'tokend_get_session_detail', 'tokend_get_top_projects_v2'
      ])
    ORDER BY current.proname, oidvectortypes(current.proargtypes)
  $expected$,
  'legacy function OIDs survive the additive RPC migration'
);

SELECT results_eq(
  $actual$
    SELECT expected.name,
      count(proc.oid)::INTEGER,
      bool_and(proc.prorettype = 'json'::regtype),
      bool_and(proc.prosecdef),
      bool_and(proc.proconfig @> ARRAY['search_path=public, pg_temp'])
    FROM (VALUES
      ('tokend_get_summary_v5'::TEXT, 'text, text, text'::TEXT),
      ('tokend_get_daily_trend_v5', 'text, text, text'),
      ('tokend_get_model_breakdown_v3', 'text, text'),
      ('tokend_get_model_detail_v2', 'text, text, text'),
      ('tokend_get_channel_breakdown_v4', 'text, text'),
      ('tokend_get_channel_detail_v3', 'text, text, text, text'),
      ('tokend_get_sessions_v2', 'text, text, integer'),
      ('tokend_get_session_detail_v2', 'text, text'),
      ('tokend_get_top_projects_v3', 'text, text')
    ) AS expected(name, argument_types)
    LEFT JOIN pg_proc AS proc
      ON proc.pronamespace = 'public'::regnamespace
     AND proc.proname = expected.name
     AND oidvectortypes(proc.proargtypes) = expected.argument_types
    GROUP BY expected.name
    ORDER BY expected.name
  $actual$,
  $expected$
    SELECT name, 1::INTEGER, TRUE, TRUE, TRUE
    FROM (VALUES
      ('tokend_get_channel_breakdown_v4'::TEXT), ('tokend_get_channel_detail_v3'::TEXT),
      ('tokend_get_daily_trend_v5'::TEXT), ('tokend_get_model_breakdown_v3'::TEXT),
      ('tokend_get_model_detail_v2'::TEXT), ('tokend_get_session_detail_v2'::TEXT),
      ('tokend_get_sessions_v2'::TEXT), ('tokend_get_summary_v5'::TEXT),
      ('tokend_get_top_projects_v3'::TEXT)
    ) AS names(name)
    ORDER BY name
  $expected$,
  'vNext signatures, return types, security, search_path, and ACLs are exact'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM pg_proc AS proc
    CROSS JOIN LATERAL aclexplode(COALESCE(proc.proacl, acldefault('f', proc.proowner))) AS acl
    WHERE proc.pronamespace = 'public'::regnamespace
      AND proc.proname = ANY (ARRAY[
        'tokend_get_summary_v5', 'tokend_get_daily_trend_v5',
        'tokend_get_model_breakdown_v3', 'tokend_get_model_detail_v2',
        'tokend_get_channel_breakdown_v4', 'tokend_get_channel_detail_v3',
        'tokend_get_sessions_v2', 'tokend_get_session_detail_v2', 'tokend_get_top_projects_v3'
      ])
      AND acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'
  ),
  0,
  'PUBLIC cannot execute any vNext RPC'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM pg_proc
    CROSS JOIN (VALUES ('anon'::TEXT), ('authenticated'::TEXT)) AS role_name(name)
    WHERE pronamespace = 'public'::regnamespace
      AND proname = ANY (ARRAY[
        'tokend_get_summary_v5', 'tokend_get_daily_trend_v5',
        'tokend_get_model_breakdown_v3', 'tokend_get_model_detail_v2',
        'tokend_get_channel_breakdown_v4', 'tokend_get_channel_detail_v3',
        'tokend_get_sessions_v2', 'tokend_get_session_detail_v2', 'tokend_get_top_projects_v3'
      ])
      AND has_function_privilege(role_name.name, oid, 'EXECUTE')
  ),
  18,
  'anon and authenticated can execute every vNext RPC'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = ANY (ARRAY[
        'tokend_get_summary_v5', 'tokend_get_daily_trend_v5',
        'tokend_get_model_breakdown_v3', 'tokend_get_model_detail_v2',
        'tokend_get_channel_breakdown_v4', 'tokend_get_channel_detail_v3',
        'tokend_get_sessions_v2', 'tokend_get_session_detail_v2', 'tokend_get_top_projects_v3'
      ])
      AND has_function_privilege('service_role', oid, 'EXECUTE')
  ),
  0,
  'service_role cannot execute any vNext RPC'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM (VALUES ('anon'::TEXT), ('authenticated'::TEXT), ('service_role'::TEXT), ('authenticator'::TEXT)) AS role_name(name)
    WHERE has_table_privilege(role_name.name, 'public.tokend_effective_usage_events', 'SELECT')
  ),
  0,
  'effective view has no direct API-role access'
);

SELECT is(
  (
    WITH payloads AS (
      SELECT public.tokend_get_summary_v5('rpc-token')::JSONB AS payload
      UNION ALL SELECT public.tokend_get_summary_v5('rpc-token')::JSONB->'modelDistribution'->0
      UNION ALL SELECT public.tokend_get_summary_v5('rpc-token')::JSONB->'topConversations'->0
      UNION ALL SELECT public.tokend_get_daily_trend_v5('rpc-token')::JSONB->'days'->0
      UNION ALL SELECT public.tokend_get_model_breakdown_v3('rpc-token')::JSONB->'models'->0
      UNION ALL SELECT public.tokend_get_model_detail_v2('rpc-token', 'gpt-5.6-sol')::JSONB
      UNION ALL SELECT public.tokend_get_channel_breakdown_v4('rpc-token')::JSONB->'channels'->0
      UNION ALL SELECT public.tokend_get_channel_detail_v3('rpc-token', 'coding')::JSONB
      UNION ALL SELECT public.tokend_get_sessions_v2('rpc-token')::JSONB->'sessions'->0
      UNION ALL SELECT public.tokend_get_session_detail_v2('rpc-token', 'rpc-s-estimated')::JSONB
      UNION ALL SELECT public.tokend_get_top_projects_v3('rpc-token')::JSONB->'projects'->0
    ), required(key) AS (VALUES
      ('inputTokens'), ('outputTokens'), ('reasoningTokens'), ('cacheReadTokens'),
      ('cacheWriteTokens'), ('totalTokens'), ('inputCost'), ('outputCost'),
      ('reasoningCost'), ('cacheReadCost'), ('cacheWriteCost'), ('unallocatedCost'),
      ('totalCost'), ('eligibleEventCount'), ('reportedEventCount'),
      ('estimatedEventCount'), ('zeroRateEventCount'), ('legacyEventCount'),
      ('unpricedEventCount'), ('breakdownInvalidCount'), ('costAvailability'),
      ('verifiedCostCoverage'), ('coverageStatus'), ('costDetailsAvailable')
    )
    SELECT count(*)::INTEGER
    FROM payloads CROSS JOIN required
    WHERE NOT payloads.payload ? required.key
       OR payloads.payload->>'costDetailsAvailable' <> 'true'
  ),
  0,
  'every aggregate surface publishes the complete cost envelope'
);

-- Task 8A: one frozen backfill, interrupted batches, deterministic reconciliation,
-- paired activation/rollback, late arrivals, and an orphan gate.
UPDATE public.tokend_pricing_backfill_runs
SET status = CASE
  WHEN run_id = '00000000-0000-0000-0000-000000000002' THEN 'active'
  ELSE 'rolled_back'
END
WHERE status IN ('staging', 'reconciled');

UPDATE public.tokend_pricing_state
SET active_catalog_version = '2026-07-09',
    active_backfill_run_id = '00000000-0000-0000-0000-000000000002',
    previous_catalog_version = '2026-07-08',
    previous_backfill_run_id = '00000000-0000-0000-0000-000000000003'
WHERE singleton;

UPDATE public.tokend_usage_events
SET pricing_status = 'reported'
WHERE total_tokens > 0;

INSERT INTO public.tokend_members (member_code, token) VALUES
  ('BF_MAIN', 'backfill-main-token'),
  ('BF_SECOND', 'backfill-second-token'),
  ('BF_ORPHAN', 'backfill-orphan-token');

INSERT INTO public.tokend_sessions (session_id, member_code) VALUES
  ('bf-session-1', 'BF_MAIN'),
  ('bf-session-2', 'BF_MAIN'),
  ('bf-session-3', 'BF_MAIN'),
  ('bf-session-excluded', 'BF_MAIN'),
  ('bf-second-session', 'BF_SECOND');

INSERT INTO public.tokend_usage_events (
  id, member_code, timestamp_ms, session_id, model,
  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
  total_tokens, input_cost, output_cost, reasoning_cost, cache_read_cost, cache_write_cost,
  total_cost, pricing_status, pricing_tier, token_semantics, unallocated_cost,
  breakdown_status, uploaded_at
) VALUES
  ('bf-1-estimated', 'BF_MAIN', 1782518400000, 'bf-session-1', 'gpt-5.6-sol',
    1000, 100, 20, 50, 10, 1180, 0, 0, 0, 0, 0, 0,
    'unpriced', 'standard', 'disjoint', 0, 'reconciled', clock_timestamp() - interval '1 second'),
  ('bf-2-zero-rate', 'BF_MAIN', 1782518401000, 'bf-session-2', 'codex-auto-review',
    10, 5, 2, 1, 1, 19, 0, 0, 0, 0, 0, 0,
    'unpriced', 'standard', 'disjoint', 0, 'reconciled', clock_timestamp() - interval '1 second'),
  ('bf-3-unpriced', 'BF_MAIN', 1782518402000, 'bf-session-3', 'not-in-catalog',
    20, 10, 3, 2, 1, 36, 0, 0, 0, 0, 0, 0,
    'unpriced', 'standard', 'unknown', 0, 'reconciled', clock_timestamp() - interval '1 second'),
  ('bf-excluded-reported', 'BF_MAIN', 1782518403000, 'bf-session-excluded', 'gpt-5.6-sol',
    1, 1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0,
    'reported', 'standard', 'disjoint', 0, 'reconciled', clock_timestamp() - interval '1 second'),
  ('bf-excluded-legacy', 'BF_MAIN', 1782518404000, 'bf-session-excluded', 'gpt-5.6-sol',
    1, 1, 0, 0, 0, 2, 2, 0, 0, 0, 0, 2,
    NULL, 'standard', 'disjoint', 0, 'reconciled', clock_timestamp() - interval '1 second'),
  ('bf-second-estimated', 'BF_SECOND', 1782518405000, 'bf-second-session', 'gpt-5.6-sol',
    1000, 100, 20, 50, 10, 1180, 0, 0, 0, 0, 0, 0,
    'unpriced', 'standard', 'disjoint', 0, 'reconciled', clock_timestamp() - interval '1 second'),
  ('bf-null-uploaded-at', 'BF_MAIN', 1782518406000, 'bf-session-1', 'gpt-5.6-sol',
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
    'unpriced', 'standard', 'disjoint', 0, 'reconciled', NULL);

CREATE TEMP TABLE task8_null_uploaded_run AS
SELECT public.tokend_pricing_create_backfill(
  '2026-07-10', '81000000-0000-0000-0000-000000000001'
)::JSONB AS payload;

SELECT public.tokend_pricing_freeze_batch(
  (SELECT (payload->>'runId')::UUID FROM task8_null_uploaded_run), 5000
);
SELECT public.tokend_pricing_finalize_backfill(
  (SELECT (payload->>'runId')::UUID FROM task8_null_uploaded_run)
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.tokend_pricing_backfill_targets
    WHERE run_id = (SELECT (payload->>'runId')::UUID FROM task8_null_uploaded_run)
      AND member_code = 'BF_MAIN'
      AND event_id = 'bf-null-uploaded-at'
  ),
  'a historical event with null uploaded_at is frozen rather than silently skipped'
);

UPDATE public.tokend_pricing_backfill_runs
SET status = 'rolled_back'
WHERE run_id = (SELECT (payload->>'runId')::UUID FROM task8_null_uploaded_run);
UPDATE public.tokend_usage_events
SET pricing_status = 'reported'
WHERE member_code = 'BF_MAIN' AND id = 'bf-null-uploaded-at';

CREATE TEMP TABLE task8_run_count_before AS
SELECT count(*)::BIGINT AS value FROM public.tokend_pricing_backfill_runs;

SELECT throws_ok(
  $$ SELECT public.tokend_pricing_create_backfill(
    '2026-07-10', NULL
  ) $$,
  '22023',
  'Pricing backfill create request id is required',
  'create requires a nonnull idempotency request id'
);

SELECT throws_ok(
  $$ SELECT public.tokend_pricing_create_backfill(
    'missing-catalog', '81000000-0000-0000-0000-000000000002'
  ) $$,
  '55000',
  NULL,
  'invalid catalog leaves no partially visible backfill'
);

SELECT is(
  (SELECT count(*)::BIGINT FROM public.tokend_pricing_backfill_runs),
  (SELECT value FROM task8_run_count_before),
  'invalid catalog creation is atomic'
);

SELECT throws_ok(
  $$ SELECT public.tokend_pricing_create_backfill(
    '2026-07-09', '81000000-0000-0000-0000-000000000003'
  ) $$,
  '55000',
  NULL,
  'create rejects a catalog that is already the current active catalog'
);

CREATE TEMP TABLE task8_primary AS
SELECT public.tokend_pricing_create_backfill(
  '2026-07-10', '81000000-0000-0000-0000-000000000004'
)::JSONB AS payload;

SELECT ok(
  public.tokend_pricing_create_backfill(
    '2026-07-10', '81000000-0000-0000-0000-000000000004'
  )::JSONB = (SELECT payload FROM task8_primary)
  AND (
    SELECT count(*) = 1
    FROM public.tokend_pricing_backfill_runs
    WHERE create_request_id = '81000000-0000-0000-0000-000000000004'
  ),
  'same create request returns the same run snapshot without a second row'
);

SELECT throws_ok(
  $$ SELECT public.tokend_pricing_create_backfill(
    '2026-07-09', '81000000-0000-0000-0000-000000000004'
  ) $$,
  '55000',
  'Pricing backfill create request 81000000-0000-0000-0000-000000000004 belongs to catalog 2026-07-10, not 2026-07-09',
  'same create request cannot be reused for another catalog'
);

SELECT public.tokend_pricing_freeze_batch(
  (SELECT (payload->>'runId')::UUID FROM task8_primary), 5000
);
UPDATE task8_primary
SET payload = public.tokend_pricing_finalize_backfill(
  (payload->>'runId')::UUID
)::JSONB;

SELECT ok(
  (SELECT payload->>'status' = 'staging'
      AND (payload->>'targetCount')::BIGINT = 4
      AND length(payload->>'targetHash') = 64
   FROM task8_primary),
  'freeze and finalize publish one deterministic target set without pricing'
);

SELECT results_eq(
  $actual$
    SELECT target.event_id
    FROM public.tokend_pricing_backfill_targets AS target
    WHERE target.run_id = (SELECT (payload->>'runId')::UUID FROM task8_primary)
    ORDER BY target.event_id
  $actual$,
  $expected$
    VALUES
      ('bf-1-estimated'::TEXT), ('bf-2-zero-rate'::TEXT),
      ('bf-3-unpriced'::TEXT), ('bf-second-estimated'::TEXT)
  $expected$,
  'frozen target definition excludes reported and every nonzero legacy base'
);

SELECT ok(
  (
    SELECT count(*) = 4
      AND bool_and(event_snapshot ?& ARRAY[
        'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens',
        'model', 'timestampMs', 'tokenSemantics', 'sessionId', 'beforeTotalCost'
      ])
    FROM public.tokend_pricing_backfill_targets
    WHERE run_id = (SELECT (payload->>'runId')::UUID FROM task8_primary)
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.tokend_event_cost_revisions
    WHERE backfill_run_id = (SELECT (payload->>'runId')::UUID FROM task8_primary)
  ),
  'freeze captures immutable minimal usage metadata and performs no pricing'
);

SELECT throws_ok(
  $$ SELECT public.tokend_pricing_create_backfill(
    '2026-07-10', '81000000-0000-0000-0000-000000000005'
  ) $$,
  '55000',
  NULL,
  'a concurrent staging or reconciled run is rejected'
);

CREATE TEMP TABLE task8_late_upload AS
SELECT public.tokend_upload_events_v2(
  'backfill-main-token',
  jsonb_build_array(
    jsonb_build_object(
      'id', 'bf-late-estimated', 'timestampMs', 1782518500000,
      'sessionId', 'bf-session-1', 'model', 'gpt-5.6-sol',
      'inputTokens', 1000, 'outputTokens', 0, 'reasoningTokens', 0,
      'cacheReadTokens', 0, 'cacheWriteTokens', 0, 'totalTokens', 1000,
      'inputCost', 0, 'outputCost', 0, 'reasoningCost', 0,
      'cacheReadCost', 0, 'cacheWriteCost', 0, 'totalCost', 0,
      'pricingStatus', 'estimated', 'tokenSemantics', 'disjoint'
    ),
    jsonb_build_object(
      'id', 'bf-late-reported', 'timestampMs', 1782518501000,
      'sessionId', 'bf-session-1', 'model', 'gpt-5.6-sol',
      'inputTokens', 1, 'outputTokens', 0, 'reasoningTokens', 0,
      'cacheReadTokens', 0, 'cacheWriteTokens', 0, 'totalTokens', 1,
      'inputCost', 1, 'outputCost', 0, 'reasoningCost', 0,
      'cacheReadCost', 0, 'cacheWriteCost', 0, 'totalCost', 1,
      'pricingStatus', 'reported', 'pricingTier', 'standard',
      'tokenSemantics', 'disjoint', 'breakdownStatus', 'reconciled'
    ),
    jsonb_build_object(
      'id', 'bf-late-legacy', 'timestampMs', 1782518502000,
      'sessionId', 'bf-session-1', 'model', 'gpt-5.6-sol',
      'inputTokens', 1, 'outputTokens', 0, 'reasoningTokens', 0,
      'cacheReadTokens', 0, 'cacheWriteTokens', 0, 'totalTokens', 1,
      'inputCost', 2, 'outputCost', 0, 'reasoningCost', 0,
      'cacheReadCost', 0, 'cacheWriteCost', 0, 'totalCost', 2,
      'tokenSemantics', 'disjoint'
    ),
    jsonb_build_object(
      'id', 'bf-late-null-legacy', 'timestampMs', 1782518503000,
      'sessionId', 'bf-session-1', 'model', 'gpt-5.6-sol',
      'inputTokens', 1, 'outputTokens', 0, 'reasoningTokens', 0,
      'cacheReadTokens', 0, 'cacheWriteTokens', 0, 'totalTokens', 1,
      'inputCost', 3, 'outputCost', 0, 'reasoningCost', 0,
      'cacheReadCost', 0, 'cacheWriteCost', 0, 'totalCost', 3,
      'tokenSemantics', 'disjoint'
    ),
    jsonb_build_object(
      'id', 'bf-late-zero-rate', 'timestampMs', 1782518504000,
      'sessionId', 'bf-session-1', 'model', 'codex-auto-review',
      'inputTokens', 1, 'outputTokens', 0, 'reasoningTokens', 0,
      'cacheReadTokens', 0, 'cacheWriteTokens', 0, 'totalTokens', 1,
      'inputCost', 0, 'outputCost', 0, 'reasoningCost', 0,
      'cacheReadCost', 0, 'cacheWriteCost', 0, 'totalCost', 0,
      'pricingStatus', 'estimated', 'tokenSemantics', 'disjoint'
    )
  ),
  '[]'::JSONB
)::JSONB AS payload;

SELECT is(
  (SELECT (payload->>'inserted')::INTEGER FROM task8_late_upload),
  5,
  'late fixtures use the real v2 upload path after the frozen snapshot'
);

SELECT ok(
  (SELECT count(*) = 5 FROM public.tokend_usage_events
   WHERE member_code = 'BF_MAIN' AND id LIKE 'bf-late-%')
  AND NOT EXISTS (
    SELECT 1 FROM public.tokend_pricing_backfill_targets
    WHERE run_id = (SELECT (payload->>'runId')::UUID FROM task8_primary)
      AND event_id LIKE 'bf-late-%'
  )
  AND (
    SELECT count(*) > 0 AND bool_and(backfill_run_id IS NULL)
    FROM public.tokend_event_cost_revisions
    WHERE member_code = 'BF_MAIN' AND event_id IN ('bf-late-estimated', 'bf-late-zero-rate')
  ),
  'real v2 late revisions stay live audit rows with no backfill run id'
);

CREATE TEMP TABLE task8_batch_one AS
SELECT public.tokend_pricing_backfill_batch(
  (SELECT (payload->>'runId')::UUID FROM task8_primary), '', '', 2
)::JSONB AS payload;

SELECT is(
  (SELECT concat_ws(':', payload->>'processed', payload->>'revisionCount', payload->>'remainingCount') FROM task8_batch_one),
  '2:2:2',
  'first batch persists exactly one deterministic locked window'
);

SELECT is(
  (
    SELECT pricing_status
    FROM public.tokend_event_cost_revisions
    WHERE version = '2026-07-10' AND member_code = 'BF_MAIN' AND event_id = 'bf-2-zero-rate'
  ),
  'zero_rate',
  'zero-rate targets are revisions and do not loop forever'
);

SELECT throws_ok(
  $$
    SELECT public.tokend_pricing_backfill_batch(
      (SELECT (payload->>'runId')::UUID FROM task8_primary), 'zzzz', 'zzzz', 2
    )
  $$,
  '55000',
  NULL,
  'a cursor ahead of persisted progress is rejected'
);

CREATE TEMP TABLE task8_batch_two AS
SELECT public.tokend_pricing_backfill_batch(
  (SELECT (payload->>'runId')::UUID FROM task8_primary), '', '', 2
)::JSONB AS payload;

SELECT is(
  (SELECT concat_ws(':', payload->>'processed', payload->>'revisionCount', payload->>'remainingCount') FROM task8_batch_two),
  '2:4:0',
  'an old caller cursor resumes from persisted progress after interruption'
);

CREATE TEMP TABLE task8_revision_before_retry AS
SELECT member_code, event_id, computed_at, total_cost, pricing_status
FROM public.tokend_event_cost_revisions
WHERE backfill_run_id = (SELECT (payload->>'runId')::UUID FROM task8_primary)
ORDER BY member_code, event_id;

CREATE TEMP TABLE task8_retry AS
SELECT public.tokend_pricing_backfill_batch(
  (SELECT (payload->>'runId')::UUID FROM task8_primary), '', '', 2
)::JSONB AS payload;

SELECT ok(
  (SELECT (payload->>'processed')::INTEGER = 0
      AND (payload->>'remainingCount')::INTEGER = 0
      AND payload->>'nextMember' = 'BF_SECOND'
      AND payload->>'nextEvent' = 'bf-second-estimated'
   FROM task8_retry)
  AND NOT EXISTS (
    (SELECT * FROM task8_revision_before_retry EXCEPT
     SELECT member_code, event_id, computed_at, total_cost, pricing_status
     FROM public.tokend_event_cost_revisions
     WHERE backfill_run_id = (SELECT (payload->>'runId')::UUID FROM task8_primary))
    UNION ALL
    (SELECT member_code, event_id, computed_at, total_cost, pricing_status
     FROM public.tokend_event_cost_revisions
     WHERE backfill_run_id = (SELECT (payload->>'runId')::UUID FROM task8_primary)
     EXCEPT SELECT * FROM task8_revision_before_retry)
  ),
  'batch retries use the persisted cursor and never reprice processed targets'
);

SELECT results_eq(
  $actual$
    SELECT event_id, pricing_status
    FROM public.tokend_event_cost_revisions
    WHERE backfill_run_id = (SELECT (payload->>'runId')::UUID FROM task8_primary)
    ORDER BY event_id
  $actual$,
  $expected$
    VALUES
      ('bf-1-estimated'::TEXT, 'estimated'::TEXT),
      ('bf-2-zero-rate'::TEXT, 'zero_rate'::TEXT),
      ('bf-3-unpriced'::TEXT, 'unpriced'::TEXT),
      ('bf-second-estimated'::TEXT, 'estimated'::TEXT)
  $expected$,
  'batch prices each frozen snapshot once under the run catalog'
);

CREATE TEMP TABLE task8_reconcile_one AS
SELECT public.tokend_pricing_reconcile(
  (SELECT (payload->>'runId')::UUID FROM task8_primary)
)::JSONB AS payload;

SELECT ok(
  (
    SELECT payload->>'reconciliationHash' IS NOT NULL
      AND length(payload->>'reconciliationHash') = 64
      AND (payload->>'targetCount')::BIGINT = 4
      AND (payload->>'revisionCount')::BIGINT = 4
      AND (payload->>'missingRevisionCount')::BIGINT = 0
      AND (payload->>'duplicateRevisionCount')::BIGINT = 0
      AND (payload->>'breakdownInvalidCount')::BIGINT = 0
      AND (payload->>'postSnapshotEventCount')::BIGINT = 5
      AND (payload->>'unexplainedMemberCount')::BIGINT = 0
    FROM task8_reconcile_one
  ) AND (
    SELECT status = 'reconciled'
    FROM public.tokend_pricing_backfill_runs
    WHERE run_id = (SELECT (payload->>'runId')::UUID FROM task8_primary)
  ),
  'reconcile reports late arrivals but gates only frozen static data'
);

CREATE TEMP TABLE task8_reconcile_two AS
SELECT public.tokend_pricing_reconcile(
  (SELECT (payload->>'runId')::UUID FROM task8_primary)
)::JSONB AS payload;

SELECT is(
  (SELECT payload->>'reconciliationHash' FROM task8_reconcile_two),
  (SELECT payload->>'reconciliationHash' FROM task8_reconcile_one),
  'reconcile is idempotent and produces the same static hash'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM public.tokend_pricing_shadow_sessions
    WHERE run_id = (SELECT (payload->>'runId')::UUID FROM task8_primary)
  ),
  4,
  'shadow reconciliation preserves the session foreign key and existing sessions'
);

UPDATE public.tokend_pricing_shadow_sessions
SET total_cost = total_cost + CASE
  WHEN member_code = 'BF_MAIN' AND session_id = 'bf-session-1' THEN 0.0001000000
  WHEN member_code = 'BF_SECOND' AND session_id = 'bf-second-session' THEN -0.0001000000
  ELSE 0
END
WHERE run_id = (SELECT (payload->>'runId')::UUID FROM task8_primary)
  AND (
    (member_code = 'BF_MAIN' AND session_id = 'bf-session-1')
    OR (member_code = 'BF_SECOND' AND session_id = 'bf-second-session')
  );

SELECT ok(
  (
    SELECT COALESCE(sum(total_cost), 0)
    FROM public.tokend_pricing_shadow_sessions
    WHERE run_id = (SELECT (payload->>'runId')::UUID FROM task8_primary)
  ) = (
    SELECT COALESCE(sum(total_cost), 0)
    FROM public.tokend_event_cost_revisions
    WHERE version = '2026-07-10'
      AND backfill_run_id = (SELECT (payload->>'runId')::UUID FROM task8_primary)
  ),
  'cross-member cost shifts preserve global totals but fail member reconciliation'
);

SELECT throws_ok(
  $$ SELECT public.tokend_pricing_activate((SELECT (payload->>'runId')::UUID FROM task8_primary)) $$,
  '55000',
  NULL,
  'activation rejects per-member cost mismatches even when the global total is unchanged'
);

CREATE TEMP TABLE task8_reconcile_repair AS
SELECT public.tokend_pricing_reconcile(
  (SELECT (payload->>'runId')::UUID FROM task8_primary)
)::JSONB AS payload;

SELECT is(
  (SELECT effective_total_cost FROM public.tokend_effective_usage_events
   WHERE member_code = 'BF_MAIN' AND id = 'bf-1-estimated'),
  0::NUMERIC,
  'batch revisions remain hidden until their distinct catalog is activated'
);

SELECT lives_ok(
  $$ SELECT public.tokend_pricing_activate((SELECT (payload->>'runId')::UUID FROM task8_primary)) $$,
  'a reconciled run activates against its frozen base pair'
);

SELECT ok(
  (
    SELECT active_catalog_version = '2026-07-10'
      AND active_backfill_run_id = (SELECT (payload->>'runId')::UUID FROM task8_primary)
      AND previous_catalog_version = '2026-07-09'
      AND previous_backfill_run_id = '00000000-0000-0000-0000-000000000002'
      AND (SELECT status = 'active'
           FROM public.tokend_pricing_backfill_runs
           WHERE run_id = (SELECT (payload->>'runId')::UUID FROM task8_primary))
    FROM public.tokend_pricing_state WHERE singleton
  ),
  'activation moves the old current pair to previous atomically'
);

SELECT results_eq(
  $actual$
    SELECT id, effective_total_cost
    FROM public.tokend_effective_usage_events
    WHERE member_code = 'BF_MAIN' AND id IN ('bf-1-estimated', 'bf-late-estimated')
    ORDER BY id
  $actual$,
  $expected$
    VALUES
      ('bf-1-estimated'::TEXT, 0.0086875000::NUMERIC),
      ('bf-late-estimated'::TEXT, 0.0050000000::NUMERIC)
  $expected$,
  'activation selects new-catalog frozen and live revisions'
);

SELECT is(
  (public.tokend_pricing_activate(
    (SELECT (payload->>'runId')::UUID FROM task8_primary)
  )::JSONB->>'status'),
  'active',
  'already-active requests are idempotent only with the frozen previous pair'
);

CREATE TEMP TABLE task8_deleted_active_revision AS
SELECT *
FROM public.tokend_event_cost_revisions
WHERE backfill_run_id = (SELECT (payload->>'runId')::UUID FROM task8_primary)
ORDER BY member_code, event_id
LIMIT 1;

DELETE FROM public.tokend_event_cost_revisions
WHERE (version, member_code, event_id) = (
  SELECT version, member_code, event_id
  FROM task8_deleted_active_revision
);

SELECT throws_ok(
  $$ SELECT public.tokend_pricing_activate((SELECT (payload->>'runId')::UUID FROM task8_primary)) $$,
  '55000',
  NULL,
  'already-active retries recheck the complete frozen reconciliation integrity'
);

INSERT INTO public.tokend_event_cost_revisions
SELECT * FROM task8_deleted_active_revision;

UPDATE public.tokend_pricing_state
SET previous_catalog_version = '2026-07-08',
    previous_backfill_run_id = '00000000-0000-0000-0000-000000000003'
WHERE singleton;

SELECT throws_ok(
  $$ SELECT public.tokend_pricing_activate((SELECT (payload->>'runId')::UUID FROM task8_primary)) $$,
  '55000',
  NULL,
  'already-active idempotency rejects a state whose previous pair drifted from the frozen base'
);

UPDATE public.tokend_pricing_state
SET previous_catalog_version = '2026-07-09',
    previous_backfill_run_id = '00000000-0000-0000-0000-000000000002'
WHERE singleton;

SELECT lives_ok(
  $$ SELECT public.tokend_pricing_rollback((SELECT (payload->>'runId')::UUID FROM task8_primary)) $$,
  'rollback restores only the exact frozen base pair'
);

SELECT ok(
  (
    SELECT active_catalog_version = '2026-07-09'
      AND active_backfill_run_id = '00000000-0000-0000-0000-000000000002'
      AND previous_catalog_version = '2026-07-10'
      AND previous_backfill_run_id = (SELECT (payload->>'runId')::UUID FROM task8_primary)
    FROM public.tokend_pricing_state WHERE singleton
  ),
  'rollback swaps the run pair to previous without changing catalog selection rules'
);

SELECT results_eq(
  $actual$
    SELECT id, effective_total_cost
    FROM public.tokend_effective_usage_events
    WHERE member_code = 'BF_MAIN' AND id IN ('bf-1-estimated', 'bf-late-estimated')
    ORDER BY id
  $actual$,
  $expected$
    VALUES
      ('bf-1-estimated'::TEXT, 0::NUMERIC),
      ('bf-late-estimated'::TEXT, 0.0025000000::NUMERIC)
  $expected$,
  'rollback removes new-catalog effects from frozen and live totals'
);

SELECT is(
  (public.tokend_pricing_rollback(
    (SELECT (payload->>'runId')::UUID FROM task8_primary)
  )::JSONB->>'status'),
  'rolled_back',
  'already-rolled-back requests are idempotent only for the exact paired state'
);

SELECT lives_ok(
  $$ SELECT public.tokend_pricing_activate((SELECT (payload->>'runId')::UUID FROM task8_primary)) $$,
  'activate rollback and reactivate preserve the frozen catalog run pair'
);

INSERT INTO public.tokend_pricing_backfill_runs (
  run_id, catalog_version, status, snapshot_at, target_count,
  target_hash, base_catalog_version, base_backfill_run_id, reconciliation_hash
) VALUES (
  '80000000-0000-0000-0000-000000000099', '2026-07-10', 'active', clock_timestamp(), 0,
  repeat('0', 64), '2026-07-09', '00000000-0000-0000-0000-000000000002', repeat('1', 64)
);

SELECT throws_ok(
  $$ SELECT public.tokend_pricing_activate('80000000-0000-0000-0000-000000000099') $$,
  '55000',
  NULL,
  'a competing active run cannot claim the current run idempotency path'
);

SELECT throws_ok(
  $$ SELECT public.tokend_pricing_rollback('80000000-0000-0000-0000-000000000099') $$,
  '55000',
  NULL,
  'a truly stale active rollback cannot replace the current pair'
);

SELECT ok(
  (
    SELECT (public.tokend_pricing_get_backfill(
      (SELECT (payload->>'runId')::UUID FROM task8_primary)
    )::JSONB->>'postSnapshotEventCount')::BIGINT = 5
  ) AND (
    SELECT reconciliation_hash = (SELECT payload->>'reconciliationHash' FROM task8_reconcile_one)
    FROM public.tokend_pricing_backfill_runs
    WHERE run_id = (SELECT (payload->>'runId')::UUID FROM task8_primary)
  ),
  'five real late arrivals stay outside the frozen reconciliation hash'
);

SELECT is(
  (public.tokend_pricing_preflight()::JSONB->>'postSnapshotEventCount')::BIGINT,
  5::BIGINT,
  'preflight and get use the same ingest-epoch late-arrival definition'
);

SELECT ok(
  (
    WITH preflight AS (
      SELECT public.tokend_pricing_preflight()::JSONB AS value
    ), reference AS (
      SELECT
        count(*)::BIGINT AS event_count,
        count(*) FILTER (WHERE total_tokens > 0)::BIGINT AS eligible_event_count,
        count(*) FILTER (
          WHERE total_tokens > 0 AND COALESCE(effective_total_cost, 0) = 0
        )::BIGINT AS eligible_zero_cost_event_count,
        count(*) FILTER (
          WHERE total_tokens > 0 AND effective_pricing_status = 'unpriced'
        )::BIGINT AS unpriced_event_count,
        COALESCE(sum(effective_total_cost), 0)::NUMERIC(20,10) AS total_cost,
        jsonb_build_object(
          'reported', count(*) FILTER (
            WHERE total_tokens > 0 AND effective_pricing_status = 'reported'
          ),
          'estimated', count(*) FILTER (
            WHERE total_tokens > 0 AND effective_pricing_status = 'estimated'
          ),
          'zero_rate', count(*) FILTER (
            WHERE total_tokens > 0 AND effective_pricing_status = 'zero_rate'
          ),
          'unpriced', count(*) FILTER (
            WHERE total_tokens > 0 AND effective_pricing_status = 'unpriced'
          ),
          'legacy', count(*) FILTER (
            WHERE total_tokens > 0 AND effective_pricing_status = 'legacy'
          ),
          'unset', count(*) FILTER (
            WHERE total_tokens > 0 AND effective_pricing_status IS NULL
          )
        ) AS status_counts
      FROM public.tokend_effective_usage_events
    )
    SELECT
      (preflight.value->>'eventCount')::BIGINT = reference.event_count
      AND (preflight.value->>'eligibleEventCount')::BIGINT = reference.eligible_event_count
      AND (preflight.value->>'eligibleZeroCostEventCount')::BIGINT
        = reference.eligible_zero_cost_event_count
      AND (preflight.value->>'unpricedEventCount')::BIGINT = reference.unpriced_event_count
      AND (preflight.value->>'totalCost')::NUMERIC = reference.total_cost
      AND preflight.value->'statusCounts' = reference.status_counts
    FROM preflight CROSS JOIN reference
  ),
  'optimized preflight global aggregates exactly match the effective relation'
);

SELECT ok(
  (
    WITH preflight AS (
      SELECT public.tokend_pricing_preflight()::JSONB AS value
    ), model_rollup AS MATERIALIZED (
      SELECT
        COALESCE(model, 'unknown') AS model,
        count(*)::BIGINT AS event_count,
        COALESCE(sum(total_tokens), 0)::BIGINT AS total_tokens
      FROM public.tokend_effective_usage_events
      WHERE total_tokens > 0
        AND COALESCE(effective_total_cost, 0) = 0
      GROUP BY COALESCE(model, 'unknown')
    ), bounded_models AS MATERIALIZED (
      SELECT model, event_count, total_tokens
      FROM model_rollup
      ORDER BY event_count DESC, model
      LIMIT 100
    ), reference AS (
      SELECT
        (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'model', bounded_models.model,
          'eventCount', bounded_models.event_count,
          'totalTokens', bounded_models.total_tokens
        ) ORDER BY bounded_models.event_count DESC, bounded_models.model), '[]'::JSONB)
         FROM bounded_models) AS models,
        (SELECT count(*)::BIGINT > 100 FROM model_rollup) AS truncated,
        (SELECT COALESCE(sum(event_count), 0)::BIGINT FROM model_rollup)
          - (SELECT COALESCE(sum(event_count), 0)::BIGINT FROM bounded_models) AS other_count
    )
    SELECT
      preflight.value->'zeroCostByModel' = reference.models
      AND (preflight.value->>'zeroCostByModelTruncated')::BOOLEAN = reference.truncated
      AND (preflight.value->>'zeroCostOtherEventCount')::BIGINT = reference.other_count
    FROM preflight CROSS JOIN reference
  ),
  'optimized preflight zero-cost model rollup exactly matches the effective relation'
);

SELECT is(
  (
    SELECT effective_total_cost
    FROM public.tokend_effective_usage_events
    WHERE member_code = 'BF_MAIN' AND id = 'bf-late-estimated'
  ),
  0.0050000000::NUMERIC,
  'reactivation selects the late live revision without filtering by backfill run id'
);

SELECT results_eq(
  $actual$
    SELECT jsonb_object_keys(public.tokend_pricing_get_backfill(
      (SELECT (payload->>'runId')::UUID FROM task8_primary)
    )::JSONB) ORDER BY 1
  $actual$,
  $expected$
    SELECT key FROM (VALUES
      ('activeCatalogVersion'::TEXT), ('activeRunId'), ('baseCatalogVersion'), ('baseRunId'),
      ('catalogVersion'), ('cursorEvent'), ('cursorMember'), ('freezeComplete'),
      ('frozenCount'), ('postSnapshotEventCount'), ('previousCatalogVersion'),
      ('previousRunId'), ('remainingCount'), ('revisionCount'), ('runId'),
      ('scannedCount'), ('skippedCount'), ('snapshotAt'), ('status'), ('targetCount'),
      ('targetHash'), ('targetIngestEpoch')
    ) AS keys(key) ORDER BY key
  $expected$,
  'get backfill exposes only the exact aggregate status keys'
);

UPDATE public.tokend_pricing_backfill_runs
SET status = 'rolled_back'
WHERE run_id = '80000000-0000-0000-0000-000000000099';
UPDATE public.tokend_usage_events SET pricing_status = 'reported' WHERE total_tokens > 0;

INSERT INTO public.tokend_usage_events (
  id, member_code, timestamp_ms, session_id, model,
  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
  total_tokens, input_cost, output_cost, reasoning_cost, cache_read_cost, cache_write_cost,
  total_cost, pricing_status, pricing_tier, token_semantics, unallocated_cost,
  breakdown_status, uploaded_at
) VALUES (
  'bf-orphan', 'BF_ORPHAN', 1782518600000, 'missing-session', 'gpt-5.6-sol',
  10, 1, 1, 1, 1, 14, 0, 0, 0, 0, 0, 0,
  'unpriced', 'standard', 'disjoint', 0, 'reconciled', clock_timestamp() - interval '1 second'
);

CREATE TEMP TABLE task8_orphan AS
SELECT public.tokend_pricing_create_backfill(
  '2026-07-09', '81000000-0000-0000-0000-000000000006'
)::JSONB AS payload;

SELECT public.tokend_pricing_freeze_batch(
  (SELECT (payload->>'runId')::UUID FROM task8_orphan), 5000
);
UPDATE task8_orphan
SET payload = public.tokend_pricing_finalize_backfill(
  (payload->>'runId')::UUID
)::JSONB;

SELECT is(
  (SELECT (payload->>'targetCount')::BIGINT FROM task8_orphan),
  1::BIGINT,
  'a second finalized freeze contains only the controlled orphan target'
);

SELECT lives_ok(
  $$ SELECT public.tokend_pricing_backfill_batch(
    (SELECT (payload->>'runId')::UUID FROM task8_orphan), '', '', 10000
  ) $$,
  'the orphan target can be priced without inventing a session'
);

INSERT INTO public.tokend_event_cost_revisions (
  version, member_code, event_id, backfill_run_id,
  input_cost, output_cost, reasoning_cost, cache_read_cost, cache_write_cost,
  unallocated_cost, total_cost, pricing_status, pricing_tier, matched_model_id,
  price_version, breakdown_status
) VALUES (
  '2026-07-09', 'BF_MAIN', 'bf-excluded-reported',
  (SELECT (payload->>'runId')::UUID FROM task8_orphan),
  0.0001000000, 0, 0, 0, 0, 0, 0.0001000000,
  'estimated', 'standard', 'gpt-5.6-sol', NULL, 'reconciled'
);

CREATE TEMP TABLE task8_orphan_reconcile AS
SELECT public.tokend_pricing_reconcile(
  (SELECT (payload->>'runId')::UUID FROM task8_orphan)
)::JSONB AS payload;

SELECT ok(
  (SELECT (payload->>'revisionCount')::BIGINT = 2
      AND (payload->>'unexplainedMemberCount')::BIGINT = 2
   FROM task8_orphan_reconcile)
  AND (SELECT status = 'staging'
       FROM public.tokend_pricing_backfill_runs
       WHERE run_id = (SELECT (payload->>'runId')::UUID FROM task8_orphan))
  AND NOT EXISTS (
    SELECT 1 FROM public.tokend_pricing_shadow_sessions
    WHERE run_id = (SELECT (payload->>'runId')::UUID FROM task8_orphan)
  ),
  'orphan sessions and revision-only members both block reconciliation'
);

SELECT throws_ok(
  $$ SELECT public.tokend_pricing_activate((SELECT (payload->>'runId')::UUID FROM task8_orphan)) $$,
  '55000',
  NULL,
  'a run with nonzero reconciliation gates cannot activate'
);

SELECT results_eq(
  $actual$
    SELECT column_name::TEXT COLLATE "C", data_type::TEXT COLLATE "C"
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tokend_pricing_backfill_runs'
      AND column_name IN (
        'create_request_id', 'target_hash', 'base_catalog_version', 'base_backfill_run_id',
        'reconciled_at', 'activated_at', 'rolled_back_at'
      )
    ORDER BY column_name
  $actual$,
  $expected$
    VALUES
      ('activated_at'::TEXT COLLATE "C", 'timestamp with time zone'::TEXT COLLATE "C"),
      ('base_backfill_run_id'::TEXT COLLATE "C", 'uuid'::TEXT COLLATE "C"),
      ('base_catalog_version'::TEXT COLLATE "C", 'text'::TEXT COLLATE "C"),
      ('create_request_id'::TEXT COLLATE "C", 'uuid'::TEXT COLLATE "C"),
      ('reconciled_at'::TEXT COLLATE "C", 'timestamp with time zone'::TEXT COLLATE "C"),
      ('rolled_back_at'::TEXT COLLATE "C", 'timestamp with time zone'::TEXT COLLATE "C"),
      ('target_hash'::TEXT COLLATE "C", 'text'::TEXT COLLATE "C")
  $expected$,
  'backfill run schema has the exact seven rollout columns'
);

SELECT results_eq(
  $actual$
    SELECT proc.proname::TEXT COLLATE "C", oidvectortypes(proc.proargtypes)::TEXT COLLATE "C",
      array_to_string(proc.proargnames, ',')::TEXT COLLATE "C",
      (proc.prorettype = 'json'::regtype)::BOOLEAN,
      proc.prosecdef::BOOLEAN,
      (proc.proconfig @> ARRAY['search_path=public, pg_temp'])::BOOLEAN,
      has_function_privilege('service_role', proc.oid, 'EXECUTE')::BOOLEAN
    FROM pg_proc AS proc
    WHERE proc.pronamespace = 'public'::regnamespace
      AND proc.proname = ANY (ARRAY[
        'tokend_pricing_create_backfill', 'tokend_pricing_freeze_batch',
        'tokend_pricing_finalize_backfill', 'tokend_pricing_backfill_batch',
        'tokend_pricing_reconcile', 'tokend_pricing_activate',
        'tokend_pricing_rollback', 'tokend_pricing_get_backfill',
        'tokend_pricing_health'
      ])
    ORDER BY proc.proname
  $actual$,
  $expected$
    VALUES
      ('tokend_pricing_activate'::TEXT COLLATE "C", 'uuid'::TEXT COLLATE "C", 'p_run_id'::TEXT COLLATE "C", TRUE, TRUE, TRUE, TRUE),
      ('tokend_pricing_backfill_batch'::TEXT COLLATE "C", 'uuid, text, text, integer'::TEXT COLLATE "C",
        'p_run_id,p_after_member,p_after_event,p_limit'::TEXT COLLATE "C", TRUE, TRUE, TRUE, TRUE),
      ('tokend_pricing_create_backfill'::TEXT COLLATE "C", 'text, uuid'::TEXT COLLATE "C", 'p_catalog_version,p_create_request_id'::TEXT COLLATE "C", TRUE, TRUE, TRUE, TRUE),
      ('tokend_pricing_finalize_backfill'::TEXT COLLATE "C", 'uuid'::TEXT COLLATE "C", 'p_run_id'::TEXT COLLATE "C", TRUE, TRUE, TRUE, TRUE),
      ('tokend_pricing_freeze_batch'::TEXT COLLATE "C", 'uuid, integer'::TEXT COLLATE "C", 'p_run_id,p_limit'::TEXT COLLATE "C", TRUE, TRUE, TRUE, TRUE),
      ('tokend_pricing_get_backfill'::TEXT COLLATE "C", 'uuid'::TEXT COLLATE "C", 'p_run_id'::TEXT COLLATE "C", TRUE, TRUE, TRUE, TRUE),
      ('tokend_pricing_health'::TEXT COLLATE "C", ''::TEXT COLLATE "C", NULL::TEXT COLLATE "C", TRUE, TRUE, TRUE, TRUE),
      ('tokend_pricing_reconcile'::TEXT COLLATE "C", 'uuid'::TEXT COLLATE "C", 'p_run_id'::TEXT COLLATE "C", TRUE, TRUE, TRUE, TRUE),
      ('tokend_pricing_rollback'::TEXT COLLATE "C", 'uuid'::TEXT COLLATE "C", 'p_run_id'::TEXT COLLATE "C", TRUE, TRUE, TRUE, TRUE)
  $expected$,
  'admin signatures return JSON with exact security and service-only execution'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM pg_proc AS proc
    WHERE proc.pronamespace = 'public'::regnamespace
      AND proc.proname = ANY (ARRAY[
        'tokend_pricing_create_backfill', 'tokend_pricing_freeze_batch',
        'tokend_pricing_finalize_backfill', 'tokend_pricing_backfill_batch',
        'tokend_pricing_reconcile', 'tokend_pricing_activate',
        'tokend_pricing_rollback', 'tokend_pricing_get_backfill',
        'tokend_pricing_health'
      ])
      AND (
        has_function_privilege('anon', proc.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', proc.oid, 'EXECUTE')
        OR EXISTS (
          SELECT 1
          FROM aclexplode(COALESCE(proc.proacl, acldefault('f', proc.proowner))) AS acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
        )
      )
  ),
  0,
  'PUBLIC anon and authenticated cannot execute admin backfill functions'
);

COMMIT;

INSERT INTO public.tokend_members (member_code, token)
VALUES ('RB_KEEP', 'rollback-token');

INSERT INTO public.tokend_sessions (session_id, member_code)
VALUES ('rollback-session', 'RB_KEEP');

INSERT INTO public.tokend_usage_events (
  id, member_code, timestamp_ms, session_id, model,
  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
  total_tokens, input_cost, output_cost, reasoning_cost, cache_read_cost, cache_write_cost,
  total_cost, pricing_status, pricing_tier, token_semantics, unallocated_cost, breakdown_status
) VALUES (
  'rollback-retained', 'RB_KEEP', 1782518699000, 'rollback-session', 'gpt-5.6-sol',
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
  'unpriced', 'standard', 'disjoint', 0, 'reconciled'
);

INSERT INTO public.tokend_pricing_backfill_runs (
  run_id, catalog_version, status, snapshot_at, target_count, target_hash
) VALUES (
  '90000000-0000-0000-0000-000000000001', '2026-07-10', 'staging',
  clock_timestamp(), 1, repeat('a', 64)
);

INSERT INTO public.tokend_pricing_backfill_targets (
  run_id, member_code, event_id, event_snapshot, snapshot_hash
) VALUES (
  '90000000-0000-0000-0000-000000000001', 'RB_KEEP', 'rollback-retained',
  '{"sessionId":"rollback-session","inputTokens":1,"outputTokens":0,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0}'::JSONB,
  repeat('b', 64)
);

INSERT INTO public.tokend_event_cost_revisions (
  version, member_code, event_id, backfill_run_id,
  input_cost, output_cost, reasoning_cost, cache_read_cost, cache_write_cost,
  unallocated_cost, total_cost, pricing_status, pricing_tier, matched_model_id,
  price_version, breakdown_status
) VALUES (
  '2026-07-10', 'RB_KEEP', 'rollback-retained',
  '90000000-0000-0000-0000-000000000001',
  0.0000050000, 0, 0, 0, 0, 0, 0.0000050000,
  'estimated', 'standard', 'gpt-5.6-sol', NULL, 'reconciled'
);

CREATE TEMP TABLE task8_retained_counts AS
SELECT
  (SELECT count(*)::BIGINT FROM public.tokend_pricing_catalogs) AS catalogs,
  (SELECT count(*)::BIGINT FROM public.tokend_pricing_backfill_runs) AS runs,
  (SELECT count(*)::BIGINT FROM public.tokend_pricing_backfill_targets) AS targets,
  (SELECT count(*)::BIGINT FROM public.tokend_event_cost_revisions) AS revisions;

CREATE TEMP TABLE task8_table_grants AS
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND (table_name LIKE 'tokend_pricing_%' OR table_name = 'tokend_event_cost_revisions');

\ir ../../rollback/20260710_restore_prepricing.sql
\ir ../../rollback/20260710_restore_prepricing.sql

BEGIN;
SET LOCAL search_path = public, extensions;

CREATE TEMP TABLE task8_legacy_upload AS
SELECT public.tokend_upload_events(
  'rollback-token',
  '[{"id":"rollback-event","timestampMs":1782518700000,"sessionId":"rollback-session","model":"gpt-5.6-sol","inputTokens":1,"outputTokens":0,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"totalTokens":1,"inputCost":0,"outputCost":0,"reasoningCost":0,"cacheReadCost":0,"cacheWriteCost":0,"totalCost":0,"project":"rollback"}]'::JSONB,
  '[]'::JSONB
)::JSONB AS payload;

SELECT ok(
  (SELECT payload ?& ARRAY['ok', 'inserted'] AND payload->>'ok' = 'true' FROM task8_legacy_upload)
    AND EXISTS (SELECT 1 FROM public.tokend_usage_events WHERE member_code = 'RB_KEEP' AND id = 'rollback-event'),
  'rollback restores the exact legacy upload envelope and behavior'
);

SELECT ok(
  (
    SELECT proc.prosecdef
      AND proc.proconfig = ARRAY['search_path=public, pg_temp']::TEXT[]
    FROM pg_proc AS proc
    WHERE proc.oid = 'public.tokend_upload_events(text,jsonb,jsonb)'::regprocedure
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_proc AS proc
    CROSS JOIN LATERAL aclexplode(
      COALESCE(proc.proacl, acldefault('f', proc.proowner))
    ) AS privilege
    WHERE proc.oid = 'public.tokend_upload_events(text,jsonb,jsonb)'::regprocedure
      AND privilege.privilege_type = 'EXECUTE'
      AND (
        privilege.grantee = 0
        OR privilege.grantee = 'service_role'::regrole
        OR (
          privilege.grantee IN ('anon'::regrole, 'authenticated'::regrole)
          AND privilege.is_grantable
        )
      )
  )
  AND has_function_privilege(
    'anon', 'public.tokend_upload_events(text,jsonb,jsonb)', 'EXECUTE'
  )
  AND has_function_privilege(
    'authenticated', 'public.tokend_upload_events(text,jsonb,jsonb)', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'service_role', 'public.tokend_upload_events(text,jsonb,jsonb)', 'EXECUTE'
  ),
  'restored legacy wrapper fixes search_path and grants only anon authenticated without grant option'
);

SELECT results_eq(
  $actual$
    SELECT old.proname, old.argument_types, old.oid
    FROM legacy_function_oids AS old
    ORDER BY old.proname, old.argument_types
  $actual$,
  $expected$
    SELECT current.proname, oidvectortypes(current.proargtypes), current.oid
    FROM pg_proc AS current
    WHERE current.pronamespace = 'public'::regnamespace
      AND current.proname = ANY (ARRAY[
        'tokend_get_summary_v4', 'tokend_get_daily_trend_v4',
        'tokend_get_model_breakdown_v2', 'tokend_get_model_detail',
        'tokend_get_channel_breakdown_v3', 'tokend_get_channel_detail_v2',
        'tokend_get_sessions', 'tokend_get_session_detail', 'tokend_get_top_projects_v2'
      ])
    ORDER BY current.proname, oidvectortypes(current.proargtypes)
  $expected$,
  'rollback preserves every legacy RPC OID'
);

SELECT is(
  (
    SELECT count(*)::INTEGER FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = ANY (ARRAY[
        'tokend_get_summary_v5', 'tokend_get_daily_trend_v5',
        'tokend_get_model_breakdown_v3', 'tokend_get_model_detail_v2',
        'tokend_get_channel_breakdown_v4', 'tokend_get_channel_detail_v3',
        'tokend_get_sessions_v2', 'tokend_get_session_detail_v2', 'tokend_get_top_projects_v3',
        'tokend_pricing_create_backfill', 'tokend_pricing_backfill_batch',
        'tokend_pricing_reconcile', 'tokend_pricing_activate',
        'tokend_pricing_rollback', 'tokend_pricing_get_backfill',
        'tokend_upload_events_v2', 'tokend_pricing_preflight', 'tokend_price_event'
      ])
  ),
  0,
  'rollback removes only vNext and admin functions while retaining pricing data'
);

SELECT is(
  to_regclass('public.tokend_effective_usage_events'),
  NULL,
  'rollback removes the effective vNext view'
);

SELECT ok(
  (SELECT count(*) = 10 FROM pg_class WHERE oid = ANY (ARRAY[
    'public.tokend_pricing_catalogs'::regclass,
    'public.tokend_pricing_canonical_models'::regclass,
    'public.tokend_pricing_models'::regclass,
    'public.tokend_pricing_aliases'::regclass,
    'public.tokend_event_cost_revisions'::regclass,
    'public.tokend_pricing_state'::regclass,
    'public.tokend_pricing_backfill_runs'::regclass,
    'public.tokend_pricing_backfill_targets'::regclass,
    'public.tokend_pricing_shadow_sessions'::regclass,
    'public.tokend_pricing_audit'::regclass
  ]))
  AND (SELECT count(*) FROM public.tokend_pricing_catalogs) = (SELECT catalogs FROM task8_retained_counts)
  AND (SELECT count(*) FROM public.tokend_pricing_backfill_runs) = (SELECT runs FROM task8_retained_counts)
  AND (SELECT count(*) FROM public.tokend_pricing_backfill_targets) = (SELECT targets FROM task8_retained_counts)
  AND (SELECT count(*) FROM public.tokend_event_cost_revisions) = (SELECT revisions FROM task8_retained_counts),
  'rollback retains pricing tables catalogs snapshots revisions and data'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tokend_usage_events'
      AND column_name = 'pricing_status'
  )
  AND EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.tokend_install_pricing_catalog(text,text,date)'::regprocedure
  ),
  'rollback retains pricing columns catalog installer and guards'
);

SELECT results_eq(
  $actual$
    SELECT grantee, table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND (table_name LIKE 'tokend_pricing_%' OR table_name = 'tokend_event_cost_revisions')
    ORDER BY grantee, table_name, privilege_type
  $actual$,
  $expected$
    SELECT grantee, table_name, privilege_type
    FROM task8_table_grants
    ORDER BY grantee, table_name, privilege_type
  $expected$,
  'rollback adds no new direct pricing table grants'
);

SELECT * FROM finish();
ROLLBACK;
