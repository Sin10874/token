BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path = public, extensions;

-- Fixture-only production-compatible objects. The surrounding transaction is rolled back.
CREATE TABLE public.tokend_members (
  member_code TEXT PRIMARY KEY
);

CREATE TABLE public.tokend_usage_events (
  id TEXT NOT NULL,
  member_code TEXT NOT NULL REFERENCES public.tokend_members(member_code),
  timestamp_ms BIGINT NOT NULL,
  session_id TEXT NOT NULL,
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
  PRIMARY KEY (member_code, source_path_hash)
);

CREATE TABLE public.tokend_model_prices (
  model_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL
);

\ir ../../migrations/202607100001_pricing_core.sql
\ir ../../migrations/202607100001_pricing_core.sql

SELECT plan(29);

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

SELECT * FROM finish();
ROLLBACK;
