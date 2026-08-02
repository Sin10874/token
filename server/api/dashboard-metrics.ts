interface QueryResult {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}

export interface QueryDatabase {
  prepare(sql: string): QueryResult
}

const VISIBLE_USAGE = "NOT (channel = 'cron' AND COALESCE(session_key, '') = '')"

function hasTable(db: QueryDatabase, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
}

function activeSummary(db: QueryDatabase, fromMs: number, toMs?: number) {
  const toFilter = toMs == null ? '' : ' AND timestamp_ms < ?'
  const params = toMs == null ? [fromMs] : [fromMs, toMs]
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens + output_tokens), 0) AS totalTokens,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cacheTokens,
      COALESCE(SUM(input_cost + output_cost + cache_read_cost), 0) AS totalCost,
      COUNT(DISTINCT session_id) AS sessions,
      COUNT(DISTINCT channel) AS channels,
      COUNT(*) AS callCount,
      COUNT(*) AS fallbackMessageCount,
      COUNT(CASE WHEN stop_reason = 'end_turn' THEN 1 END) AS fallbackUserMessageCount
    FROM usage_events
    WHERE ${VISIBLE_USAGE} AND timestamp_ms >= ?${toFilter}
  `).get(...params) as Record<string, number>

  if (hasTable(db, 'message_events')) {
    const message = db.prepare(`
      SELECT
        COUNT(*) AS messageCount,
        COUNT(CASE WHEN kind = 'user' THEN 1 END) AS userMessageCount
      FROM message_events
      WHERE ${VISIBLE_USAGE} AND timestamp_ms >= ?${toFilter}
    `).get(...params) as Record<string, number>
    row.messageCount = message.messageCount
    row.userMessageCount = message.userMessageCount
  } else {
    row.messageCount = row.fallbackMessageCount
    row.userMessageCount = row.fallbackUserMessageCount
  }
  row.cacheReadTokens = row.cacheTokens

  delete row.fallbackMessageCount
  delete row.fallbackUserMessageCount
  return row
}

export function getDashboardSummaryRows(
  db: QueryDatabase,
  fromMs: number,
  prevFromMs: number,
  prevToMs: number,
) {
  return {
    current: activeSummary(db, fromMs),
    previous: activeSummary(db, prevFromMs, prevToMs),
  }
}

export function getDashboardDailyRows(db: QueryDatabase, days: number) {
  const from = new Date()
  from.setDate(from.getDate() - Math.max(0, days - 1))
  from.setHours(0, 0, 0, 0)
  return db.prepare(`
    SELECT
      date(timestamp_ms / 1000, 'unixepoch', 'localtime') AS day,
      COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
      COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
      COALESCE(SUM(input_cost + output_cost + cache_read_cost), 0) AS cost,
      COALESCE(SUM(input_cost), 0) AS inputCost,
      COALESCE(SUM(output_cost), 0) AS outputCost,
      COUNT(*) AS calls,
      COUNT(DISTINCT session_id) AS sessions
    FROM usage_events
    WHERE ${VISIBLE_USAGE} AND timestamp_ms >= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(from.getTime()) as Array<Record<string, number | string>>
}

export function getDashboardTopProjects(db: QueryDatabase, fromMs: number) {
  return db.prepare(`
    SELECT
      COALESCE(NULLIF(session.agent, ''), NULLIF(event.agent, ''), '未命名') AS project,
      event.channel,
      COALESCE(SUM(event.input_tokens + event.output_tokens), 0) AS tokens,
      COALESCE(SUM(event.input_cost + event.output_cost + event.cache_read_cost), 0) AS cost,
      COUNT(*) AS calls,
      COUNT(DISTINCT event.session_id) AS sessions,
      MAX(event.timestamp_ms) AS lastAt
    FROM usage_events AS event
    LEFT JOIN sessions AS session ON session.session_id = event.session_id
    WHERE NOT (event.channel = 'cron' AND COALESCE(event.session_key, '') = '')
      AND event.timestamp_ms >= ?
    GROUP BY project, event.channel
    ORDER BY tokens DESC, cost DESC
    LIMIT 10
  `).all(fromMs) as Array<{
    project: string
    channel: string
    tokens: number
    cost: number
  }>
}

function botNickname(sessionKey: string | null, nicknames: Record<string, string>): string | null {
  if (!sessionKey) return null
  const match = sessionKey.match(/:feishu:([^:]+):/)
  return match ? nicknames[match[1]] || null : null
}

export function getDashboardTopConversations(
  db: QueryDatabase,
  fromMs: number,
  nicknames: Record<string, string> = {},
) {
  const rows = db.prepare(`
    SELECT
      event.session_id,
      MAX(event.channel) AS channel,
      COALESCE(NULLIF(session.agent, ''), MAX(NULLIF(event.agent, '')), '未命名') AS agent,
      MAX(event.session_key) AS session_key,
      MAX(session.title) AS stored_title,
      GROUP_CONCAT(DISTINCT event.model) AS models,
      COALESCE(SUM(event.input_tokens + event.output_tokens), 0) AS tokens,
      COALESCE(SUM(event.input_cost + event.output_cost + event.cache_read_cost), 0) AS cost,
      COUNT(*) AS calls,
      MIN(event.timestamp_ms) AS firstAt,
      MAX(event.timestamp_ms) AS lastAt
    FROM usage_events AS event
    LEFT JOIN sessions AS session ON session.session_id = event.session_id
    WHERE NOT (event.channel = 'cron' AND COALESCE(event.session_key, '') = '')
      AND event.timestamp_ms >= ?
    GROUP BY event.session_id
    ORDER BY tokens DESC, cost DESC
    LIMIT 12
  `).all(fromMs) as Array<Record<string, unknown>>

  return rows.map((row) => ({
    ...row,
    title: (row.stored_title as string | null)
      || botNickname(row.session_key as string | null, nicknames)
      || row.agent as string,
  })) as Array<Record<string, unknown> & {
    session_id: string
    title: string
    channel: string
    tokens: number
    cost: number
  }>
}
