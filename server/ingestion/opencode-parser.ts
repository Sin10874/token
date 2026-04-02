import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import { ParseResult, RawUsageEvent } from './parser.js'

interface OpencodeFileInfo {
  filePath: string
  sessionId: string
  kind: 'sqlite' | 'json'
}

function basenameOrUnknown(rootPath: string | undefined): string {
  return rootPath ? path.basename(rootPath) || 'unknown' : 'unknown'
}

export function parseOpencodeFile(fileInfo: OpencodeFileInfo): ParseResult {
  return fileInfo.kind === 'sqlite'
    ? parseOpencodeSqlite(fileInfo.filePath)
    : parseOpencodeJson(fileInfo.filePath, fileInfo.sessionId)
}

function parseOpencodeSqlite(filePath: string): ParseResult {
  const events: RawUsageEvent[] = []
  const warnings: string[] = []
  let currentModel: string | undefined
  let firstSeenAt: number | undefined
  let lastSeenAt: number | undefined

  try {
    const db = new DatabaseSync(filePath, { readOnly: true })
    const rows = db.prepare(`
      SELECT
        id,
        session_id as sessionId,
        json_extract(data, '$.role') as role,
        json_extract(data, '$.time.created') as created,
        json_extract(data, '$.modelID') as modelID,
        json_extract(data, '$.providerID') as providerID,
        json_extract(data, '$.tokens') as tokens,
        json_extract(data, '$.path.root') as rootPath
      FROM message
      ORDER BY created ASC
    `).all() as Array<Record<string, unknown>>
    db.close()

    for (const row of rows) {
      const ts = typeof row.created === 'number' ? row.created : Number(row.created)
      if (!Number.isFinite(ts)) continue
      if (!firstSeenAt || ts < firstSeenAt) firstSeenAt = ts
      if (!lastSeenAt || ts > lastSeenAt) lastSeenAt = ts

      if (row.role !== 'assistant') continue
      const tokensRaw = row.tokens
      if (!tokensRaw) continue

      const tokens = typeof tokensRaw === 'string' ? JSON.parse(tokensRaw) as Record<string, unknown> : tokensRaw as Record<string, unknown>
      const inputTokens = Number(tokens.input || 0)
      const outputTokens = Number(tokens.output || 0)
      const reasoningTokens = Number(tokens.reasoning || 0)
      const cacheReadTokens = Number((tokens.cache as Record<string, unknown> | undefined)?.read || 0)
      const cacheWriteTokens = Number((tokens.cache as Record<string, unknown> | undefined)?.write || 0)
      const totalTokens = inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens
      if (totalTokens === 0) continue

      currentModel = (row.modelID as string | undefined) || currentModel
      events.push({
        id: `opencode::${String(row.id || events.length)}`,
        timestampMs: ts,
        sessionId: String(row.sessionId || 'unknown'),
        sessionKey: null,
        agent: basenameOrUnknown(row.rootPath as string | undefined),
        provider: String(row.providerID || 'unknown'),
        model: String(row.modelID || 'unknown'),
        channel: 'opencode',
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        totalCost: 0,
        sourcePath: filePath,
        stopReason: 'end_turn',
      })
    }
  } catch (error) {
    warnings.push(`Failed to parse opencode sqlite: ${String(error)}`)
  }

  return { events, currentModel, firstSeenAt, lastSeenAt, warnings, linesRead: events.length }
}

function parseOpencodeJson(filePath: string, sessionId: string): ParseResult {
  const events: RawUsageEvent[] = []
  const warnings: string[] = []
  let currentModel: string | undefined
  let firstSeenAt: number | undefined
  let lastSeenAt: number | undefined

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>
    const ts = Number((data.time as Record<string, unknown> | undefined)?.created)
    if (Number.isFinite(ts)) {
      firstSeenAt = ts
      lastSeenAt = ts
    }

    if (data.role !== 'assistant') {
      return { events, currentModel, firstSeenAt, lastSeenAt, warnings, linesRead: 1 }
    }

    const tokens = data.tokens as Record<string, unknown> | undefined
    if (!tokens) {
      return { events, currentModel, firstSeenAt, lastSeenAt, warnings, linesRead: 1 }
    }

    const inputTokens = Number(tokens.input || 0)
    const outputTokens = Number(tokens.output || 0)
    const reasoningTokens = Number(tokens.reasoning || 0)
    const cacheReadTokens = Number((tokens.cache as Record<string, unknown> | undefined)?.read || 0)
    const cacheWriteTokens = Number((tokens.cache as Record<string, unknown> | undefined)?.write || 0)
    const totalTokens = inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens
    if (totalTokens === 0 || !Number.isFinite(ts)) {
      return { events, currentModel, firstSeenAt, lastSeenAt, warnings, linesRead: 1 }
    }

    currentModel = String(data.modelID || 'unknown')
    events.push({
      id: `opencode::${String(data.id || path.basename(filePath, '.json'))}`,
      timestampMs: ts,
      sessionId,
      sessionKey: null,
      agent: basenameOrUnknown((data.path as Record<string, unknown> | undefined)?.root as string | undefined),
      provider: String(data.providerID || 'unknown'),
      model: currentModel,
      channel: 'opencode',
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      totalCost: 0,
      sourcePath: filePath,
      stopReason: String(data.finish || 'end_turn'),
    })
  } catch {
    warnings.push(`Cannot read ${filePath}`)
  }

  return { events, currentModel, firstSeenAt, lastSeenAt, warnings, linesRead: 1 }
}
