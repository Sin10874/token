import db from '../db/index.js'
import { discoverSessionFiles } from './scanner.js'
import { parseSessionFile } from './parser.js'
import { discoverClaudeCodeFiles } from './claude-code-scanner.js'
import { parseClaudeCodeFile } from './claude-code-parser.js'
import { discoverCodexFiles } from './codex-scanner.js'
import { parseCodexFile } from './codex-parser.js'
import { discoverGeminiCliFiles } from './gemini-cli-scanner.js'
import { parseGeminiCliFile } from './gemini-cli-parser.js'
import { discoverCopilotCliFiles } from './copilot-cli-scanner.js'
import { parseCopilotCliFile } from './copilot-cli-parser.js'
import { discoverOpencodeFiles } from './opencode-scanner.js'
import { parseOpencodeFile } from './opencode-parser.js'
import { rebuildSessionsFromUsage, upsertSessionSnapshot } from './session-upsert.js'
import {
  buildModelPriceResolver,
  priceUsageEvent,
  type FlatModelPriceRow,
  type VersionedModelPriceRow,
} from '../pricing/model-pricing.js'

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

  // Preload model prices for cost calculation
  const priceRows = db.prepare('SELECT * FROM model_prices').all() as unknown as FlatModelPriceRow[]
  const versionRows = db.prepare('SELECT * FROM model_price_versions').all() as unknown as VersionedModelPriceRow[]
  const resolvePrice = buildModelPriceResolver(priceRows, versionRows)

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

    // Preserve reported cost; otherwise use event-time catalog, then legacy fallback.
    for (const event of result.events) {
      priceUsageEvent(event, resolvePrice)
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

    if (result.events.length > 0) {
      if (upsertSessionSnapshot(db, {
        sessionId,
        sessionKey: sessionKey || null,
        agent,
        channel: channel || 'unknown',
        currentModel: result.currentModel || null,
        sourcePath: filePath,
      })) {
        stats.sessionsUpdated++
      }
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

  // ─── Claude Code ingestion ───────────────────────────────────────────────
  const ccFiles = await discoverClaudeCodeFiles()

  for (const fileInfo of ccFiles) {
    const { sessionId, project, filePath } = fileInfo
    const state = getState.get(filePath) as { last_processed_lines: number } | undefined
    const startLine = forceReindex ? 0 : state?.last_processed_lines || 0

    const result = parseClaudeCodeFile(filePath, sessionId, project, startLine)

    if (result.events.length === 0 && result.warnings.length === 0 && !forceReindex && startLine > 0) {
      continue
    }

    // Use the same event-time resolver as server-triggered OpenClaw ingestion.
    for (const event of result.events) {
      priceUsageEvent(event, resolvePrice)
    }

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

    if (result.events.length > 0) {
      if (upsertSessionSnapshot(db, {
        sessionId,
        sessionKey: null,
        agent: result.projectName || project,
        channel: 'claude-code',
        currentModel: result.currentModel || null,
        sourcePath: filePath,
      })) {
        stats.sessionsUpdated++
      }
    }

    clearWarnings.run(filePath)
    for (const w of result.warnings) {
      insertWarning.run(filePath, w, Date.now())
      stats.warnings.push(`${filePath}: ${w}`)
    }

    upsertState.run({
      sourcePath: filePath,
      lines: result.linesRead,
      scanAt: Date.now(),
      eventCount: result.events.length,
    })
  }

  // ─── Codex ingestion (CLI + App) ─────────────────────────────────────────
  const codexFiles = await discoverCodexFiles()

  for (const fileInfo of codexFiles) {
    const { sessionId, filePath } = fileInfo
    const state = getState.get(filePath) as { last_processed_lines: number } | undefined
    const startLine = forceReindex ? 0 : state?.last_processed_lines || 0

    const result = parseCodexFile(filePath, sessionId, fileInfo.title, fileInfo.cwd, startLine)

    if (result.events.length === 0 && result.warnings.length === 0 && !forceReindex && startLine > 0) {
      continue
    }

    // Use the same event-time resolver as the CLI entrypoint.
    for (const event of result.events) {
      priceUsageEvent(event, resolvePrice)
    }

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

    if (result.events.length > 0) {
      if (upsertSessionSnapshot(db, {
        sessionId,
        sessionKey: null,
        agent: result.projectName || '~',
        channel: 'codex',
        currentModel: result.currentModel || null,
        sourcePath: filePath,
      })) {
        stats.sessionsUpdated++
      }
    }

    clearWarnings.run(filePath)
    for (const w of result.warnings) {
      insertWarning.run(filePath, w, Date.now())
      stats.warnings.push(`${filePath}: ${w}`)
    }

    upsertState.run({
      sourcePath: filePath,
      lines: result.linesRead,
      scanAt: Date.now(),
      eventCount: result.events.length,
    })
  }

  // ─── Gemini CLI ingestion ────────────────────────────────────────────────
  const geminiFiles = await discoverGeminiCliFiles()

  for (const fileInfo of geminiFiles) {
    const result = parseGeminiCliFile(fileInfo.filePath, fileInfo.sessionId)
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

    if (result.events.length > 0) {
      if (upsertSessionSnapshot(db, {
        sessionId: fileInfo.sessionId,
        sessionKey: null,
        agent: 'unknown',
        channel: 'gemini-cli',
        currentModel: result.currentModel || null,
        sourcePath: fileInfo.filePath,
      })) {
        stats.sessionsUpdated++
      }
    }
  }

  // ─── Copilot CLI ingestion ───────────────────────────────────────────────
  const copilotFiles = await discoverCopilotCliFiles()

  for (const fileInfo of copilotFiles) {
    const result = parseCopilotCliFile(fileInfo.filePath, fileInfo.sessionId)
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

    if (result.events.length > 0) {
      if (upsertSessionSnapshot(db, {
        sessionId: fileInfo.sessionId,
        sessionKey: null,
        agent: result.projectName || 'unknown',
        channel: 'copilot-cli',
        currentModel: result.currentModel || null,
        sourcePath: fileInfo.filePath,
      })) {
        stats.sessionsUpdated++
      }
    }
  }

  // ─── OpenCode ingestion ──────────────────────────────────────────────────
  const opencodeFiles = await discoverOpencodeFiles()

  for (const fileInfo of opencodeFiles) {
    const result = parseOpencodeFile(fileInfo)
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

    const sessionIds = new Set(result.events.map((event) => event.sessionId))
    for (const sessionId of sessionIds) {
      if (upsertSessionSnapshot(db, {
        sessionId,
        sessionKey: null,
        agent: result.projectName || 'unknown',
        channel: 'opencode',
        currentModel: result.currentModel || null,
        sourcePath: fileInfo.filePath,
      })) {
        stats.sessionsUpdated++
      }
    }
  }

  if (forceReindex) {
    stats.sessionsUpdated = rebuildSessionsFromUsage(db)
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
