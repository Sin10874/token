import type { QueryDatabase } from './dashboard-metrics.js'

export function getModelsList(db: QueryDatabase, period?: string) {
  let fromMs = 0
  if (period === '1d') fromMs = Date.now() - 24 * 3600_000
  else if (period === '7d') fromMs = Date.now() - 7 * 24 * 3600_000
  else if (period === '30d') fromMs = Date.now() - 30 * 24 * 3600_000

  const timeFilter = fromMs > 0 ? 'WHERE timestamp_ms >= ?' : ''
  const params = fromMs > 0 ? [fromMs] : []
  return db.prepare(`
    SELECT
      model,
      MAX(provider) AS provider,
      COALESCE(SUM(total_tokens), 0) AS totalTokens,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
      COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
      COALESCE(SUM(total_cost), 0) AS totalCost,
      COUNT(*) AS callCount,
      COUNT(DISTINCT session_id) AS sessionCount,
      MIN(timestamp_ms) AS firstSeen,
      MAX(timestamp_ms) AS lastSeen
    FROM usage_events
    ${timeFilter}
    GROUP BY model
    ORDER BY totalTokens DESC, model ASC
  `).all(...params) as Array<Record<string, number | string>>
}
