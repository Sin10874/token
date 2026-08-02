-- Install the 2026-08-02 model catalog and keep cache-miss-priced Kimi models fail-closed when
-- cache-miss input cannot be mapped to Tokend token buckets without ambiguity.

CREATE TEMP TABLE IF NOT EXISTS tokend_expected_pricing_models (
  version TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  standard_input_rate NUMERIC(20,10) NOT NULL,
  standard_output_rate NUMERIC(20,10) NOT NULL,
  standard_cache_read_rate NUMERIC(20,10) NOT NULL,
  standard_cache_write_rate NUMERIC(20,10) NOT NULL,
  long_context_input_rate NUMERIC(20,10),
  long_context_output_rate NUMERIC(20,10),
  long_context_cache_read_rate NUMERIC(20,10),
  long_context_cache_write_rate NUMERIC(20,10),
  long_context_threshold BIGINT,
  source_checked_at DATE NOT NULL,
  source_url TEXT NOT NULL,
  PRIMARY KEY (version, model_id, valid_from)
);

CREATE TEMP TABLE IF NOT EXISTS tokend_expected_pricing_aliases (
  version TEXT NOT NULL,
  alias TEXT NOT NULL,
  model_id TEXT NOT NULL,
  PRIMARY KEY (version, alias)
);

