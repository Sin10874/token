import { Router, Request, Response } from 'express'
import fs from 'fs'
import path from 'path'
import os from 'os'
import db from '../db/index.js'
import { runIngestion } from '../ingestion/index.js'

const router = Router()
const TOOL_CHANNELS = ['claude-code', 'codex', 'gemini-cli', 'copilot-cli', 'opencode'] as const
const OPENCLAW_CHANNEL_FILTER = TOOL_CHANNELS.map((c) => `'${c}'`).join(', ')
const OVERVIEW_PRODUCTS = ['claude-code', 'codex', 'openclaw'] as const
type OverviewProduct = typeof OVERVIEW_PRODUCTS[number]

// Read bot nicknames from openclaw.json (read-only, never writes)
function loadBotNicknames(): Record<string, string> {
  const map: Record<string, string> = {}
  try {
    const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json')
    if (!fs.existsSync(configPath)) return map
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const accounts = config?.channels?.feishu?.accounts || {}
    for (const [key, val] of Object.entries(accounts)) {
      const botName = (val as Record<string, unknown>)?.botName as string
      if (botName) map[key] = botName
    }
  } catch (_e) { /* non-fatal */ }
  return map
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function dateToMs(dateStr: string): number {
  return new Date(dateStr).getTime()
}

function todayStart(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function hoursAgo(h: number): number {
  return Date.now() - h * 3600_000
}

function daysAgoStart(n: number): number {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function getPeriodBounds(period?: string) {
  if (period === '1d') {
    const fromMs = hoursAgo(24)
    return { period: '1d' as const, fromMs, prevFromMs: hoursAgo(48), prevToMs: fromMs, bucket: 'hour' as const }
  }
  if (period === '30d') {
    const fromMs = daysAgoStart(29)
    return { period: '30d' as const, fromMs, prevFromMs: daysAgoStart(59), prevToMs: fromMs, bucket: 'day' as const }
  }
  const fromMs = daysAgoStart(6)
  return { period: '7d' as const, fromMs, prevFromMs: daysAgoStart(13), prevToMs: fromMs, bucket: 'day' as const }
}

function getOverviewProductFilter(product: OverviewProduct): string {
  if (product === 'openclaw') return `channel NOT IN (${OPENCLAW_CHANNEL_FILTER}, 'unknown', 'cron')`
  return `channel = '${product}'`
}

// ─── Summary / Dashboard ─────────────────────────────────────────────────────

router.get('/summary', (req: Request, res: Response) => {
  const period = req.query.period as string | undefined
  let fromMs: number
  let prevFromMs: number
  let prevToMs: number
  if (period === '7d') {
    fromMs = daysAgoStart(6)
    prevFromMs = daysAgoStart(13)
    prevToMs = fromMs
  } else if (period === '30d') {
    fromMs = daysAgoStart(29)
    prevFromMs = daysAgoStart(59)
    prevToMs = fromMs
  } else {
    // 1d (default) — past 24 hours
    fromMs = hoursAgo(24)
    prevFromMs = hoursAgo(48)
    prevToMs = fromMs
  }

  const currentRow = db.prepare(`
    SELECT
      COALESCE(SUM(total_tokens), 0) as totalTokens,
      COALESCE(SUM(input_tokens), 0) as inputTokens,
      COALESCE(SUM(output_tokens), 0) as outputTokens,
      COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens,
      COALESCE(SUM(total_cost), 0) as totalCost,
      COUNT(DISTINCT session_id) as sessions,
      COUNT(DISTINCT channel) as channels,
      COUNT(*) as callCount,
      COUNT(*) as messageCount,
      COUNT(CASE WHEN stop_reason = 'end_turn' THEN 1 END) as userMessageCount
    FROM usage_events
    WHERE timestamp_ms >= ?
  `).get(fromMs) as Record<string, number>

  const prevRow = db.prepare(`
    SELECT
      COALESCE(SUM(total_tokens), 0) as totalTokens,
      COALESCE(SUM(input_tokens), 0) as inputTokens,
      COALESCE(SUM(output_tokens), 0) as outputTokens,
      COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens,
      COALESCE(SUM(total_cost), 0) as totalCost,
      COUNT(*) as callCount,
      COUNT(*) as messageCount,
      COUNT(CASE WHEN stop_reason = 'end_turn' THEN 1 END) as userMessageCount
    FROM usage_events
    WHERE timestamp_ms >= ? AND timestamp_ms < ?
  `).get(prevFromMs, prevToMs) as Record<string, number>

  const modelDist = db.prepare(`
    SELECT model, provider,
      SUM(total_tokens) as tokens,
      SUM(total_cost) as cost,
      COUNT(*) as calls
    FROM usage_events
    WHERE timestamp_ms >= ?
    GROUP BY model
    ORDER BY tokens DESC
    LIMIT 10
  `).all(fromMs)

  const channelDist = db.prepare(`
    SELECT channel,
      SUM(total_tokens) as tokens,
      SUM(total_cost) as cost,
      COUNT(DISTINCT session_id) as sessions
    FROM usage_events
    WHERE timestamp_ms >= ?
    GROUP BY channel
    ORDER BY tokens DESC
  `).all(fromMs)

  const topSessions = db.prepare(`
    SELECT session_id, channel, agent,
      MAX(session_key) as session_key,
      SUM(total_tokens) as tokens,
      SUM(total_cost) as cost,
      COUNT(*) as calls,
      MIN(timestamp_ms) as firstAt,
      MAX(timestamp_ms) as lastAt
    FROM usage_events
    WHERE timestamp_ms >= ? AND agent != ''
    GROUP BY session_id
    ORDER BY tokens DESC
    LIMIT 8
  `).all(fromMs)

  // Trend data: for 1d use hourly, for 7d/30d use daily
  let trend: unknown[]
  const trendCols = `
        SUM(total_tokens) as tokens,
        SUM(input_tokens) as inputTokens,
        SUM(output_tokens) as outputTokens,
        SUM(total_cost) as cost,
        SUM(input_cost) as inputCost,
        SUM(output_cost) as outputCost
  `
  if (period === '1d' || !period) {
    trend = db.prepare(`
      SELECT
        strftime('%Y-%m-%d %H:00', timestamp_ms / 1000, 'unixepoch', 'localtime') as day,
        ${trendCols}
      FROM usage_events
      WHERE timestamp_ms >= ?
      GROUP BY day
      ORDER BY day ASC
    `).all(fromMs)
  } else {
    trend = db.prepare(`
      SELECT
        date(timestamp_ms / 1000, 'unixepoch', 'localtime') as day,
        ${trendCols}
      FROM usage_events
      WHERE timestamp_ms >= ?
      GROUP BY day
      ORDER BY day ASC
    `).all(fromMs)
  }

  // Product breakdown: OpenClaw vs Claude Code vs Codex
  const ccCurrent = db.prepare(`
    SELECT
      COALESCE(SUM(total_tokens), 0) as totalTokens,
      COALESCE(SUM(total_cost), 0) as totalCost,
      COUNT(*) as callCount,
      COUNT(DISTINCT session_id) as sessions
    FROM usage_events
    WHERE timestamp_ms >= ? AND channel = 'claude-code'
  `).get(fromMs) as Record<string, number>

  const ocCurrent = db.prepare(`
    SELECT
      COALESCE(SUM(total_tokens), 0) as totalTokens,
      COALESCE(SUM(total_cost), 0) as totalCost,
      COUNT(*) as callCount,
      COUNT(DISTINCT session_id) as sessions
    FROM usage_events
    WHERE timestamp_ms >= ? AND channel NOT IN (${OPENCLAW_CHANNEL_FILTER})
  `).get(fromMs) as Record<string, number>

  const cxCurrent = db.prepare(`
    SELECT
      COALESCE(SUM(total_tokens), 0) as totalTokens,
      COALESCE(SUM(total_cost), 0) as totalCost,
      COUNT(*) as callCount,
      COUNT(DISTINCT session_id) as sessions
    FROM usage_events
    WHERE timestamp_ms >= ? AND channel = 'codex'
  `).get(fromMs) as Record<string, number>

  const cc7d = db.prepare(`
    SELECT
      COALESCE(SUM(total_cost), 0) as cost,
      COALESCE(SUM(total_tokens), 0) as tokens
    FROM usage_events
    WHERE timestamp_ms >= ? AND channel = 'claude-code'
  `).get(daysAgoStart(6)) as Record<string, number>

  const oc7d = db.prepare(`
    SELECT
      COALESCE(SUM(total_cost), 0) as cost,
      COALESCE(SUM(total_tokens), 0) as tokens
    FROM usage_events
    WHERE timestamp_ms >= ? AND channel NOT IN (${OPENCLAW_CHANNEL_FILTER})
  `).get(daysAgoStart(6)) as Record<string, number>

  const cx7d = db.prepare(`
    SELECT
      COALESCE(SUM(total_cost), 0) as cost,
      COALESCE(SUM(total_tokens), 0) as tokens
    FROM usage_events
    WHERE timestamp_ms >= ? AND channel = 'codex'
  `).get(daysAgoStart(6)) as Record<string, number>

  res.json({
    today: currentRow,
    yesterday: prevRow,
    modelDistribution: modelDist,
    channelDistribution: channelDist,
    topSessions,
    trend7: trend,
    botNicknames: loadBotNicknames(),
    productBreakdown: {
      claudeCode: { today: ccCurrent, cost7d: cc7d.cost, tokens7d: cc7d.tokens },
      openClaw: { today: ocCurrent, cost7d: oc7d.cost, tokens7d: oc7d.tokens },
      codex: { today: cxCurrent, cost7d: cx7d.cost, tokens7d: cx7d.tokens },
    },
  })
})

router.get('/platforms/:product/overview', (req: Request, res: Response) => {
  const rawProduct = req.params.product as OverviewProduct
  if (!OVERVIEW_PRODUCTS.includes(rawProduct)) {
    return res.status(404).json({ error: 'unknown product' })
  }

  const { period, fromMs, prevFromMs, prevToMs, bucket } = getPeriodBounds(req.query.period as string | undefined)
  const productFilter = getOverviewProductFilter(rawProduct)
  const bucketExpr = bucket === 'hour'
    ? `strftime('%Y-%m-%d %H:00', timestamp_ms / 1000, 'unixepoch', 'localtime')`
    : `date(timestamp_ms / 1000, 'unixepoch', 'localtime')`

  const current = db.prepare(`
    SELECT
      COALESCE(SUM(total_tokens), 0) as totalTokens,
      COALESCE(SUM(input_tokens), 0) as inputTokens,
      COALESCE(SUM(output_tokens), 0) as outputTokens,
      COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens,
      COALESCE(SUM(cache_write_tokens), 0) as cacheWriteTokens,
      COALESCE(SUM(total_cost), 0) as totalCost,
      COUNT(*) as callCount,
      COUNT(DISTINCT session_id) as sessions,
      COUNT(DISTINCT CASE WHEN agent != '' THEN agent END) as projectCount,
      COUNT(DISTINCT CASE WHEN channel != '' THEN channel END) as channelCount
    FROM usage_events
    WHERE ${productFilter} AND timestamp_ms >= ?
  `).get(fromMs) as Record<string, number>

  const previous = db.prepare(`
    SELECT
      COALESCE(SUM(total_tokens), 0) as totalTokens,
      COALESCE(SUM(input_tokens), 0) as inputTokens,
      COALESCE(SUM(output_tokens), 0) as outputTokens,
      COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens,
      COALESCE(SUM(cache_write_tokens), 0) as cacheWriteTokens,
      COALESCE(SUM(total_cost), 0) as totalCost,
      COUNT(*) as callCount,
      COUNT(DISTINCT session_id) as sessions,
      COUNT(DISTINCT CASE WHEN agent != '' THEN agent END) as projectCount,
      COUNT(DISTINCT CASE WHEN channel != '' THEN channel END) as channelCount
    FROM usage_events
    WHERE ${productFilter} AND timestamp_ms >= ? AND timestamp_ms < ?
  `).get(prevFromMs, prevToMs) as Record<string, number>

  const trend = db.prepare(`
    SELECT
      ${bucketExpr} as bucket,
      COALESCE(SUM(total_tokens), 0) as totalTokens,
      COALESCE(SUM(total_cost), 0) as totalCost,
      COUNT(*) as callCount,
      COUNT(DISTINCT session_id) as sessions
    FROM usage_events
    WHERE ${productFilter} AND timestamp_ms >= ?
    GROUP BY bucket
    ORDER BY bucket ASC
  `).all(fromMs)

  const topModels = db.prepare(`
    SELECT
      model as label,
      COALESCE(SUM(total_tokens), 0) as tokens,
      COALESCE(SUM(total_cost), 0) as cost,
      COUNT(*) as calls,
      COUNT(DISTINCT session_id) as sessions
    FROM usage_events
    WHERE ${productFilter} AND timestamp_ms >= ?
    GROUP BY model
    ORDER BY cost DESC, tokens DESC
    LIMIT 8
  `).all(fromMs)

  const topProjects = db.prepare(`
    SELECT
      COALESCE(NULLIF(agent, ''), '未命名') as label,
      COALESCE(SUM(total_tokens), 0) as tokens,
      COALESCE(SUM(total_cost), 0) as cost,
      COUNT(*) as calls,
      COUNT(DISTINCT session_id) as sessions,
      MAX(timestamp_ms) as lastAt
    FROM usage_events
    WHERE ${productFilter} AND timestamp_ms >= ?
    GROUP BY COALESCE(NULLIF(agent, ''), '未命名')
    ORDER BY cost DESC, tokens DESC
    LIMIT 8
  `).all(fromMs)

  const topChannels = rawProduct === 'openclaw'
    ? db.prepare(`
        SELECT
          channel as label,
          COALESCE(SUM(total_tokens), 0) as tokens,
          COALESCE(SUM(total_cost), 0) as cost,
          COUNT(*) as calls,
          COUNT(DISTINCT session_id) as sessions,
          MAX(timestamp_ms) as lastAt
        FROM usage_events
        WHERE ${productFilter} AND timestamp_ms >= ?
        GROUP BY channel
        ORDER BY cost DESC, tokens DESC
        LIMIT 8
      `).all(fromMs)
    : []

  const topAgents = rawProduct === 'openclaw'
    ? db.prepare(`
        SELECT
          COALESCE(NULLIF(agent, ''), '未命名') as label,
          COALESCE(SUM(total_tokens), 0) as tokens,
          COALESCE(SUM(total_cost), 0) as cost,
          COUNT(*) as calls,
          COUNT(DISTINCT session_id) as sessions,
          MAX(timestamp_ms) as lastAt
        FROM usage_events
        WHERE ${productFilter} AND timestamp_ms >= ?
        GROUP BY COALESCE(NULLIF(agent, ''), '未命名')
        ORDER BY cost DESC, tokens DESC
        LIMIT 8
      `).all(fromMs)
    : []

  const topChannelAgents = rawProduct === 'openclaw'
    ? db.prepare(`
        SELECT
          channel,
          COALESCE(NULLIF(agent, ''), '未命名') as agent,
          COALESCE(SUM(total_tokens), 0) as tokens,
          COALESCE(SUM(total_cost), 0) as cost,
          COUNT(*) as calls,
          COUNT(DISTINCT session_id) as sessions
        FROM usage_events
        WHERE ${productFilter} AND timestamp_ms >= ?
        GROUP BY channel, COALESCE(NULLIF(agent, ''), '未命名')
        ORDER BY cost DESC, tokens DESC
        LIMIT 12
      `).all(fromMs)
    : []

  const topSessions = db.prepare(`
    SELECT
      session_id,
      MAX(channel) as channel,
      MAX(agent) as agent,
      MAX(session_key) as session_key,
      GROUP_CONCAT(DISTINCT model) as models,
      COALESCE(SUM(total_tokens), 0) as tokens,
      COALESCE(SUM(total_cost), 0) as cost,
      COUNT(*) as calls,
      MIN(timestamp_ms) as firstAt,
      MAX(timestamp_ms) as lastAt
    FROM usage_events
    WHERE ${productFilter} AND timestamp_ms >= ?
    GROUP BY session_id
    ORDER BY cost DESC, tokens DESC
    LIMIT 12
  `).all(fromMs)

  const peak = Array.isArray(trend) && trend.length > 0
    ? [...trend].sort((a, b) => (Number((b as Record<string, number>).totalCost) - Number((a as Record<string, number>).totalCost)))[0]
    : null

  res.json({
    product: rawProduct,
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
    botNicknames: loadBotNicknames(),
  })
})

// ─── Daily ───────────────────────────────────────────────────────────────────

router.get('/daily', (req: Request, res: Response) => {
  const days = parseInt(req.query.days as string) || 30
  const fromMs = daysAgoStart(days - 1)

  const rows = db.prepare(`
    SELECT
      date(timestamp_ms / 1000, 'unixepoch', 'localtime') as day,
      SUM(total_tokens) as tokens,
      SUM(input_tokens) as inputTokens,
      SUM(output_tokens) as outputTokens,
      SUM(cache_read_tokens) as cacheReadTokens,
      SUM(cache_write_tokens) as cacheWriteTokens,
      SUM(total_cost) as cost,
      SUM(input_cost) as inputCost,
      SUM(output_cost) as outputCost,
      COUNT(*) as calls,
      COUNT(DISTINCT session_id) as sessions
    FROM usage_events
    WHERE timestamp_ms >= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(fromMs)

  res.json(rows)
})

// ─── Models ──────────────────────────────────────────────────────────────────

router.get('/models', (_req: Request, res: Response) => {
  const rows = db.prepare(`
    SELECT model, provider,
      SUM(total_tokens) as totalTokens,
      SUM(input_tokens) as inputTokens,
      SUM(output_tokens) as outputTokens,
      SUM(cache_read_tokens) as cacheReadTokens,
      SUM(cache_write_tokens) as cacheWriteTokens,
      SUM(total_cost) as totalCost,
      COUNT(*) as callCount,
      COUNT(DISTINCT session_id) as sessionCount,
      MIN(timestamp_ms) as firstSeen,
      MAX(timestamp_ms) as lastSeen
    FROM usage_events
    GROUP BY model
    ORDER BY totalTokens DESC
  `).all()

  res.json(rows)
})

router.get('/models/:modelId', (req: Request, res: Response) => {
  const { modelId } = req.params
  const days = parseInt(req.query.days as string) || 30
  const fromMs = daysAgoStart(days - 1)

  const summary = db.prepare(`
    SELECT model, provider,
      SUM(total_tokens) as totalTokens,
      SUM(input_tokens) as inputTokens,
      SUM(output_tokens) as outputTokens,
      SUM(cache_read_tokens) as cacheReadTokens,
      SUM(cache_write_tokens) as cacheWriteTokens,
      SUM(total_cost) as totalCost,
      COUNT(*) as callCount,
      AVG(total_tokens) as avgTokensPerCall
    FROM usage_events
    WHERE model = ?
  `).get(modelId)

  const dailyTrend = db.prepare(`
    SELECT
      date(timestamp_ms / 1000, 'unixepoch', 'localtime') as day,
      SUM(total_tokens) as tokens,
      SUM(total_cost) as cost,
      COUNT(*) as calls
    FROM usage_events
    WHERE model = ? AND timestamp_ms >= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(modelId, fromMs)

  const channelMix = db.prepare(`
    SELECT channel, COUNT(*) as calls, SUM(total_tokens) as tokens
    FROM usage_events
    WHERE model = ?
    GROUP BY channel
    ORDER BY calls DESC
  `).all(modelId)

  res.json({ summary, dailyTrend, channelMix })
})

// ─── Channels ────────────────────────────────────────────────────────────────

router.get('/channels', (req: Request, res: Response) => {
  const period = req.query.period as string | undefined
  let fromMs = 0
  if (period === '1d') fromMs = hoursAgo(24)
  else if (period === '7d') fromMs = daysAgoStart(6)
  else if (period === '30d') fromMs = daysAgoStart(29)

  const timeFilter = fromMs > 0 ? ' AND timestamp_ms >= ?' : ''
  const params = fromMs > 0 ? [fromMs] : []

  const rows = db.prepare(`
    SELECT channel,
      COUNT(*) as messageCount,
      SUM(input_tokens) as inputTokens,
      SUM(output_tokens) as outputTokens,
      SUM(total_tokens) as totalTokens,
      SUM(total_cost) as totalCost,
      COUNT(*) as callCount,
      COUNT(DISTINCT session_id) as sessionCount,
      COUNT(DISTINCT model) as modelCount,
      MIN(timestamp_ms) as firstSeen,
      MAX(timestamp_ms) as lastSeen
    FROM usage_events
    WHERE channel NOT IN (${OPENCLAW_CHANNEL_FILTER}, 'unknown', 'cron')${timeFilter}
    GROUP BY channel
    ORDER BY totalTokens DESC
  `).all(...params)

  res.json(rows)
})

router.get('/channels/:channel', (req: Request, res: Response) => {
  const { channel } = req.params
  const days = parseInt(req.query.days as string) || 30
  const fromMs = daysAgoStart(days - 1)

  const summary = db.prepare(`
    SELECT channel,
      SUM(total_tokens) as totalTokens,
      SUM(total_cost) as totalCost,
      COUNT(*) as callCount,
      COUNT(DISTINCT session_id) as sessionCount
    FROM usage_events
    WHERE channel = ?
  `).get(channel)

  const dailyTrend = db.prepare(`
    SELECT
      date(timestamp_ms / 1000, 'unixepoch', 'localtime') as day,
      SUM(total_tokens) as tokens,
      SUM(total_cost) as cost,
      COUNT(*) as calls
    FROM usage_events
    WHERE channel = ? AND timestamp_ms >= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(channel, fromMs)

  const modelMix = db.prepare(`
    SELECT model, COUNT(*) as calls, SUM(total_tokens) as tokens
    FROM usage_events
    WHERE channel = ?
    GROUP BY model
    ORDER BY calls DESC
  `).all(channel)

  const topSessions = db.prepare(`
    SELECT session_id, model,
      SUM(total_tokens) as tokens, SUM(total_cost) as cost, COUNT(*) as calls
    FROM usage_events
    WHERE channel = ?
    GROUP BY session_id
    ORDER BY tokens DESC
    LIMIT 10
  `).all(channel)

  res.json({ summary, dailyTrend, modelMix, topSessions })
})

// ─── Sessions ────────────────────────────────────────────────────────────────

router.get('/sessions', (req: Request, res: Response) => {
  const { channel, model, from, to, sort = 'tokens', limit = '50', offset = '0', period, product } = req.query
  const conditions: string[] = []
  const params: Array<string | number | bigint | null> = []

  // Product filter
  if (product === 'openclaw') {
    conditions.push(`ue.channel NOT IN (${OPENCLAW_CHANNEL_FILTER}, 'unknown', 'cron')`)
  } else if (product === 'codex') {
    conditions.push("ue.channel = 'codex'")
  } else if (product === 'claude-code') {
    conditions.push("ue.channel = 'claude-code'")
  } else if (product === 'gemini-cli') {
    conditions.push("ue.channel = 'gemini-cli'")
  } else if (product === 'copilot-cli') {
    conditions.push("ue.channel = 'copilot-cli'")
  } else if (product === 'opencode') {
    conditions.push("ue.channel = 'opencode'")
  }

  if (period === '1d') { conditions.push('ue.timestamp_ms >= ?'); params.push(hoursAgo(24)) }
  else if (period === '7d') { conditions.push('ue.timestamp_ms >= ?'); params.push(daysAgoStart(6)) }
  else if (period === '30d') { conditions.push('ue.timestamp_ms >= ?'); params.push(daysAgoStart(29)) }

  if (channel) { conditions.push('ue.channel = ?'); params.push(channel as string) }
  if (model) { conditions.push('ue.model = ?'); params.push(model as string) }
  if (from) { conditions.push('ue.timestamp_ms >= ?'); params.push(dateToMs(from as string)) }
  if (to) { conditions.push('ue.timestamp_ms <= ?'); params.push(dateToMs(to as string)) }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  const orderCol = sort === 'cost' ? 'cost' : sort === 'calls' ? 'calls' : 'tokens'

  const rows = db.prepare(`
    SELECT ue.session_id, ue.channel, ue.agent,
      MAX(ue.session_key) as session_key,
      GROUP_CONCAT(DISTINCT ue.model) as models,
      SUM(ue.total_tokens) as tokens,
      SUM(ue.total_cost) as cost,
      COUNT(*) as calls,
      MIN(ue.timestamp_ms) as firstAt,
      MAX(ue.timestamp_ms) as lastAt
    FROM usage_events ue
    ${where}
    GROUP BY ue.session_id
    ORDER BY ${orderCol} DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit as string), parseInt(offset as string))

  const totalRow = db.prepare(`
    SELECT COUNT(DISTINCT ue.session_id) as total
    FROM usage_events ue
    ${where}
  `).get(...params) as { total: number }

  res.json({ sessions: rows, total: totalRow.total, botNicknames: loadBotNicknames() })
})

router.get('/sessions/:id', (req: Request, res: Response) => {
  const { id } = req.params

  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(id)

  const summary = db.prepare(`
    SELECT
      SUM(total_tokens) as totalTokens,
      SUM(input_tokens) as inputTokens,
      SUM(output_tokens) as outputTokens,
      SUM(cache_read_tokens) as cacheReadTokens,
      SUM(cache_write_tokens) as cacheWriteTokens,
      SUM(total_cost) as totalCost,
      COUNT(*) as callCount,
      MIN(timestamp_ms) as firstAt,
      MAX(timestamp_ms) as lastAt,
      channel, agent
    FROM usage_events
    WHERE session_id = ?
  `).get(id)

  const events = db.prepare(`
    SELECT id, timestamp_ms, model, provider, channel,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
      total_cost, stop_reason
    FROM usage_events
    WHERE session_id = ?
    ORDER BY timestamp_ms ASC
  `).all(id)

  const modelHistory = db.prepare(`
    SELECT model, MIN(timestamp_ms) as firstAt, COUNT(*) as calls
    FROM usage_events
    WHERE session_id = ?
    GROUP BY model
    ORDER BY firstAt ASC
  `).all(id)

  res.json({ session, summary, events, modelHistory })
})

// ─── Settings / Prices ───────────────────────────────────────────────────────

router.get('/settings/prices', (_req: Request, res: Response) => {
  const rows = db.prepare('SELECT * FROM model_prices ORDER BY provider, model_id').all()
  res.json(rows)
})

router.put('/settings/prices/:modelId', (req: Request, res: Response) => {
  const { modelId } = req.params
  const { inputPrice, outputPrice, cacheReadPrice, cacheWritePrice } = req.body

  db.prepare(`
    INSERT INTO model_prices (model_id, provider, input_price, output_price, cache_read_price, cache_write_price, per_tokens, source, updated_at)
    VALUES (?, 'custom', ?, ?, ?, ?, 1000000, 'manual', ?)
    ON CONFLICT(model_id) DO UPDATE SET
      input_price = excluded.input_price,
      output_price = excluded.output_price,
      cache_read_price = excluded.cache_read_price,
      cache_write_price = excluded.cache_write_price,
      source = 'manual',
      updated_at = excluded.updated_at
  `).run(modelId, inputPrice || 0, outputPrice || 0, cacheReadPrice || 0, cacheWritePrice || 0, Date.now())

  res.json({ ok: true })
})

// ─── Claude Code ─────────────────────────────────────────────────────────

router.get('/claude-code/summary', (_req: Request, res: Response) => {
  const todayMs = todayStart()
  const yesterdayMs = daysAgoStart(1)

  // Get config
  const configRows = db.prepare('SELECT key, value FROM claude_code_config').all() as Array<{ key: string; value: string }>
  const config: Record<string, string> = {}
  for (const r of configRows) config[r.key] = r.value

  const monthlyQuota = parseFloat(config.monthly_quota_usd || '100')
  const billingDay = parseInt(config.billing_cycle_day || '1')
  const planName = config.plan_name || 'Max 5x'

  // Calculate billing period start/end
  const now = new Date()
  let periodStart: Date
  let periodEnd: Date
  if (now.getDate() >= billingDay) {
    periodStart = new Date(now.getFullYear(), now.getMonth(), billingDay, 0, 0, 0, 0)
    periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, billingDay, 0, 0, 0, 0)
  } else {
    periodStart = new Date(now.getFullYear(), now.getMonth() - 1, billingDay, 0, 0, 0, 0)
    periodEnd = new Date(now.getFullYear(), now.getMonth(), billingDay, 0, 0, 0, 0)
  }
  const periodStartMs = periodStart.getTime()
  const periodEndMs = periodEnd.getTime()

  // Current period usage
  const periodRow = db.prepare(`
    SELECT
      COALESCE(SUM(total_tokens), 0) as totalTokens,
      COALESCE(SUM(input_tokens), 0) as inputTokens,
      COALESCE(SUM(output_tokens), 0) as outputTokens,
      COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens,
      COALESCE(SUM(cache_write_tokens), 0) as cacheWriteTokens,
      COALESCE(SUM(total_cost), 0) as totalCost,
      COUNT(*) as callCount,
      COUNT(DISTINCT session_id) as sessions
    FROM usage_events
    WHERE channel = 'claude-code' AND timestamp_ms >= ? AND timestamp_ms < ?
  `).get(periodStartMs, periodEndMs) as Record<string, number>

  // Today usage
  const todayRow = db.prepare(`
    SELECT
      COALESCE(SUM(total_tokens), 0) as totalTokens,
      COALESCE(SUM(total_cost), 0) as totalCost,
      COUNT(*) as callCount,
      COUNT(DISTINCT session_id) as sessions
    FROM usage_events
    WHERE channel = 'claude-code' AND timestamp_ms >= ?
  `).get(todayMs) as Record<string, number>

  // Yesterday usage (for trend)
  const yesterdayRow = db.prepare(`
    SELECT
      COALESCE(SUM(total_tokens), 0) as totalTokens,
      COALESCE(SUM(total_cost), 0) as totalCost,
      COUNT(*) as callCount
    FROM usage_events
    WHERE channel = 'claude-code' AND timestamp_ms >= ? AND timestamp_ms < ?
  `).get(yesterdayMs, todayMs) as Record<string, number>

  // This week usage
  const weekStartMs = daysAgoStart(new Date().getDay())
  const weekRow = db.prepare(`
    SELECT
      COALESCE(SUM(total_tokens), 0) as totalTokens,
      COALESCE(SUM(total_cost), 0) as totalCost,
      COUNT(*) as callCount,
      COUNT(DISTINCT session_id) as sessions
    FROM usage_events
    WHERE channel = 'claude-code' AND timestamp_ms >= ?
  `).get(weekStartMs) as Record<string, number>

  // Model distribution this period
  const modelDist = db.prepare(`
    SELECT model,
      SUM(total_tokens) as tokens,
      SUM(total_cost) as cost,
      COUNT(*) as calls
    FROM usage_events
    WHERE channel = 'claude-code' AND timestamp_ms >= ? AND timestamp_ms < ?
    GROUP BY model
    ORDER BY tokens DESC
  `).all(periodStartMs, periodEndMs)

  // Daily trend for current period
  const dailyTrend = db.prepare(`
    SELECT
      date(timestamp_ms / 1000, 'unixepoch', 'localtime') as day,
      SUM(total_tokens) as tokens,
      SUM(input_tokens) as inputTokens,
      SUM(output_tokens) as outputTokens,
      SUM(cache_read_tokens) as cacheReadTokens,
      SUM(cache_write_tokens) as cacheWriteTokens,
      SUM(total_cost) as cost,
      COUNT(*) as calls,
      COUNT(DISTINCT session_id) as sessions
    FROM usage_events
    WHERE channel = 'claude-code' AND timestamp_ms >= ? AND timestamp_ms < ?
    GROUP BY day
    ORDER BY day ASC
  `).all(periodStartMs, periodEndMs)

  // Top projects this period
  const topProjects = db.prepare(`
    SELECT agent as project,
      SUM(total_tokens) as tokens,
      SUM(total_cost) as cost,
      COUNT(*) as calls,
      COUNT(DISTINCT session_id) as sessions,
      MAX(timestamp_ms) as lastAt
    FROM usage_events
    WHERE channel = 'claude-code' AND timestamp_ms >= ? AND timestamp_ms < ?
    GROUP BY agent
    ORDER BY tokens DESC
    LIMIT 10
  `).all(periodStartMs, periodEndMs)

  res.json({
    config: { monthlyQuota, billingDay, planName },
    period: {
      startMs: periodStartMs,
      endMs: periodEndMs,
      daysLeft: Math.ceil((periodEndMs - Date.now()) / (1000 * 60 * 60 * 24)),
      daysTotal: Math.ceil((periodEndMs - periodStartMs) / (1000 * 60 * 60 * 24)),
    },
    periodUsage: periodRow,
    today: todayRow,
    yesterday: yesterdayRow,
    week: weekRow,
    modelDistribution: modelDist,
    dailyTrend,
    topProjects,
  })
})

router.get('/claude-code/config', (_req: Request, res: Response) => {
  const rows = db.prepare('SELECT key, value FROM claude_code_config').all() as Array<{ key: string; value: string }>
  const config: Record<string, string> = {}
  for (const r of rows) config[r.key] = r.value
  res.json(config)
})

router.put('/claude-code/config', (req: Request, res: Response) => {
  const updates = req.body as Record<string, string>
  const upsert = db.prepare('INSERT INTO claude_code_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  for (const [key, value] of Object.entries(updates)) {
    upsert.run(key, String(value))
  }
  res.json({ ok: true })
})

// ─── Claude Code: Usage (aggregated by day/week/month) ──────────────────────

router.get('/claude-code/usage', (req: Request, res: Response) => {
  const groupBy = (req.query.groupBy as string) || 'day'
  const days = parseInt(req.query.days as string) || 30
  const fromMs = daysAgoStart(days - 1)

  let dateExpr: string
  switch (groupBy) {
    case 'week':
      // ISO week: group by year + week number
      dateExpr = `strftime('%Y-W%W', timestamp_ms / 1000, 'unixepoch', 'localtime')`
      break
    case 'month':
      dateExpr = `strftime('%Y-%m', timestamp_ms / 1000, 'unixepoch', 'localtime')`
      break
    default: // day
      dateExpr = `date(timestamp_ms / 1000, 'unixepoch', 'localtime')`
  }

  const rows = db.prepare(`
    SELECT
      ${dateExpr} as period,
      SUM(total_tokens) as totalTokens,
      SUM(input_tokens) as inputTokens,
      SUM(output_tokens) as outputTokens,
      SUM(cache_read_tokens) as cacheReadTokens,
      SUM(cache_write_tokens) as cacheWriteTokens,
      SUM(total_cost) as totalCost,
      COUNT(*) as callCount,
      COUNT(DISTINCT session_id) as sessions,
      COUNT(DISTINCT model) as models
    FROM usage_events
    WHERE channel = 'claude-code' AND timestamp_ms >= ?
    GROUP BY period
    ORDER BY period ASC
  `).all(fromMs)

  // Also return totals for the range
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(total_tokens), 0) as totalTokens,
      COALESCE(SUM(input_tokens), 0) as inputTokens,
      COALESCE(SUM(output_tokens), 0) as outputTokens,
      COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens,
      COALESCE(SUM(cache_write_tokens), 0) as cacheWriteTokens,
      COALESCE(SUM(total_cost), 0) as totalCost,
      COUNT(*) as callCount,
      COUNT(DISTINCT session_id) as sessions
    FROM usage_events
    WHERE channel = 'claude-code' AND timestamp_ms >= ?
  `).get(fromMs) as Record<string, number>

  res.json({ groupBy, days, rows, totals })
})

// ─── Claude Code: Quota ─────────────────────────────────────────────────────

router.get('/claude-code/quota', (_req: Request, res: Response) => {
  // Load config
  const configRows = db.prepare('SELECT key, value FROM claude_code_config').all() as Array<{ key: string; value: string }>
  const config: Record<string, string> = {}
  for (const r of configRows) config[r.key] = r.value

  const monthlyQuota = parseFloat(config.monthly_quota_usd || '100')
  const billingDay = parseInt(config.billing_cycle_day || '1')
  const planName = config.plan_name || 'Max 5x'

  // Calculate billing period
  const now = new Date()
  let periodStart: Date
  let periodEnd: Date
  if (now.getDate() >= billingDay) {
    periodStart = new Date(now.getFullYear(), now.getMonth(), billingDay, 0, 0, 0, 0)
    periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, billingDay, 0, 0, 0, 0)
  } else {
    periodStart = new Date(now.getFullYear(), now.getMonth() - 1, billingDay, 0, 0, 0, 0)
    periodEnd = new Date(now.getFullYear(), now.getMonth(), billingDay, 0, 0, 0, 0)
  }
  const periodStartMs = periodStart.getTime()
  const periodEndMs = periodEnd.getTime()

  const daysTotal = Math.ceil((periodEndMs - periodStartMs) / (1000 * 60 * 60 * 24))
  const daysElapsed = Math.ceil((Date.now() - periodStartMs) / (1000 * 60 * 60 * 24))
  const daysLeft = Math.max(0, daysTotal - daysElapsed)

  // Current period cost
  const periodRow = db.prepare(`
    SELECT
      COALESCE(SUM(total_cost), 0) as totalCost,
      COALESCE(SUM(total_tokens), 0) as totalTokens,
      COUNT(*) as callCount,
      COUNT(DISTINCT session_id) as sessions
    FROM usage_events
    WHERE channel = 'claude-code' AND timestamp_ms >= ? AND timestamp_ms < ?
  `).get(periodStartMs, periodEndMs) as Record<string, number>

  const used = periodRow.totalCost
  const remaining = Math.max(0, monthlyQuota - used)
  const usagePercent = monthlyQuota > 0 ? (used / monthlyQuota) * 100 : 0
  const dailyBudget = daysLeft > 0 ? remaining / daysLeft : 0

  // Today's spend
  const todayCost = (db.prepare(`
    SELECT COALESCE(SUM(total_cost), 0) as cost
    FROM usage_events
    WHERE channel = 'claude-code' AND timestamp_ms >= ?
  `).get(todayStart()) as { cost: number }).cost

  res.json({
    plan: planName,
    monthlyQuota,
    billingDay,
    period: {
      start: periodStart.toISOString(),
      end: periodEnd.toISOString(),
      daysTotal,
      daysElapsed,
      daysLeft,
    },
    usage: {
      used,
      remaining,
      usagePercent: Math.round(usagePercent * 100) / 100,
      dailyBudget: Math.round(dailyBudget * 100) / 100,
      todayCost: Math.round(todayCost * 10000) / 10000,
    },
    stats: {
      totalTokens: periodRow.totalTokens,
      callCount: periodRow.callCount,
      sessions: periodRow.sessions,
    },
  })
})

// ─── Claude Code: Sessions ──────────────────────────────────────────────────

router.get('/claude-code/sessions', (req: Request, res: Response) => {
  const { from, to, project, model, sort = 'lastAt', limit = '50', offset = '0' } = req.query
  const conditions: string[] = ["ue.channel = 'claude-code'"]
  const params: Array<string | number | bigint | null> = []

  if (project) { conditions.push('ue.agent = ?'); params.push(project as string) }
  if (model) { conditions.push('ue.model = ?'); params.push(model as string) }
  if (from) { conditions.push('ue.timestamp_ms >= ?'); params.push(dateToMs(from as string)) }
  if (to) { conditions.push('ue.timestamp_ms <= ?'); params.push(dateToMs(to as string)) }

  const where = 'WHERE ' + conditions.join(' AND ')
  const orderCol = sort === 'cost' ? 'cost' : sort === 'calls' ? 'calls' : sort === 'tokens' ? 'tokens' : 'lastAt'

  const rows = db.prepare(`
    SELECT ue.session_id as sessionId,
      ue.agent as project,
      GROUP_CONCAT(DISTINCT ue.model) as models,
      SUM(ue.total_tokens) as tokens,
      SUM(ue.input_tokens) as inputTokens,
      SUM(ue.output_tokens) as outputTokens,
      SUM(ue.cache_read_tokens) as cacheReadTokens,
      SUM(ue.cache_write_tokens) as cacheWriteTokens,
      SUM(ue.total_cost) as cost,
      COUNT(*) as calls,
      MIN(ue.timestamp_ms) as firstAt,
      MAX(ue.timestamp_ms) as lastAt
    FROM usage_events ue
    ${where}
    GROUP BY ue.session_id
    ORDER BY ${orderCol} DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit as string), parseInt(offset as string))

  const totalRow = db.prepare(`
    SELECT COUNT(DISTINCT ue.session_id) as total
    FROM usage_events ue
    ${where}
  `).get(...params) as { total: number }

  res.json({ sessions: rows, total: totalRow.total })
})

