import fs from 'fs'
import path from 'path'
import os from 'os'
import { RawUsageEvent, ParseResult } from './parser.js'

/**
 * Parse Codex (CLI / App) session JSONL files.
 *
 * Codex sessions contain several event types:
 * - session_meta: session metadata (source, model_provider, cwd)
 * - turn_context: per-turn context with model name
 * - event_msg (token_count): cumulative + per-turn token usage
 */
export function parseCodexFile(
  filePath: string,
  sessionId: string,
  threadTitle: string | null,
  threadCwd: string | null,
  startLine = 0
): ParseResult {
  const events: RawUsageEvent[] = []
  const warnings: string[] = []
  let currentModel: string | undefined
  let firstSeenAt: number | undefined
  let lastSeenAt: number | undefined

  const home = os.homedir()

  // Resolve project name from cwd
  let detectedProjectName: string | undefined
  if (threadCwd) {
    if (threadCwd !== home) detectedProjectName = path.basename(threadCwd)
  }

  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return { events, warnings: [`Cannot read ${filePath}`], linesRead: 0 }
  }

  const lines = content.split('\n')
  const linesRead = lines.length

  let prevTotal = { input: 0, output: 0, cached: 0, total: 0 }
  let turnCounter = 0

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }

    const type = parsed.type as string
    const ts = resolveTimestamp(parsed.timestamp)

    if (ts && (!firstSeenAt || ts < firstSeenAt)) firstSeenAt = ts
    if (ts && (!lastSeenAt || ts > lastSeenAt)) lastSeenAt = ts

    // Extract cwd from session_meta as fallback
    if (type === 'session_meta' && !detectedProjectName) {
      const payload = parsed.payload as Record<string, unknown> | undefined
      const cwd = payload?.cwd as string | undefined
      if (cwd && cwd !== home) {
        detectedProjectName = path.basename(cwd)
      }
      continue
    }

    // Extract model from turn_context
    if (type === 'turn_context') {
      const payload = parsed.payload as Record<string, unknown> | undefined
      if (payload) {
        const model = payload.model as string | undefined
        if (model) currentModel = model
        if (!detectedProjectName) {
          const cwd = payload.cwd as string | undefined
          if (cwd && cwd !== home) {
            detectedProjectName = path.basename(cwd)
          }
        }
      }
      continue
    }

    // Process token_count events within event_msg
    if (type === 'event_msg') {
      const payload = parsed.payload as Record<string, unknown> | undefined
      if (!payload || payload.type !== 'token_count') continue

      const info = payload.info as Record<string, unknown> | undefined
      if (!info) continue

      const totalUsage = info.total_token_usage as Record<string, number> | undefined
      const lastUsage = info.last_token_usage as Record<string, number> | undefined
      if (!totalUsage || !lastUsage) continue

      const cachedInputTokens = lastUsage.cached_input_tokens || 0
      const inputTokens = Math.max(0, (lastUsage.input_tokens || 0) - cachedInputTokens)
      const outputTokens = lastUsage.output_tokens || 0
      const totalTokens = (lastUsage.total_tokens || 0) || (inputTokens + outputTokens + cachedInputTokens)

      if (totalUsage.total_tokens === prevTotal.total) continue
      prevTotal = {
        input: totalUsage.input_tokens || 0,
        output: totalUsage.output_tokens || 0,
        cached: totalUsage.cached_input_tokens || 0,
        total: totalUsage.total_tokens || 0,
      }

      if (totalTokens === 0) continue

      turnCounter++

      events.push({
        id: `codex::${sessionId}::${turnCounter}`,
        timestampMs: ts,
        sessionId,
        sessionKey: null,
        agent: detectedProjectName || '',
        provider: 'openai',
        model: currentModel || 'unknown',
        channel: 'codex',
        inputTokens,
        outputTokens,
        cacheReadTokens: cachedInputTokens,
        cacheWriteTokens: 0,
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
  }

  return {
    events,
    currentModel,
    firstSeenAt,
    lastSeenAt,
    warnings,
    linesRead,
    projectName: detectedProjectName,
  }
}

function resolveTimestamp(raw: unknown): number {
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const n = Date.parse(raw)
    return isNaN(n) ? Date.now() : n
  }
  return Date.now()
}
