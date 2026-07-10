BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path = public, extensions;

-- Fixture-only production-compatible objects. The surrounding transaction is rolled back.
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

\ir ../../migrations/202607100001_pricing_core.sql
\ir ../../migrations/202607100001_pricing_core.sql
\ir ../../migrations/202607100002_pricing_upload.sql
\ir ../../migrations/202607100002_pricing_upload.sql

SELECT plan(102);

SELECT pass('pricing migration compiles and applies twice');

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

-- Pricing-aware upload RPC contract (tests 35-67).
SELECT pass('pricing upload migration compiles and applies twice');

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
      standard_input_rate, standard_output_rate,
      standard_cache_read_rate, standard_cache_write_rate,
      long_context_input_rate, long_context_output_rate,
      long_context_cache_read_rate, long_context_cache_write_rate,
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

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM public.tokend_event_cost_revisions
    WHERE member_code = 'ROLL_UPLOAD' AND event_id = 'estimate-1'
      AND pricing_status = 'estimated'
      AND total_cost = 1.3375::NUMERIC
  ),
  3,
  'all revision costs come from the server catalog'
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
    previous_catalog_version = NULL
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
  run_id, member_code, event_id, event_snapshot
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  'ROLL_UPLOAD',
  'estimate-1',
  '{}'::JSONB
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

SELECT results_eq(
  $actual$
    SELECT key
    FROM json_object_keys(public.tokend_pricing_preflight()) AS key
    ORDER BY key
  $actual$,
  $expected$
    VALUES
      ('activeCatalogVersion'::TEXT), ('activeReconciliationHash'::TEXT),
      ('activeRunId'::TEXT), ('activeRunStatus'::TEXT),
      ('eligibleEventCount'::TEXT), ('eligibleZeroCostEventCount'::TEXT),
      ('eventCount'::TEXT), ('legacyPriceRowCount'::TEXT),
      ('membersOver2xCount'::TEXT), ('postSnapshotEventCount'::TEXT),
      ('previousCatalogVersion'::TEXT), ('previousRunId'::TEXT),
      ('rolloutFixtureCount'::TEXT), ('statusCounts'::TEXT),
      ('unpricedEventCount'::TEXT), ('unpricedShare'::TEXT),
      ('zeroCostByModel'::TEXT)
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
      5::BIGINT, 4::BIGINT, 2::BIGINT, 2::BIGINT, 0.5::NUMERIC,
      '{"reported":1,"estimated":0,"zero_rate":0,"unpriced":3,"legacy":1,"unset":0}'::JSONB
    )
  $expected$,
  'preflight event and pricing-status aggregates are exact'
);

SELECT results_eq(
  $actual$
    SELECT item->>'model', (item->>'eventCount')::BIGINT, (item->>'totalTokens')::BIGINT
    FROM jsonb_array_elements(public.tokend_pricing_preflight()::JSONB->'zeroCostByModel') AS item
  $actual$,
  $expected$
    VALUES ('gpt-5.6-sol'::TEXT, 2::BIGINT, 251000::BIGINT)
  $expected$,
  'zero-cost-by-model exposes only model aggregates'
);

SELECT is(
  (public.tokend_pricing_preflight()::JSONB->>'postSnapshotEventCount')::BIGINT,
  1::BIGINT,
  'preflight counts the late live revision and excludes frozen run targets'
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

SELECT * FROM finish();
ROLLBACK;
