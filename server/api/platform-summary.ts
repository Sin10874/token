import type { QueryDatabase } from './dashboard-metrics.js'

export type PlatformProduct = 'claude-code' | 'codex' | 'openclaw' | 'hermes'
export type PlatformPeriod = '1d' | '7d' | '30d'

const TOOL_CHANNELS = [
  'claude-code', 'codex', 'gemini-cli', 'copilot-cli', 'opencode',
  'kimi-code', 'qwen-code', 'hermes', 'unknown',
]

export function getPlatformPeriodBounds(period?: string) {
  const now = Date.now()
  const selected: PlatformPeriod = period === '30d' ? '30d' : period === '7d' ? '7d' : '1d'
  const duration = selected === '30d' ? 30 * 24 * 3600_000 : selected === '7d' ? 7 * 24 * 3600_000 : 24 * 3600_000
  const fromMs = now - duration
  return {
    period: selected,
    fromMs,
    prevFromMs: fromMs - duration,
    prevToMs: fromMs,
    bucket: selected === '1d' ? 'hour' as const : 'day' as const,
  }
}

export function getPlatformFilter(product: PlatformProduct, alias = ''): string {
  const prefix = alias ? `${alias}.` : ''
  if (product === 'openclaw') {
    const channels = TOOL_CHANNELS.map((channel) => `'${channel}'`).join(', ')
    return `${prefix}channel NOT IN (${channels}) AND NOT (${prefix}channel = 'cron' AND COALESCE(${prefix}session_key, '') = '')`
  }
  return `${prefix}channel = '${product}'`
}

function hasMessageEvents(db: QueryDatabase): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_events'").get())
}

export function getPlatformMetrics(
  db: QueryDatabase,
  product: PlatformProduct,
  fromMs: number,
  toMs?: number,
) {
  const filter = getPlatformFilter(product)
  const toFilter = toMs == null ? '' : ' AND timestamp_ms < ?'
  const params = toMs == null ? [fromMs] : [fromMs, toMs]
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens + output_tokens), 0) AS totalTokens,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
      COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
      COALESCE(SUM(input_cost + output_cost + cache_read_cost), 0) AS totalCost,
      COUNT(*) AS callCount,
      COUNT(DISTINCT session_id) AS sessions,
      COUNT(DISTINCT CASE WHEN agent != '' THEN agent END) AS projectCount,
      COUNT(DISTINCT CASE WHEN channel != '' THEN channel END) AS channelCount,
      COUNT(*) AS fallbackMessageCount,
      COUNT(CASE WHEN stop_reason = 'end_turn' THEN 1 END) AS fallbackUserMessageCount
    FROM usage_events
    WHERE ${filter} AND timestamp_ms >= ?${toFilter}
  `).get(...params) as Record<string, number>

  if (hasMessageEvents(db)) {
    const message = db.prepare(`
      SELECT
        COUNT(*) AS messageCount,
        COUNT(CASE WHEN kind = 'user' THEN 1 END) AS userMessageCount
      FROM message_events
      WHERE ${filter} AND timestamp_ms >= ?${toFilter}
    `).get(...params) as Record<string, number>
    row.messageCount = message.messageCount
    row.userMessageCount = message.userMessageCount
  } else {
    row.messageCount = row.fallbackMessageCount
    row.userMessageCount = row.fallbackUserMessageCount
  }
  delete row.fallbackMessageCount
  delete row.fallbackUserMessageCount
  return row
}

export function getPlatformsSummary(db: QueryDatabase, requestedPeriod?: string) {
  const { period, fromMs, prevFromMs, prevToMs } = getPlatformPeriodBounds(requestedPeriod)
  const products: PlatformProduct[] = ['claude-code', 'codex', 'openclaw', 'hermes']
  const items = products.map((product) => ({
    product,
    current: getPlatformMetrics(db, product, fromMs),
    previous: getPlatformMetrics(db, product, prevFromMs, prevToMs),
  })).sort((a, b) => b.current.totalCost - a.current.totalCost)
  return { period, items }
}
