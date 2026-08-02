-- ============================================================
-- Tokend Cloud-Sync Supabase Schema
-- Run in Supabase SQL Editor — single file, idempotent
-- ============================================================

-- ============================================================
-- 1. ALTER tokend_members — add token columns
-- ============================================================
ALTER TABLE tokend_members ADD COLUMN IF NOT EXISTS token TEXT UNIQUE;
ALTER TABLE tokend_members ADD COLUMN IF NOT EXISTS token_created_at TIMESTAMPTZ;

-- ============================================================
-- 2. CREATE tokend_usage_events
-- ============================================================
CREATE TABLE IF NOT EXISTS tokend_usage_events (
  id                  TEXT        NOT NULL,
  member_code         TEXT        NOT NULL
                        REFERENCES tokend_members(member_code),
  timestamp_ms        BIGINT      NOT NULL,
  session_id          TEXT        NOT NULL,
  session_key         TEXT,
  agent               TEXT,
  provider            TEXT,
  model               TEXT,
  channel             TEXT        DEFAULT 'unknown',
  input_tokens        INTEGER     DEFAULT 0,
  output_tokens       INTEGER     DEFAULT 0,
  reasoning_tokens    INTEGER     DEFAULT 0,
  cache_read_tokens   INTEGER     DEFAULT 0,
  cache_write_tokens  INTEGER     DEFAULT 0,
  total_tokens        INTEGER     DEFAULT 0,
  input_cost          REAL        DEFAULT 0,
  output_cost         REAL        DEFAULT 0,
  reasoning_cost      REAL        DEFAULT 0,
  cache_read_cost     REAL        DEFAULT 0,
  cache_write_cost    REAL        DEFAULT 0,
  total_cost          REAL        DEFAULT 0,
  stop_reason         TEXT,
  uploaded_at         TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (id, member_code)
);

CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp_ms
  ON tokend_usage_events (timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_usage_events_member_session
  ON tokend_usage_events (member_code, session_id);
CREATE INDEX IF NOT EXISTS idx_usage_events_member_channel
  ON tokend_usage_events (member_code, channel);
CREATE INDEX IF NOT EXISTS idx_usage_events_member_timestamp
  ON tokend_usage_events (member_code, timestamp_ms);

-- ============================================================
-- 3. CREATE tokend_sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS tokend_sessions (
  session_id      TEXT        NOT NULL,
  member_code     TEXT        NOT NULL
                    REFERENCES tokend_members(member_code),
  session_key     TEXT,
  agent           TEXT,
  title           TEXT,
  channel         TEXT        DEFAULT 'unknown',
  first_seen_at   BIGINT,
  last_seen_at    BIGINT,
  current_model   TEXT,
  call_count      INTEGER     DEFAULT 0,
  total_tokens    INTEGER     DEFAULT 0,
  total_cost      REAL        DEFAULT 0,
  updated_at      TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (session_id, member_code)
);

-- ============================================================
-- 4. CREATE tokend_sync_state
-- ============================================================
CREATE TABLE IF NOT EXISTS tokend_sync_state (
  member_code         TEXT        NOT NULL
                        REFERENCES tokend_members(member_code),
  source_path_hash    TEXT        NOT NULL,
  last_processed_lines INTEGER   DEFAULT 0,
  parser_version      INTEGER    DEFAULT 1,
  last_sync_at        TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (member_code, source_path_hash)
);

-- ============================================================
-- 5. ENABLE RLS on all new tables
-- ============================================================
ALTER TABLE tokend_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tokend_sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE tokend_sync_state   ENABLE ROW LEVEL SECURITY;

-- No direct-access policies — all access via SECURITY DEFINER RPCs.

-- ============================================================
-- 6. RPC FUNCTIONS
-- ============================================================

-- ----------------------------------------------------------
-- 6a. verify_member
-- ----------------------------------------------------------
CREATE OR REPLACE FUNCTION verify_member(
  p_phone       TEXT,
  p_member_code TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_member RECORD;
  v_token  TEXT;
BEGIN
  SELECT * INTO v_member
    FROM tokend_members
   WHERE phone = p_phone
     AND UPPER(member_code) = UPPER(p_member_code)
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'member_not_found');
  END IF;

  -- Generate token if none exists
  IF v_member.token IS NULL THEN
    v_token := 'tkd_' || replace(gen_random_uuid()::text, '-', '');
    UPDATE tokend_members
       SET token = v_token,
           token_created_at = now()
     WHERE id = v_member.id;
  ELSE
    v_token := v_member.token;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'member', json_build_object(
      'code', v_member.member_code,
      'tagline', v_member.tagline
    ),
    'token', v_token
  );
