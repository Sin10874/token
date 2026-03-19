import db from '../db/index.js'
import { discoverSessionFiles } from './scanner.js'
import { parseSessionFile } from './parser.js'

interface IngestionStats {
  filesProcessed: number
  eventsInserted: number
  sessionsUpdated: number
  warnings: string[]
  duration: number
}

const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO usage_events (
    id, timestamp_ms, session_id, session_key, agent, provider, model, channel,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
    input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost,
    source_path, stop_reason
  ) VALUES (
    @id, @timestampMs, @sessionId, @sessionKey, @agent, @provider, @model, @channel,
    @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens, @totalTokens,
    @inputCost, @outputCost, @cacheReadCost, @cacheWriteCost, @totalCost,
    @sourcePath, @stopReason
  )
`)

const upsertSession = db.prepare(`
  INSERT INTO sessions (session_id, session_key, agent, channel, first_seen_at, last_seen_at, current_model, call_count, total_tokens, total_cost, source_path)
  VALUES (@sessionId, @sessionKey, @agent, @channel, @firstSeenAt, @lastSeenAt, @currentModel, @callCount, @totalTokens, @totalCost, @sourcePath)
  ON CONFLICT(session_id) DO UPDATE SET
    channel = COALESCE(excluded.channel, sessions.channel),
    last_seen_at = MAX(excluded.last_seen_at, sessions.last_seen_at),
    first_seen_at = MIN(excluded.first_seen_at, sessions.first_seen_at),
    current_model = COALESCE(excluded.current_model, sessions.current_model),
    call_count = sessions.call_count + excluded.call_count,
    total_tokens = sessions.total_tokens + excluded.total_tokens,
    total_cost = sessions.total_cost + excluded.total_cost
`)

const upsertState = db.prepare(`
  INSERT INTO ingestion_state (source_path, last_processed_lines, last_scan_at, event_count)
  VALUES (@sourcePath, @lines, @scanAt, @eventCount)
  ON CONFLICT(source_path) DO UPDATE SET
    last_processed_lines = excluded.last_processed_lines,
    last_scan_at = excluded.last_scan_at,
    event_count = excluded.event_count
`)

const getState = db.prepare('SELECT * FROM ingestion_state WHERE source_path = ?')

const insertWarning = db.prepare(`
  INSERT INTO source_warnings (source_path, warning, created_at)
  VALUES (?, ?, ?)
`)

const clearWarnings = db.prepare('DELETE FROM source_warnings WHERE source_path = ?')

export async function runIngestion(forceReindex = false): Promise<IngestionStats> {
  const start = Date.now()
  const stats: IngestionStats = {
    filesProcessed: 0,
    eventsInserted: 0,
    sessionsUpdated: 0,
    warnings: [],
    duration: 0,
  }

  const files = await discoverSessionFiles()

  for (const fileInfo of files) {
    const { sessionId, agent, filePath, sessionKey, channel } = fileInfo
    const state = getState.get(filePath) as { last_processed_lines: number } | undefined
    const startLine = forceReindex ? 0 : state?.last_processed_lines || 0

    const result = parseSessionFile(filePath, sessionId, sessionKey, agent, channel || 'unknown', startLine)

    if (result.events.length === 0 && result.warnings.length === 0 && !forceReindex && startLine > 0) {
      // No new content
      continue
    }

    // Insert events in a transaction
    let inserted = 0
    db.exec('BEGIN')
    try {
      for (const event of result.events) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const info = insertEvent.run(event as any) as { changes: number }
        inserted += info.changes
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    stats.eventsInserted += inserted
    stats.filesProcessed++

    // Upsert session
    if (result.events.length > 0) {
      const totalTokens = result.events.reduce((s, e) => s + e.totalTokens, 0)
      const totalCost = result.events.reduce((s, e) => s + e.totalCost, 0)
      upsertSession.run({
        sessionId,
        sessionKey: sessionKey || null,
        agent,
        channel: channel || 'unknown',
        firstSeenAt: result.firstSeenAt || Date.now(),
        lastSeenAt: result.lastSeenAt || Date.now(),
        currentModel: result.currentModel || null,
        callCount: result.events.length,
        totalTokens,
        totalCost,
        sourcePath: filePath,
      })
      stats.sessionsUpdated++
    }

    // Update warnings
    clearWarnings.run(filePath)
    for (const w of result.warnings) {
      insertWarning.run(filePath, w, Date.now())
      stats.warnings.push(`${filePath}: ${w}`)
    }

    // Update ingestion state
    upsertState.run({
      sourcePath: filePath,
      lines: result.linesRead,
      scanAt: Date.now(),
      eventCount: result.events.length,
    })
  }

  stats.duration = Date.now() - start
  return stats
}

// CLI entrypoint
if (require.main === module) {
  runIngestion(true).then((stats) => {
    console.log('Ingestion complete:', stats)
    process.exit(0)
  })
}
