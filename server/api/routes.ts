import { Router, Request, Response } from 'express'
import db from '../db/index.js'
import { runIngestion } from '../ingestion/index.js'

const router = Router()

// ─── Helpers ─────────────────────────────────────────────────────────────────

function dateToMs(dateStr: string): number {
  return new Date(dateStr).getTime()
}

function todayStart(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function daysAgoStart(n: number): number {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// ─── Summary / Dashboard ─────────────────────────────────────────────────────

router.get('/summary', (_req: Request, res: Response) => {
  const todayMs = todayStart()
  const yesterdayMs = daysAgoStart(1)

  const todayRow = db.prepare(`
    SELECT
      COALESCE(SUM(total_tokens), 0) as totalTokens,
      COALESCE(SUM(total_cost), 0) as totalCost,
      COUNT(DISTINCT session_id) as sessions,
      COUNT(DISTINCT channel) as channels,
      COUNT(*) as callCount
    FROM usage_events
    WHERE timestamp_ms >= ?
  `).get(todayMs) as Record<string, number>

  const yesterdayRow = db.prepare(`
    SELECT
      COALESCE(SUM(total_tokens), 0) as totalTokens,
      COALESCE(SUM(total_cost), 0) as totalCost,
      COUNT(*) as callCount
    FROM usage_events
    WHERE timestamp_ms >= ? AND timestamp_ms < ?
  `).get(yesterdayMs, todayMs) as Record<string, number>

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
  `).all(todayMs)

  const channelDist = db.prepare(`
    SELECT channel,
      SUM(total_tokens) as tokens,
      SUM(total_cost) as cost,
      COUNT(DISTINCT session_id) as sessions
    FROM usage_events
    WHERE timestamp_ms >= ?
    GROUP BY channel
    ORDER BY tokens DESC
  `).all(todayMs)

  const topSessions = db.prepare(`
    SELECT session_id, channel, model, agent,
      SUM(total_tokens) as tokens,
      SUM(total_cost) as cost,
      COUNT(*) as calls,
      MIN(timestamp_ms) as firstAt,
      MAX(timestamp_ms) as lastAt
    FROM usage_events
    WHERE timestamp_ms >= ?
    GROUP BY session_id
    ORDER BY tokens DESC
    LIMIT 8
  `).all(todayMs)

  // Last 7 days trend
  const trend7 = db.prepare(`
    SELECT
      date(timestamp_ms / 1000, 'unixepoch', 'localtime') as day,
      SUM(total_tokens) as tokens,
      SUM(total_cost) as cost
    FROM usage_events
    WHERE timestamp_ms >= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(daysAgoStart(6))

  // Product breakdown: OpenClaw vs Claude Code
  const ccToday = db.prepare(`
    SELECT
      COALESCE(SUM(total_tokens), 0) as totalTokens,
      COALESCE(SUM(total_cost), 0) as totalCost,
      COUNT(*) as callCount,
      COUNT(DISTINCT session_id) as sessions
    FROM usage_events
    WHERE timestamp_ms >= ? AND channel = 'claude-code'
  `).get(todayMs) as Record<string, number>

  const ocToday = db.prepare(`
    SELECT
      COALESCE(SUM(total_tokens), 0) as totalTokens,
      COALESCE(SUM(total_cost), 0) as totalCost,
      COUNT(*) as callCount,
      COUNT(DISTINCT session_id) as sessions
    FROM usage_events
    WHERE timestamp_ms >= ? AND channel != 'claude-code'
  `).get(todayMs) as Record<string, number>

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
    WHERE timestamp_ms >= ? AND channel != 'claude-code'
  `).get(daysAgoStart(6)) as Record<string, number>

  res.json({
    today: todayRow,
    yesterday: yesterdayRow,
    modelDistribution: modelDist,
    channelDistribution: channelDist,
    topSessions,
    trend7,
    productBreakdown: {
      claudeCode: { today: ccToday, cost7d: cc7d.cost, tokens7d: cc7d.tokens },
      openClaw: { today: ocToday, cost7d: oc7d.cost, tokens7d: oc7d.tokens },
    },
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

router.get('/channels', (_req: Request, res: Response) => {
  const rows = db.prepare(`
    SELECT channel,
      SUM(total_tokens) as totalTokens,
      SUM(total_cost) as totalCost,
      COUNT(*) as callCount,
      COUNT(DISTINCT session_id) as sessionCount,
      COUNT(DISTINCT model) as modelCount,
      MIN(timestamp_ms) as firstSeen,
      MAX(timestamp_ms) as lastSeen
    FROM usage_events
    WHERE channel != 'claude-code'
    GROUP BY channel
    ORDER BY totalTokens DESC
  `).all()

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
  const { channel, model, from, to, sort = 'tokens', limit = '50', offset = '0' } = req.query
  const conditions: string[] = ["ue.channel != 'claude-code'"]
  const params: Array<string | number | bigint | null> = []

  if (channel) { conditions.push('ue.channel = ?'); params.push(channel as string) }
  if (model) { conditions.push('ue.model = ?'); params.push(model as string) }
  if (from) { conditions.push('ue.timestamp_ms >= ?'); params.push(dateToMs(from as string)) }
  if (to) { conditions.push('ue.timestamp_ms <= ?'); params.push(dateToMs(to as string)) }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  const orderCol = sort === 'cost' ? 'cost' : sort === 'calls' ? 'calls' : 'tokens'

  const rows = db.prepare(`
    SELECT ue.session_id, ue.channel, ue.agent,
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

  res.json({ sessions: rows, total: totalRow.total })
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

export default router
