import fs from 'fs'
import path from 'path'
import os from 'os'
import { MessageKind, ParseResult, RawMessageEvent, RawUsageEvent } from './parser.js'
import { validateUsageBuckets } from './token-normalization.js'

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
  const messages = new Map<string, RawMessageEvent>()
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
    return { events, messages: [], warnings: [`Cannot read ${filePath}`], linesRead: 0 }
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

    if (type === 'response_item') {
      const payload = parsed.payload as Record<string, unknown> | undefined
      if (!payload) continue

      if (payload.type === 'message') {
        const role = payload.role as string | undefined
        const contentItems = Array.isArray(payload.content) ? payload.content as Array<Record<string, unknown>> : []
        const text = contentItems
          .filter((item) => item.type === 'input_text' || item.type === 'output_text')
          .map((item) => typeof item.text === 'string' ? item.text : '')
          .join('\n')
          .trim()

        let kind: MessageKind | null = null
        if (role === 'user') {
          if (text && !isCodexEnvironmentContext(text)) kind = 'user'
        } else if (role === 'assistant') {
          if (text) kind = 'assistant'
        }

        if (kind) {
          const messageId = `codex-msg::${sessionId}::${i}`
          messages.set(messageId, {
            id: messageId,
            timestampMs: ts,
            sessionId,
            sessionKey: null,
            agent: detectedProjectName || '',
            provider: 'openai',
            model: currentModel || 'unknown',
            channel: 'codex',
            kind,
            sourcePath: filePath,
          })
        }
      } else if (payload.type === 'function_call') {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : `call-${i}`
        messages.set(`codex-tool-call::${sessionId}::${callId}`, {
          id: `codex-tool-call::${sessionId}::${callId}`,
          timestampMs: ts,
          sessionId,
          sessionKey: null,
          agent: detectedProjectName || '',
          provider: 'openai',
          model: currentModel || 'unknown',
          channel: 'codex',
          kind: 'tool_call',
          sourcePath: filePath,
        })
      } else if (payload.type === 'function_call_output') {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : `call-${i}`
        messages.set(`codex-tool-result::${sessionId}::${callId}`, {
          id: `codex-tool-result::${sessionId}::${callId}`,
          timestampMs: ts,
          sessionId,
          sessionKey: null,
          agent: detectedProjectName || '',
          provider: 'openai',
          model: currentModel || 'unknown',
          channel: 'codex',
          kind: 'tool_result',
          sourcePath: filePath,
        })
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

      if (totalUsage.total_tokens === prevTotal.total) continue
      prevTotal = {
        input: totalUsage.input_tokens || 0,
        output: totalUsage.output_tokens || 0,
        cached: totalUsage.cached_input_tokens || 0,
        total: totalUsage.total_tokens || 0,
      }

      const cachedInputTokens = Number(lastUsage.cached_input_tokens ?? 0)
      const reasoningTokens = Number(lastUsage.reasoning_output_tokens ?? 0)
      const usage = {
        inputTokens: Number(lastUsage.input_tokens ?? 0) - cachedInputTokens,
        outputTokens: Number(lastUsage.output_tokens ?? 0) - reasoningTokens,
        reasoningTokens,
        cacheReadTokens: cachedInputTokens,
        cacheWriteTokens: 0,
      }
      const validation = validateUsageBuckets(usage)
      if (!validation.ok) {
        warnings.push(`Codex token_count event at line ${i + 1}: ${validation.warning}`)
        continue
      }
      const {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
      } = validation.value
      const totalTokens = Number(lastUsage.total_tokens ?? 0)
        || (inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens)

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
        reasoningTokens,
        cacheReadTokens,
        cacheWriteTokens,
        tokenSemantics: 'disjoint',
        totalTokens,
        inputCost: 0,
        outputCost: 0,
        reasoningCost: 0,
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
    messages: Array.from(messages.values()),
    currentModel,
    firstSeenAt,
    lastSeenAt,
    warnings,
    linesRead,
    projectName: detectedProjectName,
  }
}

function isCodexEnvironmentContext(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('<environment_context>') && trimmed.endsWith('</environment_context>')
}

function resolveTimestamp(raw: unknown): number {
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const n = Date.parse(raw)
    return isNaN(n) ? Date.now() : n
  }
  return Date.now()
}