END;
$$;

-- ----------------------------------------------------------
-- 6b. tokend_validate_token
-- ----------------------------------------------------------
CREATE OR REPLACE FUNCTION tokend_validate_token(
  p_token TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code TEXT;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false);
  END IF;

  RETURN json_build_object('ok', true, 'member_code', v_code);
END;
$$;

-- ----------------------------------------------------------
-- 6c. tokend_upload_events
-- ----------------------------------------------------------
CREATE OR REPLACE FUNCTION tokend_upload_events(
  p_token       TEXT,
  p_events      JSONB,
  p_sync_states JSONB
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code    TEXT;
  v_evt     JSONB;
  v_ss      JSONB;
  v_count   INTEGER := 0;
BEGIN
  -- validate token
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  -- insert events
  FOR v_evt IN SELECT * FROM jsonb_array_elements(p_events)
  LOOP
    INSERT INTO tokend_usage_events (
      id, member_code, timestamp_ms, session_id, session_key,
      agent, provider, model, channel,
      input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens, total_tokens,
      input_cost, output_cost, reasoning_cost,
      cache_read_cost, cache_write_cost, total_cost,
      stop_reason
    ) VALUES (
      v_evt->>'id',
      v_code,
      (v_evt->>'timestampMs')::BIGINT,
      v_evt->>'sessionId',
      v_evt->>'sessionKey',
      v_evt->>'agent',
      v_evt->>'provider',
      v_evt->>'model',
      COALESCE(v_evt->>'channel', 'unknown'),
      COALESCE((v_evt->>'inputTokens')::INTEGER, 0),
      COALESCE((v_evt->>'outputTokens')::INTEGER, 0),
      COALESCE((v_evt->>'reasoningTokens')::INTEGER, 0),
      COALESCE((v_evt->>'cacheReadTokens')::INTEGER, 0),
      COALESCE((v_evt->>'cacheWriteTokens')::INTEGER, 0),
      COALESCE((v_evt->>'totalTokens')::INTEGER, 0),
      COALESCE((v_evt->>'inputCost')::REAL, 0),
      COALESCE((v_evt->>'outputCost')::REAL, 0),
      COALESCE((v_evt->>'reasoningCost')::REAL, 0),
      COALESCE((v_evt->>'cacheReadCost')::REAL, 0),
      COALESCE((v_evt->>'cacheWriteCost')::REAL, 0),
      COALESCE((v_evt->>'totalCost')::REAL, 0),
      v_evt->>'stopReason'
    )
    ON CONFLICT (id, member_code) DO NOTHING;

    -- count only if actually inserted
    IF FOUND THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;

  -- upsert sync states
  FOR v_ss IN SELECT * FROM jsonb_array_elements(p_sync_states)
  LOOP
    INSERT INTO tokend_sync_state (
      member_code, source_path_hash, last_processed_lines,
      parser_version, last_sync_at
    ) VALUES (
      v_code,
      v_ss->>'sourcePathHash',
      COALESCE((v_ss->>'lastProcessedLines')::INTEGER, 0),
      COALESCE((v_ss->>'parserVersion')::INTEGER, 1),
      now()
    )
    ON CONFLICT (member_code, source_path_hash)
    DO UPDATE SET
      last_processed_lines = COALESCE((v_ss->>'lastProcessedLines')::INTEGER, 0),
      parser_version       = COALESCE((v_ss->>'parserVersion')::INTEGER, 1),
      last_sync_at         = now();
  END LOOP;

  RETURN json_build_object('ok', true, 'inserted', v_count);
END;
$$;

-- ----------------------------------------------------------
-- 6d. tokend_rebuild_sessions
-- ----------------------------------------------------------
CREATE OR REPLACE FUNCTION tokend_rebuild_sessions(
  p_token       TEXT,
  p_session_ids TEXT[]
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code    TEXT;
  v_sid     TEXT;
  v_count   INTEGER := 0;
  v_agg     RECORD;
BEGIN
  -- validate token
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  FOREACH v_sid IN ARRAY p_session_ids
  LOOP
    SELECT
      MIN(e.timestamp_ms)   AS first_seen_at,
      MAX(e.timestamp_ms)   AS last_seen_at,
      COUNT(*)::INTEGER      AS call_count,
      SUM(e.total_tokens)::INTEGER AS total_tokens,
      SUM(e.total_cost)::REAL      AS total_cost,
      -- most recent model (by timestamp)
      (ARRAY_AGG(e.model ORDER BY e.timestamp_ms DESC))[1]       AS current_model,
      (ARRAY_AGG(e.agent ORDER BY e.timestamp_ms DESC))[1]       AS agent,
      (ARRAY_AGG(e.channel ORDER BY e.timestamp_ms DESC))[1]     AS channel,
      (ARRAY_AGG(e.session_key ORDER BY e.timestamp_ms DESC))[1] AS session_key
    INTO v_agg
    FROM tokend_usage_events e
    WHERE e.member_code = v_code
      AND e.session_id  = v_sid;

    -- skip if no events for this session
    IF v_agg.call_count IS NULL OR v_agg.call_count = 0 THEN
      CONTINUE;
    END IF;

    INSERT INTO tokend_sessions (
      session_id, member_code, session_key, agent, channel,
      first_seen_at, last_seen_at, current_model,
      call_count, total_tokens, total_cost, updated_at
    ) VALUES (
      v_sid, v_code, v_agg.session_key, v_agg.agent, v_agg.channel,
      v_agg.first_seen_at, v_agg.last_seen_at, v_agg.current_model,
      v_agg.call_count, v_agg.total_tokens, v_agg.total_cost, now()
    )
    ON CONFLICT (session_id, member_code)
    DO UPDATE SET
      session_key   = EXCLUDED.session_key,
      agent         = EXCLUDED.agent,
      channel       = EXCLUDED.channel,
      first_seen_at = EXCLUDED.first_seen_at,
      last_seen_at  = EXCLUDED.last_seen_at,
      current_model = EXCLUDED.current_model,
      call_count    = EXCLUDED.call_count,
      total_tokens  = EXCLUDED.total_tokens,
      total_cost    = EXCLUDED.total_cost,
      updated_at    = now();

    v_count := v_count + 1;
  END LOOP;

  RETURN json_build_object('ok', true, 'sessions_updated', v_count);
END;
$$;

-- ----------------------------------------------------------
-- 6e. tokend_get_sync_state
-- ----------------------------------------------------------
CREATE OR REPLACE FUNCTION tokend_get_sync_state(
  p_token TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code   TEXT;
  v_states JSONB;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'sourcePathHash',     source_path_hash,
      'lastProcessedLines', last_processed_lines,
      'parserVersion',      parser_version,
      'lastSyncAt',         last_sync_at
    )
  ), '[]'::jsonb)
  INTO v_states
  FROM tokend_sync_state
  WHERE member_code = v_code;

  RETURN json_build_object('ok', true, 'states', v_states);
