import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

interface SessionFallback {
  sessionId: string
  sessionKey?: string | null
  agent?: string | null
  channel?: string | null
  currentModel?: string | null
  sourcePath?: string | null
}

interface SessionSnapshotRow {
  firstSeenAt: number | null
  lastSeenAt: number | null
  callCount: number
  totalTokens: number
  totalCost: number
  sessionKey: string | null
  agent: string | null
  channel: string | null
}

const selectSessionSnapshotSql = `
  SELECT
    MIN(timestamp_ms) as firstSeenAt,
    MAX(timestamp_ms) as lastSeenAt,
    COUNT(*) as callCount,
    COALESCE(SUM(total_tokens), 0) as totalTokens,
    COALESCE(SUM(total_cost), 0) as totalCost,
    MAX(session_key) as sessionKey,
    MAX(agent) as agent,
    MAX(channel) as channel
  FROM usage_events
  WHERE session_id = ?
`

const selectLatestModelSql = `
  SELECT model
  FROM usage_events
  WHERE session_id = ?
  ORDER BY timestamp_ms DESC, id DESC
  LIMIT 1
`

const upsertSessionSql = `
  INSERT INTO sessions (
    session_id, session_key, agent, channel, first_seen_at, last_seen_at,
    current_model, call_count, total_tokens, total_cost, source_path
  )
  VALUES (
    @sessionId, @sessionKey, @agent, @channel, @firstSeenAt, @lastSeenAt,
    @currentModel, @callCount, @totalTokens, @totalCost, @sourcePath
  )
  ON CONFLICT(session_id) DO UPDATE SET
    session_key = COALESCE(excluded.session_key, sessions.session_key),
    agent = COALESCE(excluded.agent, sessions.agent),
    channel = COALESCE(excluded.channel, sessions.channel),
    first_seen_at = excluded.first_seen_at,
    last_seen_at = excluded.last_seen_at,
    current_model = COALESCE(excluded.current_model, sessions.current_model),
    call_count = excluded.call_count,
    total_tokens = excluded.total_tokens,
    total_cost = excluded.total_cost,
    source_path = COALESCE(excluded.source_path, sessions.source_path)
`

export function upsertSessionSnapshot(db: DatabaseSync, fallback: SessionFallback): boolean {
  const snapshotStmt = db.prepare(selectSessionSnapshotSql)
  const latestModelStmt = db.prepare(selectLatestModelSql)
  const upsertStmt = db.prepare(upsertSessionSql)

  const snapshot = snapshotStmt.get(fallback.sessionId as SQLInputValue) as unknown as SessionSnapshotRow
  if (!snapshot || snapshot.callCount === 0 || snapshot.firstSeenAt == null || snapshot.lastSeenAt == null) {
    return false
  }

  const latestModelRow = latestModelStmt.get(fallback.sessionId as SQLInputValue) as { model: string | null } | undefined

  upsertStmt.run({
    sessionId: fallback.sessionId,
    sessionKey: snapshot.sessionKey ?? fallback.sessionKey ?? null,
    agent: snapshot.agent ?? fallback.agent ?? null,
    channel: snapshot.channel ?? fallback.channel ?? 'unknown',
    firstSeenAt: snapshot.firstSeenAt,
    lastSeenAt: snapshot.lastSeenAt,
    currentModel: latestModelRow?.model ?? fallback.currentModel ?? null,
    callCount: snapshot.callCount,
    totalTokens: snapshot.totalTokens,
    totalCost: snapshot.totalCost,
    sourcePath: fallback.sourcePath ?? null,
  })

  return true
}

export function rebuildSessionsFromUsage(db: DatabaseSync): number {
  db.exec('DELETE FROM sessions')

  const rows = db.prepare(`
    SELECT
      u.session_id as sessionId,
      MIN(u.timestamp_ms) as firstSeenAt,
      MAX(u.timestamp_ms) as lastSeenAt,
      COUNT(*) as callCount,
      COALESCE(SUM(u.total_tokens), 0) as totalTokens,
      COALESCE(SUM(u.total_cost), 0) as totalCost,
      MAX(u.session_key) as sessionKey,
      MAX(u.agent) as agent,
      MAX(u.channel) as channel,
      (
        SELECT ux.model
        FROM usage_events ux
        WHERE ux.session_id = u.session_id
        ORDER BY ux.timestamp_ms DESC, ux.id DESC
        LIMIT 1
      ) as currentModel,
      MAX(u.source_path) as sourcePath
    FROM usage_events u
    GROUP BY u.session_id
  `).all() as Array<{
    sessionId: string
    firstSeenAt: number
    lastSeenAt: number
    callCount: number
    totalTokens: number
    totalCost: number
    sessionKey: string | null
    agent: string | null
    channel: string | null
    currentModel: string | null
    sourcePath: string | null
  }>

  const upsertStmt = db.prepare(upsertSessionSql)
  for (const row of rows) {
    upsertStmt.run(row)
  }

  return rows.length
}