-- BEGIN GENERATED PRICING CATALOG
-- Generated from cli/pricing/catalog.ts. Do not edit by hand.
TRUNCATE TABLE pg_temp.tokend_expected_pricing_models;
TRUNCATE TABLE pg_temp.tokend_expected_pricing_aliases;
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'MiniMax-M2.7', 'minimax', '2026-06-12T00:00:00Z', NULL, 0.3, 1.2, 0.06, 0.375, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'MiniMax-M3', 'minimax', '2026-06-12T00:00:00Z', NULL, 0.3, 1.2, 0.06, 0.375, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'claude-fable-5', 'anthropic', '2026-06-09T00:00:00Z', NULL, 10, 50, 1, 12.5, NULL, NULL, NULL, NULL, NULL, '2026-07-10', 'https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'claude-haiku-3', 'anthropic', '2026-06-12T00:00:00Z', NULL, 0.25, 1.25, 0.03, 0.3, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'claude-haiku-3-5', 'anthropic', '2026-06-12T00:00:00Z', NULL, 0.8, 4, 0.08, 1, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'claude-haiku-4-5', 'anthropic', '2026-06-12T00:00:00Z', NULL, 1, 5, 0.1, 1.25, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'claude-haiku-4-5-20251001', 'anthropic', '2026-06-12T00:00:00Z', NULL, 1, 5, 0.1, 1.25, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'claude-opus-4', 'anthropic', '2026-06-12T00:00:00Z', NULL, 15, 75, 1.5, 18.75, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'claude-opus-4-1', 'anthropic', '2026-06-12T00:00:00Z', NULL, 15, 75, 1.5, 18.75, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'claude-opus-4-5', 'anthropic', '2026-06-12T00:00:00Z', NULL, 5, 25, 0.5, 6.25, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'claude-opus-4-6', 'anthropic', '2026-06-12T00:00:00Z', NULL, 5, 25, 0.5, 6.25, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'claude-opus-4-7', 'anthropic', '2026-06-12T00:00:00Z', NULL, 5, 25, 0.5, 6.25, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'claude-opus-4-8', 'anthropic', '2026-06-12T00:00:00Z', NULL, 5, 25, 0.5, 6.25, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'claude-opus-5', 'anthropic', '2026-07-24T00:00:00Z', NULL, 5, 25, 0.5, 6.25, NULL, NULL, NULL, NULL, NULL, '2026-08-02', 'https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'claude-sonnet-3-7', 'anthropic', '2026-06-12T00:00:00Z', NULL, 3, 15, 0.3, 3.75, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'claude-sonnet-4', 'anthropic', '2026-06-12T00:00:00Z', NULL, 3, 15, 0.3, 3.75, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'claude-sonnet-4-5', 'anthropic', '2026-06-12T00:00:00Z', NULL, 3, 15, 0.3, 3.75, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'claude-sonnet-4-6', 'anthropic', '2026-06-12T00:00:00Z', NULL, 3, 15, 0.3, 3.75, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'claude-sonnet-5', 'anthropic', '2026-06-30T00:00:00Z', '2026-09-01T00:00:00Z', 2, 10, 0.2, 2.5, NULL, NULL, NULL, NULL, NULL, '2026-08-02', 'https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'claude-sonnet-5', 'anthropic', '2026-09-01T00:00:00Z', NULL, 3, 15, 0.3, 3.75, NULL, NULL, NULL, NULL, NULL, '2026-08-02', 'https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'codex-auto-review', 'openai', '2026-06-12T00:00:00Z', NULL, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'gemini-2.5-pro', 'google', '2026-06-12T00:00:00Z', NULL, 1.25, 10, 0.31, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'gemini-3-pro-preview', 'google', '2026-06-12T00:00:00Z', NULL, 2, 12, 0.2, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'glm-4.5-air', 'zhipu', '2026-06-12T00:00:00Z', NULL, 0.2, 1.1, 0.03, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'glm-4.7', 'zhipu', '2026-06-12T00:00:00Z', NULL, 0.6, 2.2, 0.11, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'glm-4.7-flashx', 'zhipu', '2026-06-12T00:00:00Z', NULL, 0.07, 0.4, 0.01, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'glm-4.7-free', 'zhipu', '2026-06-12T00:00:00Z', NULL, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'glm-5', 'zhipu', '2026-06-12T00:00:00Z', NULL, 1, 3.2, 0.2, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'glm-5-turbo', 'zhipu', '2026-06-12T00:00:00Z', NULL, 1.2, 4, 0.24, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'glm-5.1', 'zhipu', '2026-06-12T00:00:00Z', NULL, 1.4, 4.4, 0.26, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'glm-5.2', 'zhipu', '2026-06-12T00:00:00Z', NULL, 1.4, 4.4, 0.26, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'gpt-4o', 'openai', '2026-06-12T00:00:00Z', NULL, 2.5, 10, 1.25, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'gpt-5-codex', 'openai', '2026-06-12T00:00:00Z', NULL, 1.25, 10, 0.125, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'gpt-5.3-codex', 'openai', '2026-06-12T00:00:00Z', NULL, 1.75, 14, 0.175, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'gpt-5.3-codex-spark', 'openai', '2026-06-12T00:00:00Z', NULL, 1.75, 14, 0.175, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'gpt-5.4', 'openai', '2026-06-12T00:00:00Z', NULL, 2.5, 15, 0.25, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'gpt-5.5', 'openai', '2026-06-12T00:00:00Z', NULL, 5, 30, 0.5, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'gpt-5.6-luna', 'openai', '2026-06-26T00:00:00Z', NULL, 1, 6, 0.1, 1.25, 2, 9, 0.2, 2.5, 272000, '2026-07-10', 'https://developers.openai.com/api/docs/pricing');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'gpt-5.6-sol', 'openai', '2026-06-26T00:00:00Z', NULL, 5, 30, 0.5, 6.25, 10, 45, 1, 12.5, 272000, '2026-07-10', 'https://developers.openai.com/api/docs/pricing');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'gpt-5.6-terra', 'openai', '2026-06-26T00:00:00Z', NULL, 2.5, 15, 0.25, 3.125, 5, 22.5, 0.5, 6.25, 272000, '2026-07-10', 'https://developers.openai.com/api/docs/pricing');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'grok-code', 'xai', '2026-06-12T00:00:00Z', NULL, 0.2, 1.5, 0.02, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'kimi-k2-thinking', 'moonshot', '2026-06-12T00:00:00Z', NULL, 0.6, 2.5, 0.15, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'kimi-k2.5', 'moonshot', '2026-06-12T00:00:00Z', NULL, 0.6, 3, 0.1, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'kimi-k2.6', 'moonshot', '2026-06-12T00:00:00Z', NULL, 0.95, 4, 0.16, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'kimi-k2.7', 'moonshot', '2026-06-12T00:00:00Z', NULL, 0.95, 4, 0.19, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'kimi-k2.7-code', 'moonshot', '2026-06-12T00:00:00Z', NULL, 0.95, 4, 0.19, 0, NULL, NULL, NULL, NULL, NULL, '2026-08-02', 'https://platform.kimi.ai/docs/pricing/chat-k27-code.md');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'kimi-k3', 'moonshot', '2026-07-16T00:00:00Z', NULL, 3, 15, 0.3, 0, NULL, NULL, NULL, NULL, NULL, '2026-08-02', 'https://platform.kimi.ai/docs/pricing/chat-k3.md');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-08-02', 'minimax-m2.1-free', 'minimax', '2026-06-12T00:00:00Z', NULL, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-08-02', 'M-2.7', 'MiniMax-M2.7');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-08-02', 'M-3', 'MiniMax-M3');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-08-02', 'anthropic/claude-fable-5', 'claude-fable-5');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-08-02', 'claude-fable-5-thinking', 'claude-fable-5');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-08-02', 'fable-5', 'claude-fable-5');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-08-02', 'gpt-5.6', 'gpt-5.6-sol');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-08-02', 'k2p5', 'kimi-k2.5');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-08-02', 'k2p6', 'kimi-k2.6');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-08-02', 'k2p7', 'kimi-k2.7');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-08-02', 'kimi-code/kimi-for-coding', 'kimi-k2.5');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-08-02', 'kimi-for-coding', 'kimi-k2.5');
SELECT public.tokend_install_pricing_catalog('2026-08-02', '0e393d97c225c26e10ffad44367aaf1de69a3943d1fbce0f7459869854284107', '2026-08-02');
-- END GENERATED PRICING CATALOG