END;
$$;

-- ----------------------------------------------------------
-- 6f. tokend_get_summary
-- ----------------------------------------------------------
CREATE OR REPLACE FUNCTION tokend_get_summary(
  p_token  TEXT,
  p_period TEXT DEFAULT '7d'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code       TEXT;
  v_days       INTEGER;
  v_from_ms    BIGINT;
  v_prev_from  BIGINT;
  v_cur        RECORD;
  v_prev       RECORD;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  -- period → days
  v_days := CASE p_period
    WHEN '1d'  THEN 1
    WHEN '7d'  THEN 7
    WHEN '30d' THEN 30
    ELSE 7
  END;

  v_from_ms   := (EXTRACT(EPOCH FROM (now() - (v_days || ' days')::INTERVAL)) * 1000)::BIGINT;
  v_prev_from := (EXTRACT(EPOCH FROM (now() - (v_days * 2 || ' days')::INTERVAL)) * 1000)::BIGINT;

  -- current period
  SELECT
    COALESCE(SUM(total_tokens), 0)::BIGINT        AS total_tokens,
    COALESCE(SUM(total_cost), 0)::REAL             AS total_cost,
    COUNT(*)::INTEGER                               AS call_count,
    COUNT(DISTINCT session_id)::INTEGER             AS session_count,
    COUNT(DISTINCT channel)::INTEGER                AS channel_count
  INTO v_cur
  FROM tokend_usage_events
  WHERE member_code = v_code
    AND timestamp_ms >= v_from_ms;

  -- previous period (for trend)
  SELECT
    COALESCE(SUM(total_tokens), 0)::BIGINT  AS total_tokens,
    COALESCE(SUM(total_cost), 0)::REAL       AS total_cost,
    COUNT(*)::INTEGER                         AS call_count,
    COUNT(DISTINCT session_id)::INTEGER       AS session_count,
    COUNT(DISTINCT channel)::INTEGER          AS channel_count
  INTO v_prev
  FROM tokend_usage_events
  WHERE member_code = v_code
    AND timestamp_ms >= v_prev_from
    AND timestamp_ms <  v_from_ms;

  RETURN json_build_object(
    'ok', true,
    'current', json_build_object(
      'totalTokens',   v_cur.total_tokens,
      'totalCost',     v_cur.total_cost,
      'callCount',     v_cur.call_count,
      'sessionCount',  v_cur.session_count,
      'channelCount',  v_cur.channel_count
    ),
    'previous', json_build_object(
      'totalTokens',   v_prev.total_tokens,
      'totalCost',     v_prev.total_cost,
      'callCount',     v_prev.call_count,
      'sessionCount',  v_prev.session_count,
      'channelCount',  v_prev.channel_count
    )
  );
END;
$$;

-- ----------------------------------------------------------
-- 6g. tokend_get_daily_trend
-- ----------------------------------------------------------
CREATE OR REPLACE FUNCTION tokend_get_daily_trend(
  p_token  TEXT,
  p_period TEXT DEFAULT '7d'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code    TEXT;
  v_days    INTEGER;
  v_from_ms BIGINT;
  v_rows    JSONB;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  v_days    := CASE p_period
    WHEN '1d'  THEN 1
    WHEN '7d'  THEN 7
    WHEN '30d' THEN 30
    ELSE 7
  END;
  v_from_ms := (EXTRACT(EPOCH FROM (now() - (v_days || ' days')::INTERVAL)) * 1000)::BIGINT;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'day',      d.day,
      'tokens',   d.tokens,
      'cost',     d.cost,
      'calls',    d.calls,
      'sessions', d.sessions
    ) ORDER BY d.day
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      TO_CHAR(
        TO_TIMESTAMP(timestamp_ms / 1000.0) AT TIME ZONE 'Asia/Shanghai',
        'YYYY-MM-DD'
      )                                     AS day,
      SUM(total_tokens)::BIGINT             AS tokens,
      SUM(total_cost)::REAL                 AS cost,
      COUNT(*)::INTEGER                     AS calls,
      COUNT(DISTINCT session_id)::INTEGER   AS sessions
    FROM tokend_usage_events
    WHERE member_code = v_code
      AND timestamp_ms >= v_from_ms
    GROUP BY 1
  ) d;

  RETURN json_build_object('ok', true, 'days', v_rows);
