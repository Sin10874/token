import type { QueryDatabase } from './dashboard-metrics.js'
import {
  getPlatformFilter,
  getPlatformMetrics,
  getPlatformPeriodBounds,
  type PlatformProduct,
} from './platform-summary.js'

function botNickname(sessionKey: string | null, nicknames: Record<string, string>): string | null {
  if (!sessionKey) return null
  const match = sessionKey.match(/:feishu:([^:]+):/)
  return match ? nicknames[match[1]] || null : null
}

export function getPlatformOverviewData(
  db: QueryDatabase,
  product: PlatformProduct,
  requestedPeriod?: string,
  nicknames: Record<string, string> = {},
) {
  const { period, fromMs, prevFromMs, prevToMs, bucket } = getPlatformPeriodBounds(requestedPeriod)
  const filter = getPlatformFilter(product, 'event')
  const bucketExpr = bucket === 'hour'
    ? "strftime('%Y-%m-%d %H:00', event.timestamp_ms / 1000, 'unixepoch', 'localtime')"
    : "date(event.timestamp_ms / 1000, 'unixepoch', 'localtime')"

  const current = getPlatformMetrics(db, product, fromMs)
  const previous = getPlatformMetrics(db, product, prevFromMs, prevToMs)
  const trend = db.prepare(`
    SELECT
      ${bucketExpr} AS bucket,
      COALESCE(SUM(event.input_tokens + event.output_tokens), 0) AS totalTokens,
      COALESCE(SUM(event.input_cost + event.output_cost + event.cache_read_cost), 0) AS totalCost,
      COUNT(*) AS callCount,
      COUNT(DISTINCT event.session_id) AS sessions
    FROM usage_events AS event
    WHERE ${filter} AND event.timestamp_ms >= ?
    GROUP BY bucket
    ORDER BY bucket ASC
  `).all(fromMs) as Array<Record<string, number | string>>

  const topModels = db.prepare(`
    SELECT
      event.model AS label,
      COALESCE(SUM(event.input_tokens + event.output_tokens), 0) AS tokens,
      COALESCE(SUM(event.input_cost + event.output_cost + event.cache_read_cost), 0) AS cost,
      COUNT(*) AS calls,
      COUNT(DISTINCT event.session_id) AS sessions
    FROM usage_events AS event
    WHERE ${filter} AND event.timestamp_ms >= ?
    GROUP BY event.model
    ORDER BY cost DESC, tokens DESC
    LIMIT 8
  `).all(fromMs)

  const topProjects = db.prepare(`
    SELECT
      COALESCE(NULLIF(session.agent, ''), NULLIF(event.agent, ''), '未命名') AS label,
      COALESCE(SUM(event.input_tokens + event.output_tokens), 0) AS tokens,
      COALESCE(SUM(event.input_cost + event.output_cost + event.cache_read_cost), 0) AS cost,
      COUNT(*) AS calls,
      COUNT(DISTINCT event.session_id) AS sessions,
      MAX(event.timestamp_ms) AS lastAt
    FROM usage_events AS event
    LEFT JOIN sessions AS session ON session.session_id = event.session_id
    WHERE ${filter} AND event.timestamp_ms >= ?
    GROUP BY label
    ORDER BY cost DESC, tokens DESC
    LIMIT 8
  `).all(fromMs)

  const topChannels = product === 'openclaw'
    ? db.prepare(`
        SELECT event.channel AS label,
          COALESCE(SUM(event.input_tokens + event.output_tokens), 0) AS tokens,
          COALESCE(SUM(event.input_cost + event.output_cost + event.cache_read_cost), 0) AS cost,
          COUNT(*) AS calls,
          COUNT(DISTINCT event.session_id) AS sessions,
          MAX(event.timestamp_ms) AS lastAt
        FROM usage_events AS event
        WHERE ${filter} AND event.timestamp_ms >= ?
        GROUP BY event.channel
        ORDER BY tokens DESC, cost DESC
        LIMIT 8
      `).all(fromMs)
    : []

  const topAgents = product === 'openclaw'
    ? db.prepare(`
        SELECT COALESCE(NULLIF(event.agent, ''), '未命名') AS label,
          COALESCE(SUM(event.input_tokens + event.output_tokens), 0) AS tokens,
          COALESCE(SUM(event.input_cost + event.output_cost + event.cache_read_cost), 0) AS cost,
          COUNT(*) AS calls,
          COUNT(DISTINCT event.session_id) AS sessions,
          MAX(event.timestamp_ms) AS lastAt
        FROM usage_events AS event
        WHERE ${filter} AND event.timestamp_ms >= ?
        GROUP BY label
        ORDER BY tokens DESC, cost DESC
        LIMIT 8
      `).all(fromMs)
    : []

  const topChannelAgents = product === 'openclaw'
    ? db.prepare(`
        SELECT event.channel,
          COALESCE(NULLIF(event.agent, ''), '未命名') AS agent,
          COALESCE(SUM(event.input_tokens + event.output_tokens), 0) AS tokens,
          COALESCE(SUM(event.input_cost + event.output_cost + event.cache_read_cost), 0) AS cost,
          COUNT(*) AS calls,
          COUNT(DISTINCT event.session_id) AS sessions
        FROM usage_events AS event
        WHERE ${filter} AND event.timestamp_ms >= ?
        GROUP BY event.channel, agent
        ORDER BY tokens DESC, cost DESC
        LIMIT 12
      `).all(fromMs)
    : []

  const rawTopSessions = db.prepare(`
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
    WHERE ${filter} AND event.timestamp_ms >= ?
    GROUP BY event.session_id
    ORDER BY tokens DESC, cost DESC
    LIMIT 12
  `).all(fromMs) as Array<Record<string, unknown>>

  const topSessions = rawTopSessions.map((row) => ({
    ...row,
    title: (row.stored_title as string | null)
      || botNickname(row.session_key as string | null, nicknames)
      || row.agent as string,
  }))

  const peak = trend.length > 0
    ? [...trend].sort((a, b) => Number(b.totalCost) - Number(a.totalCost))[0]
    : null

  return {
    product,
    period,
    current,
    previous,
    trend,
    peak,
    topModels,
    topProjects,
    topChannels,
    topAgents,
    topChannelAgents,
    topSessions,
  }
}
