\set ON_ERROR_STOP on

SET synchronous_commit = off;
SET maintenance_work_mem = '512MB';

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

CREATE INDEX tokend_usage_events_member_timestamp_idx
  ON public.tokend_usage_events (member_code, timestamp_ms DESC);
CREATE INDEX tokend_usage_events_session_idx
  ON public.tokend_usage_events (member_code, session_id, timestamp_ms);
CREATE INDEX tokend_usage_events_uploaded_idx
  ON public.tokend_usage_events (uploaded_at);
CREATE INDEX tokend_usage_events_model_idx
  ON public.tokend_usage_events (model);

INSERT INTO public.tokend_members (member_code, token)
VALUES ('SCALE001', 'scale-token');

INSERT INTO public.tokend_sessions (session_id, member_code)
SELECT
  'scale-session-' || lpad(series.session_number::TEXT, 7, '0'),
  'SCALE001'
FROM generate_series(0, ((:scale_rows::BIGINT - 1) / 100)) AS series(session_number);

INSERT INTO public.tokend_sessions (session_id, member_code)
VALUES ('scale-session-live', 'SCALE001');

INSERT INTO public.tokend_usage_events (
  id,
  member_code,
  timestamp_ms,
  session_id,
  session_key,
  agent,
  provider,
  model,
  channel,
  input_tokens,
  output_tokens,
  reasoning_tokens,
  cache_read_tokens,
  cache_write_tokens,
  total_tokens,
  input_cost,
  output_cost,
  reasoning_cost,
  cache_read_cost,
  cache_write_cost,
  total_cost,
  project,
  uploaded_at
)
SELECT
  'scale-event-' || lpad(series.event_number::TEXT, 9, '0'),
  'SCALE001',
  (extract(epoch FROM TIMESTAMPTZ '2026-07-01T00:00:00Z') * 1000)::BIGINT
    + series.event_number,
  'scale-session-' || lpad(((series.event_number - 1) / 100)::TEXT, 7, '0'),
  'scale-key',
  'scale-agent',
  CASE series.event_number % 4
    WHEN 0 THEN 'anthropic'
    ELSE 'openai'
  END,
  CASE series.event_number % 4
    WHEN 0 THEN 'claude-fable-5'
    WHEN 1 THEN 'gpt-5.6-sol'
    WHEN 2 THEN 'gpt-5.6-terra'
    ELSE 'gpt-5.6-luna'
  END,
  'scale-' || MOD(series.event_number, :scale_channels::BIGINT)::TEXT,
  100,
  20,
  0,
  10,
  5,
  135,
  0,
  0,
  0,
  0,
  0,
  0,
  'pricing-scale',
  clock_timestamp()
FROM generate_series(1, :scale_rows::BIGINT) AS series(event_number);

ANALYZE public.tokend_usage_events;

SELECT 1 / CASE
  WHEN count(*) = :scale_rows::BIGINT THEN 1
  ELSE 0
END AS fixture_count_matches
FROM public.tokend_usage_events;