END;
$$;

-- ----------------------------------------------------------
-- 6h. tokend_get_sessions
-- ----------------------------------------------------------
CREATE OR REPLACE FUNCTION tokend_get_sessions(
  p_token  TEXT,
  p_period TEXT DEFAULT '7d',
  p_limit  INT  DEFAULT 50
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code    TEXT;
  v_days    INTEGER;
  v_from_ms BIGINT;
  v_rows    JSONB;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  v_days    := CASE p_period
    WHEN '1d'  THEN 1
    WHEN '7d'  THEN 7
    WHEN '30d' THEN 30
    ELSE 7
  END;
  v_from_ms := (EXTRACT(EPOCH FROM (now() - (v_days || ' days')::INTERVAL)) * 1000)::BIGINT;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'sessionId',    s.session_id,
      'sessionKey',   s.session_key,
      'agent',        s.agent,
      'title',        s.title,
      'channel',      s.channel,
      'firstSeenAt',  s.first_seen_at,
      'lastSeenAt',   s.last_seen_at,
      'currentModel', s.current_model,
      'callCount',    s.call_count,
      'totalTokens',  s.total_tokens,
      'totalCost',    s.total_cost
    ) ORDER BY s.last_seen_at DESC
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT *
    FROM tokend_sessions
    WHERE member_code = v_code
      AND last_seen_at >= v_from_ms
    ORDER BY last_seen_at DESC
    LIMIT p_limit
  ) s;

  RETURN json_build_object('ok', true, 'sessions', v_rows);
