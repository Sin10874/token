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
  prepareIngestionStateStatements,
  resolveStartLine,
  type IngestionState,
} from './ingestion-state.js'
import { createLocalPriceResolver, type LocalModelPriceRow } from './local-price-resolver.js'
import { PARSER_VERSIONS } from './parser-versions.js'

export { resolveStartLine }

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
    input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
    input_cost, output_cost, reasoning_cost, cache_read_cost, cache_write_cost, total_cost,
    source_path, stop_reason
  ) VALUES (
    @id, @timestampMs, @sessionId, @sessionKey, @agent, @provider, @model, @channel,
    @inputTokens, @outputTokens, @reasoningTokens, @cacheReadTokens, @cacheWriteTokens, @totalTokens,
    @inputCost, @outputCost, @reasoningCost, @cacheReadCost, @cacheWriteCost, @totalCost,
    @sourcePath, @stopReason
  )
`)

const { getState, upsertState } = prepareIngestionStateStatements(db)

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
  const priceRows = db.prepare('SELECT * FROM model_prices').all() as unknown as LocalModelPriceRow[]
  const findPrice = createLocalPriceResolver(priceRows)

  // 日志自带成本时优先用日志值，否则按价格表补算
  function applyCostsFromPrices(events: Array<{
    model: string; totalCost: number; totalTokens: number
    inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number
    inputCost: number; outputCost: number; cacheReadCost: number; cacheWriteCost: number
  }>) {
    for (const event of events) {
      if (event.totalCost !== 0 || event.totalTokens <= 0) continue
      const price = findPrice(event.model)
      if (!price) continue
      const perTokens = price.per_tokens || 1000000
      event.inputCost = (event.inputTokens * price.input_price) / perTokens
      event.outputCost = (event.outputTokens * price.output_price) / perTokens
      event.cacheReadCost = (event.cacheReadTokens * price.cache_read_price) / perTokens
      event.cacheWriteCost = (event.cacheWriteTokens * price.cache_write_price) / perTokens
      event.totalCost = event.inputCost + event.outputCost + event.cacheReadCost + event.cacheWriteCost
    }
  }

  const files = await discoverSessionFiles()

  for (const fileInfo of files) {
    const { sessionId, agent, filePath, sessionKey, channel } = fileInfo
    const parserVersion = PARSER_VERSIONS.openclaw
    const state = getState.get(filePath) as IngestionState | undefined
    const startLine = resolveStartLine(forceReindex, state, parserVersion)

    const result = parseSessionFile(filePath, sessionId, sessionKey, agent, channel || 'unknown', startLine)

    if (result.events.length === 0 && result.warnings.length === 0 && !forceReindex && startLine > 0) {
      // No new content
      continue
    }

    // Calculate costs from model_prices if event has zero cost
    for (const event of result.events) {
      if (event.totalCost === 0 && event.totalTokens > 0) {
        const price = findPrice(event.model)
        if (price) {
          const perTokens = price.per_tokens || 1000000
          event.inputCost = (event.inputTokens * price.input_price) / perTokens
          event.outputCost = (event.outputTokens * price.output_price) / perTokens
          event.cacheReadCost = (event.cacheReadTokens * price.cache_read_price) / perTokens
          event.cacheWriteCost = 0
          event.totalCost = event.inputCost + event.outputCost + event.cacheReadCost
        }
      }
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
      parserVersion,
    })
  }

  // ─── Claude Code ingestion ───────────────────────────────────────────────
  const ccFiles = await discoverClaudeCodeFiles()

  for (const fileInfo of ccFiles) {
    const { sessionId, project, filePath } = fileInfo
    const parserVersion = PARSER_VERSIONS.claudeCode
    const state = getState.get(filePath) as IngestionState | undefined
    const startLine = resolveStartLine(forceReindex, state, parserVersion)

    const result = parseClaudeCodeFile(filePath, sessionId, project, startLine)

    if (result.events.length === 0 && result.warnings.length === 0 && !forceReindex && startLine > 0) {
      continue
    }

    // Calculate costs from model_prices
    for (const event of result.events) {
      const price = findPrice(event.model)
      if (price) {
        const perTokens = price.per_tokens || 1000000
        event.inputCost = (event.inputTokens * price.input_price) / perTokens
        event.outputCost = (event.outputTokens * price.output_price) / perTokens
        event.cacheReadCost = (event.cacheReadTokens * price.cache_read_price) / perTokens
        event.cacheWriteCost = (event.cacheWriteTokens * price.cache_write_price) / perTokens
        event.totalCost = event.inputCost + event.outputCost + event.cacheReadCost + event.cacheWriteCost
      }
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
      parserVersion,
    })
  }

  // ─── Codex ingestion (CLI + App) ─────────────────────────────────────────
  const codexFiles = await discoverCodexFiles()

  for (const fileInfo of codexFiles) {
    const { sessionId, filePath } = fileInfo
    const parserVersion = PARSER_VERSIONS.codex
    const state = getState.get(filePath) as IngestionState | undefined
    const startLine = resolveStartLine(forceReindex, state, parserVersion)

    const result = parseCodexFile(filePath, sessionId, fileInfo.title, fileInfo.cwd, startLine)

    if (result.events.length === 0 && result.warnings.length === 0 && !forceReindex && startLine > 0) {
      continue
    }

    // Calculate costs from model_prices
    for (const event of result.events) {
      const price = findPrice(event.model)
      if (price) {
        const perTokens = price.per_tokens || 1000000
        event.inputCost = (event.inputTokens * price.input_price) / perTokens
        event.outputCost = (event.outputTokens * price.output_price) / perTokens
        event.cacheReadCost = (event.cacheReadTokens * price.cache_read_price) / perTokens
        event.cacheWriteCost = 0
        event.totalCost = event.inputCost + event.outputCost + event.cacheReadCost
      }
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
      parserVersion,
    })
  }

  // ─── Gemini CLI ingestion ────────────────────────────────────────────────
  const geminiFiles = await discoverGeminiCliFiles()

  for (const fileInfo of geminiFiles) {
    const result = parseGeminiCliFile(fileInfo.filePath, fileInfo.sessionId)
    applyCostsFromPrices(result.events)
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
    applyCostsFromPrices(result.events)
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
    applyCostsFromPrices(result.events)
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