CREATE OR REPLACE FUNCTION public.tokend_price_event(
  p_event JSONB,
  p_catalog_version TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_result JSONB;
  v_warnings JSONB := '[]'::JSONB;
  v_raw_model TEXT;
  v_candidate_model TEXT;
  v_matched_model TEXT;
  v_suffix_match TEXT[];
  v_suffix_date DATE;
  v_timestamp_value NUMERIC;
  v_timestamp_ms BIGINT;
  v_event_at TIMESTAMPTZ;
  v_field TEXT;
  v_value NUMERIC;
  v_input_tokens BIGINT := 0;
  v_output_tokens BIGINT := 0;
  v_reasoning_tokens BIGINT := 0;
  v_cache_read_tokens BIGINT := 0;
  v_cache_write_tokens BIGINT := 0;
  v_prompt_tokens BIGINT := 0;
  v_semantics TEXT := 'unknown';
  v_tier TEXT := 'standard';
  v_status TEXT;
  v_reason TEXT;
  v_price public.tokend_pricing_models%ROWTYPE;
  v_input_rate NUMERIC;
  v_output_rate NUMERIC;
  v_cache_read_rate NUMERIC;
  v_cache_write_rate NUMERIC;
  v_input_cost NUMERIC := 0;
  v_output_cost NUMERIC := 0;
  v_reasoning_cost NUMERIC := 0;
  v_cache_read_cost NUMERIC := 0;
  v_cache_write_cost NUMERIC := 0;
  v_total_cost NUMERIC := 0;
  v_money_limit CONSTANT NUMERIC := 9999999999.9999999999;
BEGIN
  v_result := jsonb_build_object(
    'status', 'unpriced',
    'pricingStatus', 'unpriced',
    'tier', 'standard',
    'pricingTier', 'standard',
    'model', NULL,
    'matchedModelId', NULL,
    'priceVersion', NULL,
    'inputCost', 0::NUMERIC,
    'outputCost', 0::NUMERIC,
    'reasoningCost', 0::NUMERIC,
    'cacheReadCost', 0::NUMERIC,
    'cacheWriteCost', 0::NUMERIC,
    'unallocatedCost', 0::NUMERIC,
    'totalCost', 0::NUMERIC,
    'breakdown', jsonb_build_object(
      'inputCost', 0::NUMERIC,
      'outputCost', 0::NUMERIC,
      'reasoningCost', 0::NUMERIC,
      'cacheReadCost', 0::NUMERIC,
      'cacheWriteCost', 0::NUMERIC,
      'unallocatedCost', 0::NUMERIC,
      'totalCost', 0::NUMERIC
    ),
    'breakdownStatus', 'reconciled',
    'reason', 'invalid_event',
    'warnings', v_warnings
  );

  IF jsonb_typeof(p_event) IS DISTINCT FROM 'object' THEN
    RETURN v_result;
  END IF;

  IF p_catalog_version IS NULL
    OR btrim(p_catalog_version) = ''
    OR NOT EXISTS (
      SELECT 1
      FROM public.tokend_pricing_catalogs
      WHERE version = p_catalog_version
    ) THEN
    RETURN v_result || jsonb_build_object('reason', 'unknown_catalog');
  END IF;

  IF jsonb_typeof(p_event->'model') IS DISTINCT FROM 'string'
    OR btrim(p_event->>'model') = '' THEN
    RETURN v_result || jsonb_build_object('reason', 'invalid_model');
  END IF;
  v_raw_model := p_event->>'model';

  SELECT canonical.model_id
  INTO v_matched_model
  FROM public.tokend_pricing_canonical_models AS canonical
  WHERE canonical.version = p_catalog_version
    AND canonical.model_id = v_raw_model
  LIMIT 1;

  IF v_matched_model IS NULL THEN
    SELECT alias_row.model_id
    INTO v_matched_model
    FROM public.tokend_pricing_aliases AS alias_row
    WHERE alias_row.version = p_catalog_version
      AND alias_row.alias = v_raw_model
    LIMIT 1;
  END IF;

  IF v_matched_model IS NULL THEN
    v_suffix_match := regexp_match(v_raw_model, '^(.*)-([0-9]{8})$');
    IF v_suffix_match IS NOT NULL
      AND v_suffix_match[1] <> ''
      AND substring(v_suffix_match[2], 1, 4)::INTEGER BETWEEN 1 AND 9999 THEN
      BEGIN
        v_suffix_date := make_date(
          substring(v_suffix_match[2], 1, 4)::INTEGER,
          substring(v_suffix_match[2], 5, 2)::INTEGER,
          substring(v_suffix_match[2], 7, 2)::INTEGER
        );
      EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
        v_suffix_date := NULL;
      END;

      IF v_suffix_date IS NOT NULL
        AND to_char(v_suffix_date, 'YYYYMMDD') = v_suffix_match[2] THEN
        v_candidate_model := v_suffix_match[1];
        SELECT canonical.model_id
        INTO v_matched_model
        FROM public.tokend_pricing_canonical_models AS canonical
        WHERE canonical.version = p_catalog_version
          AND canonical.model_id = v_candidate_model
        LIMIT 1;

        IF v_matched_model IS NULL THEN
          SELECT alias_row.model_id
          INTO v_matched_model
          FROM public.tokend_pricing_aliases AS alias_row
          WHERE alias_row.version = p_catalog_version
            AND alias_row.alias = v_candidate_model
          LIMIT 1;
        END IF;
      END IF;
    END IF;
  END IF;

  IF v_matched_model IS NULL THEN
    RETURN v_result || jsonb_build_object('reason', 'unknown_model');
  END IF;

  v_result := v_result || jsonb_build_object(
    'model', v_matched_model,
    'matchedModelId', v_matched_model
  );

  IF NOT (p_event ? 'timestampMs')
    OR jsonb_typeof(p_event->'timestampMs') IS DISTINCT FROM 'number' THEN
    RETURN v_result || jsonb_build_object('reason', 'invalid_event_time');
  END IF;
  BEGIN
    v_timestamp_value := (p_event->>'timestampMs')::NUMERIC;
  EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
    RETURN v_result || jsonb_build_object('reason', 'invalid_event_time');
  END;
  IF v_timestamp_value <> trunc(v_timestamp_value)
    OR v_timestamp_value < -62135596800000
    OR v_timestamp_value > 253402300799999 THEN
    RETURN v_result || jsonb_build_object('reason', 'invalid_event_time');
  END IF;
  v_timestamp_ms := v_timestamp_value::BIGINT;
  BEGIN
    v_event_at := TIMESTAMPTZ 'epoch'
      + v_timestamp_ms * INTERVAL '1 millisecond';
  EXCEPTION WHEN datetime_field_overflow OR numeric_value_out_of_range THEN
    RETURN v_result || jsonb_build_object('reason', 'invalid_event_time');
  END;

  FOREACH v_field IN ARRAY ARRAY[
    'inputTokens', 'outputTokens', 'reasoningTokens',
    'cacheReadTokens', 'cacheWriteTokens'
  ]
  LOOP
    IF NOT (p_event ? v_field)
      OR jsonb_typeof(p_event->v_field) IS DISTINCT FROM 'number' THEN
      RETURN v_result || jsonb_build_object('reason', 'invalid_token_buckets');
    END IF;
    BEGIN
      v_value := (p_event->>v_field)::NUMERIC;
    EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
      RETURN v_result || jsonb_build_object('reason', 'invalid_token_buckets');
    END;
    IF v_value < 0 OR v_value <> trunc(v_value) OR v_value > 2147483647 THEN
      RETURN v_result || jsonb_build_object('reason', 'invalid_token_buckets');
    END IF;

    CASE v_field
      WHEN 'inputTokens' THEN v_input_tokens := v_value::BIGINT;
      WHEN 'outputTokens' THEN v_output_tokens := v_value::BIGINT;
      WHEN 'reasoningTokens' THEN v_reasoning_tokens := v_value::BIGINT;
      WHEN 'cacheReadTokens' THEN v_cache_read_tokens := v_value::BIGINT;
      WHEN 'cacheWriteTokens' THEN v_cache_write_tokens := v_value::BIGINT;
    END CASE;
  END LOOP;

  SELECT model_price.*
  INTO v_price
  FROM public.tokend_pricing_models AS model_price
  WHERE model_price.version = p_catalog_version
    AND model_price.model_id = v_matched_model
    AND model_price.valid_from <= v_event_at
    AND (model_price.valid_to IS NULL OR v_event_at < model_price.valid_to)
  ORDER BY model_price.valid_from DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN v_result || jsonb_build_object('reason', 'no_effective_price');
  END IF;

  v_semantics := CASE
    WHEN p_event->>'tokenSemantics' = 'disjoint' THEN 'disjoint'
    ELSE 'unknown'
  END;

  IF v_matched_model IN ('kimi-k2.7-code', 'kimi-k3') AND v_semantics <> 'disjoint' THEN
    RETURN v_result || jsonb_build_object(
      'reason', 'unsupported_token_semantics',
      'warnings', jsonb_build_array('kimi_k3_cache_miss_requires_disjoint_tokens')
    );
  END IF;
  IF v_matched_model IN ('kimi-k2.7-code', 'kimi-k3') AND v_cache_write_tokens <> 0 THEN
    RETURN v_result || jsonb_build_object(
      'reason', 'unsupported_cache_write_mapping',
      'warnings', jsonb_build_array('kimi_k3_cache_write_unmapped')
    );
  END IF;

  v_prompt_tokens := v_input_tokens + v_cache_read_tokens + v_cache_write_tokens;
  v_input_rate := v_price.standard_input_rate;
  v_output_rate := v_price.standard_output_rate;
  v_cache_read_rate := v_price.standard_cache_read_rate;
  v_cache_write_rate := v_price.standard_cache_write_rate;

  IF v_semantics = 'unknown' AND v_price.long_context_threshold IS NOT NULL THEN
    v_warnings := jsonb_build_array('unknown_token_semantics');
  ELSIF v_semantics = 'disjoint'
    AND v_price.long_context_threshold IS NOT NULL
    AND v_prompt_tokens > v_price.long_context_threshold THEN
    v_tier := 'long_context';
    v_input_rate := v_price.long_context_input_rate;
    v_output_rate := v_price.long_context_output_rate;
    v_cache_read_rate := v_price.long_context_cache_read_rate;
    v_cache_write_rate := v_price.long_context_cache_write_rate;
  END IF;

  IF v_input_rate = 0
    AND v_output_rate = 0
    AND v_cache_read_rate = 0
    AND v_cache_write_rate = 0 THEN
    v_status := 'zero_rate';
    v_reason := 'explicit_zero_rate';
  ELSE
    v_status := 'estimated';
    v_reason := 'catalog_price';
  END IF;

  v_input_cost := v_input_tokens * v_input_rate / 1000000::NUMERIC;
  v_output_cost := v_output_tokens * v_output_rate / 1000000::NUMERIC;
  v_reasoning_cost := v_reasoning_tokens * v_output_rate / 1000000::NUMERIC;
  v_cache_read_cost := v_cache_read_tokens * v_cache_read_rate / 1000000::NUMERIC;
  v_cache_write_cost := v_cache_write_tokens * v_cache_write_rate / 1000000::NUMERIC;
  v_total_cost := v_input_cost + v_output_cost + v_reasoning_cost
    + v_cache_read_cost + v_cache_write_cost;

  IF v_input_cost < 0 OR v_input_cost > v_money_limit
    OR v_output_cost < 0 OR v_output_cost > v_money_limit
    OR v_reasoning_cost < 0 OR v_reasoning_cost > v_money_limit
    OR v_cache_read_cost < 0 OR v_cache_read_cost > v_money_limit
    OR v_cache_write_cost < 0 OR v_cache_write_cost > v_money_limit
    OR v_total_cost < 0 OR v_total_cost > v_money_limit THEN
    RETURN v_result || jsonb_build_object('reason', 'cost_out_of_range');
  END IF;

  RETURN jsonb_build_object(
    'status', v_status,
    'pricingStatus', v_status,
    'tier', v_tier,
    'pricingTier', v_tier,
    'model', v_matched_model,
    'matchedModelId', v_matched_model,
    'priceVersion', p_catalog_version || '/' || v_matched_model || '/'
      || to_char(v_price.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'inputCost', v_input_cost,
    'outputCost', v_output_cost,
    'reasoningCost', v_reasoning_cost,
    'cacheReadCost', v_cache_read_cost,
    'cacheWriteCost', v_cache_write_cost,
    'unallocatedCost', 0::NUMERIC,
    'totalCost', v_total_cost,
    'breakdown', jsonb_build_object(
      'inputCost', v_input_cost,
      'outputCost', v_output_cost,
      'reasoningCost', v_reasoning_cost,
      'cacheReadCost', v_cache_read_cost,
      'cacheWriteCost', v_cache_write_cost,
      'unallocatedCost', 0::NUMERIC,
      'totalCost', v_total_cost
    ),
    'breakdownStatus', 'reconciled',
    'reason', v_reason,
    'warnings', v_warnings
  );
END
$function$;