// ─── Health ──────────────────────────────────────────────────────────────────

router.get('/health', (_req: Request, res: Response) => {
  const states = db.prepare('SELECT * FROM ingestion_state ORDER BY last_scan_at DESC').all()
  const warnings = db.prepare('SELECT * FROM source_warnings ORDER BY created_at DESC LIMIT 100').all()
  const totalEvents = (db.prepare('SELECT COUNT(*) as c FROM usage_events').get() as { c: number }).c
  const totalSessions = (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c

  const lastScan = states.length
    ? Math.max(...(states as Array<{ last_scan_at: number }>).map((s) => s.last_scan_at))
    : null

  res.json({ states, warnings, totalEvents, totalSessions, lastScanAt: lastScan })
})

// ─── Ingest ──────────────────────────────────────────────────────────────────

router.post('/ingest', async (_req: Request, res: Response) => {
  try {
    const stats = await runIngestion(false)
    res.json({ ok: true, stats })
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) })
  }
})

router.post('/ingest/full', async (_req: Request, res: Response) => {
  try {
    const stats = await runIngestion(true)
    res.json({ ok: true, stats })
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) })
  }
})

// ─── Export ─────────────────────────────────────────────────────────────────

router.get('/export/count', (req: Request, res: Response) => {
  const { startDate, endDate, models, channels } = req.query
  const conditions: string[] = []
  const params: Array<string | number | null> = []

  if (startDate) {
    conditions.push('timestamp_ms >= ?')
    params.push(dateToMs(startDate as string))
  }
  if (endDate) {
    conditions.push('timestamp_ms <= ?')
    params.push(dateToMs(endDate as string) + 86400000 - 1) // end of day
  }
  if (models) {
    const modelList = (models as string).split(',').map((m) => m.trim())
    conditions.push(`model IN (${modelList.map(() => '?').join(',')})`)
    params.push(...modelList)
  }
  if (channels) {
    const channelList = (channels as string).split(',').map((c) => c.trim())
    conditions.push(`channel IN (${channelList.map(() => '?').join(',')})`)
    params.push(...channelList)
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  const row = db.prepare(`SELECT COUNT(*) as count FROM usage_events ${where}`).get(...params) as { count: number }
  res.json({ count: row.count })
})

router.get('/export', (req: Request, res: Response) => {
  const { startDate, endDate, models, channels } = req.query
  const conditions: string[] = []
  const params: Array<string | number | null> = []

  if (startDate) {
    conditions.push('timestamp_ms >= ?')
    params.push(dateToMs(startDate as string))
  }
  if (endDate) {
    conditions.push('timestamp_ms <= ?')
    params.push(dateToMs(endDate as string) + 86400000 - 1)
  }
  if (models) {
    const modelList = (models as string).split(',').map((m) => m.trim())
    conditions.push(`model IN (${modelList.map(() => '?').join(',')})`)
    params.push(...modelList)
  }
  if (channels) {
    const channelList = (channels as string).split(',').map((c) => c.trim())
    conditions.push(`channel IN (${channelList.map(() => '?').join(',')})`)
    params.push(...channelList)
  }

  const where = conditions.join(' AND ')
  const BATCH = 10000
  const dateStr = new Date().toISOString().slice(0, 10)

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="tokend-export-${dateStr}.csv"`)

  // UTF-8 BOM
  res.write('\uFEFF')

  // Header row
  res.write('时间,模型,Channel,输入Token,输出Token,合计Token,成本（美元）\n')

  let offset = 0
  let hasMore = true

  const writeBatch = () => {
    const rows = db.prepare(`
      SELECT timestamp_ms, model, channel,
        input_tokens, output_tokens, total_tokens, total_cost
      FROM usage_events
      ${where ? 'WHERE ' + where : ''}
      ORDER BY timestamp_ms ASC
      LIMIT ${BATCH} OFFSET ${offset}
    `).all(...params)

    if (!rows.length) {
      hasMore = false
      res.end()
      return
    }

    for (const row of rows as Array<Record<string, unknown>>) {
      const ts = new Date(row.timestamp_ms as number)
      const timeStr = ts.toISOString().replace('T', ' ').slice(0, 19)
      const line = [
        timeStr,
        (row.model as string) || '',
        (row.channel as string) || '',
        String(row.input_tokens ?? 0),
        String(row.output_tokens ?? 0),
        String(row.total_tokens ?? 0),
        (row.total_cost as number)?.toFixed(6) ?? '0.000000',
      ].join(',')
      res.write(line + '\n')
    }

    offset += BATCH

    // Check if there are more rows
    const countRow = db.prepare(`SELECT COUNT(*) as c FROM usage_events ${where ? 'WHERE ' + where : ''}`).get(...params) as { c: number }
    hasMore = offset < countRow.c

    if (hasMore) {
      // Continue asynchronously
      setImmediate(writeBatch)
    } else {
      res.end()
    }
  }

  // Check total count first
  const countRow = db.prepare(`SELECT COUNT(*) as c FROM usage_events ${where ? 'WHERE ' + where : ''}`).get(...params) as { c: number }
  if (countRow.c === 0) {
    res.end()
    return
  }

  writeBatch()
})

export default router
