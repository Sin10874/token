import fs from 'fs'
import path from 'path'
import os from 'os'
import { ParseResult, RawMessageEvent, RawUsageEvent } from './parser.js'

/**
 * Parse Claude Code conversation JSONL files.
 *
 * Claude Code format (type: "assistant"):
 * {
 *   sessionId, cwd, version, timestamp,
 *   message: {
 *     model, role: "assistant",
 *     usage: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }
 *   },
 *   type: "assistant", uuid
 * }
 */
export function parseClaudeCodeFile(
  filePath: string,
  sessionId: string,
  project: string,
  startLine = 0
): ParseResult {
  const events: RawUsageEvent[] = []
  const messages = new Map<string, RawMessageEvent>()
  const warnings: string[] = []
  let currentModel: string | undefined
  let firstSeenAt: number | undefined
  let lastSeenAt: number | undefined
  const rootProjectName = cleanProjectDir(project)
  let detectedProjectName: string | undefined = rootProjectName || undefined

  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch (e) {
    return { events, messages: [], warnings: [`Cannot read ${filePath}`], linesRead: 0 }
  }

  const lines = content.split('\n')
  const linesRead = lines.length

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line)
    } catch (_e) {
      continue // Skip non-JSON lines silently
    }

    // Only fall back to cwd when scanner project root cannot be derived.
    if (!rootProjectName && !detectedProjectName && parsed.cwd) {
      const cwd = parsed.cwd as string
      const home = os.homedir()
      if (cwd !== home) {
        detectedProjectName = path.basename(cwd)
      }
      // When cwd is home, leave detectedProjectName undefined so scanner's project name is used
    }

    const type = parsed.type as string
    const ts = resolveTimestamp(parsed.timestamp)

    if (!firstSeenAt || ts < firstSeenAt) firstSeenAt = ts
    if (!lastSeenAt || ts > lastSeenAt) lastSeenAt = ts

    // Only process assistant messages
    const msg = parsed.message as Record<string, unknown> | undefined
    if (!msg) continue
    const msgSessionId = (parsed.sessionId as string) || sessionId
    const contentParts = Array.isArray(msg.content) ? msg.content as Array<Record<string, unknown>> : []

    if (type === 'user') {
      const toolResultId = extractClaudeToolResultId(contentParts)
      if (toolResultId) {
        messages.set(`cc-tool-result::${msgSessionId}::${toolResultId}`, {
          id: `cc-tool-result::${msgSessionId}::${toolResultId}`,
          timestampMs: ts,
          sessionId: msgSessionId,
          sessionKey: null,
          agent: detectedProjectName || rootProjectName,
          provider: 'anthropic',
          model: currentModel || 'unknown',
          channel: 'claude-code',
          kind: 'tool_result',
          sourcePath: filePath,
        })
      } else if (contentParts.some((part) => part.type === 'text')) {
        const logicalId = String((msg.id as string) || (parsed.uuid as string) || `${msgSessionId}-${i}`)
        messages.set(`cc-msg::${msgSessionId}::${logicalId}`, {
          id: `cc-msg::${msgSessionId}::${logicalId}`,
          timestampMs: ts,
          sessionId: msgSessionId,
          sessionKey: null,
          agent: detectedProjectName || rootProjectName,
          provider: 'anthropic',
          model: currentModel || 'unknown',
          channel: 'claude-code',
          kind: 'user',
          sourcePath: filePath,
        })
      }
      continue
    }

    if (type !== 'assistant') continue

    const logicalId = String((msg.id as string) || (parsed.uuid as string) || `${msgSessionId}-${i}`)
    if (contentParts.some((part) => part.type === 'text')) {
      messages.set(`cc-msg::${msgSessionId}::${logicalId}`, {
        id: `cc-msg::${msgSessionId}::${logicalId}`,
        timestampMs: ts,
        sessionId: msgSessionId,
        sessionKey: null,
        agent: detectedProjectName || rootProjectName,
        provider: 'anthropic',
        model: String((msg.model as string) || currentModel || 'unknown'),
        channel: 'claude-code',
        kind: 'assistant',
        sourcePath: filePath,
      })
    }
    for (const part of contentParts) {
      if (part.type !== 'tool_use') continue
      const toolId = typeof part.id === 'string' ? part.id : `${logicalId}-tool`
      messages.set(`cc-tool-call::${msgSessionId}::${toolId}`, {
        id: `cc-tool-call::${msgSessionId}::${toolId}`,
        timestampMs: ts,
        sessionId: msgSessionId,
        sessionKey: null,
        agent: detectedProjectName || rootProjectName,
        provider: 'anthropic',
        model: String((msg.model as string) || currentModel || 'unknown'),
        channel: 'claude-code',
        kind: 'tool_call',
        sourcePath: filePath,
      })
    }

    const usage = msg.usage as Record<string, unknown> | undefined
    if (!usage) continue

    const inputTokens = (usage.input_tokens as number) || 0
    const outputTokens = (usage.output_tokens as number) || 0
    const cacheCreationTokens = (usage.cache_creation_input_tokens as number) || 0
    const cacheReadTokens = (usage.cache_read_input_tokens as number) || 0
    const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens

    if (totalTokens === 0) continue

    const model = (msg.model as string) || 'unknown'
    currentModel = model

    const msgUuid = (parsed.uuid as string) || `${sessionId}-${i}`

    events.push({
      id: `cc::${msgSessionId}::${msgUuid}`,
      timestampMs: ts,
      sessionId: msgSessionId,
      sessionKey: null,
      agent: detectedProjectName || rootProjectName,
      provider: 'anthropic',
      model,
      channel: 'claude-code',
      inputTokens,
      outputTokens,
      reasoningTokens: 0,
      cacheReadTokens,
      cacheWriteTokens: cacheCreationTokens,
      totalTokens,
      inputCost: 0, // Costs will be calculated from model_prices during query
      outputCost: 0,
      reasoningCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      totalCost: 0,
      sourcePath: filePath,
      stopReason: (msg.stop_reason as string) || 'unknown',
    })
  }

  return {
    events,
    messages: Array.from(messages.values()),
    currentModel,
    firstSeenAt,
    lastSeenAt,
    warnings,
    linesRead,
    projectName: detectedProjectName || rootProjectName,
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

/** Convert Claude Code project dir name like "-Users-xinzechao-ClawMeter" to "ClawMeter" */
function cleanProjectDir(dir: string): string {
  // Format: -Users-<username>-<project-path-segments>
  const parts = dir.split('-')
  const usersIdx = parts.indexOf('Users')
  if (usersIdx >= 0) {
    // Skip "-Users-<username>-" prefix, take the rest
    const projectParts = parts.slice(usersIdx + 2)
    const name = projectParts.join('-')
    return name || ''
  }
  return dir || ''
}

function extractClaudeToolResultId(contentParts: Array<Record<string, unknown>>): string | null {
  for (const part of contentParts) {
    if (part.type !== 'tool_result') continue
    if (typeof part.tool_use_id === 'string') return part.tool_use_id
  }
  return null
}