END;
$$;

-- ----------------------------------------------------------
-- 6i. tokend_get_model_breakdown
-- ----------------------------------------------------------
CREATE OR REPLACE FUNCTION tokend_get_model_breakdown(
  p_token  TEXT,
  p_period TEXT DEFAULT '7d'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code    TEXT;
  v_days    INTEGER;
  v_from_ms BIGINT;
  v_rows    JSONB;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  v_days    := CASE p_period
    WHEN '1d'  THEN 1
    WHEN '7d'  THEN 7
    WHEN '30d' THEN 30
    ELSE 7
  END;
  v_from_ms := (EXTRACT(EPOCH FROM (now() - (v_days || ' days')::INTERVAL)) * 1000)::BIGINT;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'model',    m.model,
      'provider', m.provider,
      'tokens',   m.tokens,
      'cost',     m.cost,
      'calls',    m.calls
    ) ORDER BY m.tokens DESC
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      model,
      provider,
      SUM(total_tokens)::BIGINT  AS tokens,
      SUM(total_cost)::REAL      AS cost,
      COUNT(*)::INTEGER          AS calls
    FROM tokend_usage_events
    WHERE member_code = v_code
      AND timestamp_ms >= v_from_ms
    GROUP BY model, provider
    ORDER BY tokens DESC
    LIMIT 10
  ) m;

  RETURN json_build_object('ok', true, 'models', v_rows);
END;
$$;

-- ----------------------------------------------------------
-- 6j. tokend_get_channel_breakdown
-- ----------------------------------------------------------
CREATE OR REPLACE FUNCTION tokend_get_channel_breakdown(
  p_token  TEXT,
  p_period TEXT DEFAULT '7d'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code    TEXT;
  v_days    INTEGER;
  v_from_ms BIGINT;
  v_rows    JSONB;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  v_days    := CASE p_period
    WHEN '1d'  THEN 1
    WHEN '7d'  THEN 7
    WHEN '30d' THEN 30
    ELSE 7
  END;
  v_from_ms := (EXTRACT(EPOCH FROM (now() - (v_days || ' days')::INTERVAL)) * 1000)::BIGINT;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'channel',  c.channel,
      'tokens',   c.tokens,
      'cost',     c.cost,
      'calls',    c.calls,
      'sessions', c.sessions
    ) ORDER BY c.tokens DESC
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      channel,
      SUM(total_tokens)::BIGINT           AS tokens,
      SUM(total_cost)::REAL               AS cost,
      COUNT(*)::INTEGER                   AS calls,
      COUNT(DISTINCT session_id)::INTEGER AS sessions
    FROM tokend_usage_events
    WHERE member_code = v_code
      AND timestamp_ms >= v_from_ms
    GROUP BY channel
    ORDER BY tokens DESC
  ) c;

  RETURN json_build_object('ok', true, 'channels', v_rows);
END;
$$;

-- ============================================================
-- Done. All tables, indexes, RLS, and RPCs are ready.
-- ============================================================
