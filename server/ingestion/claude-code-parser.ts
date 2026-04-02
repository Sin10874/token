import fs from 'fs'
import path from 'path'
import os from 'os'
import { RawUsageEvent, ParseResult } from './parser.js'

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
  const warnings: string[] = []
  let currentModel: string | undefined
  let firstSeenAt: number | undefined
  let lastSeenAt: number | undefined
  let detectedProjectName: string | undefined

  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch (e) {
    return { events, warnings: [`Cannot read ${filePath}`], linesRead: 0 }
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

    // Extract cwd from first line that has it to determine project name
    if (!detectedProjectName && parsed.cwd) {
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
    if (type !== 'assistant') continue

    const msg = parsed.message as Record<string, unknown> | undefined
    if (!msg) continue

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
    const msgSessionId = (parsed.sessionId as string) || sessionId

    events.push({
      id: `cc::${msgSessionId}::${msgUuid}`,
      timestampMs: ts,
      sessionId: msgSessionId,
      sessionKey: null,
      agent: detectedProjectName || cleanProjectDir(project),
      provider: 'anthropic',
      model,
      channel: 'claude-code',
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens: cacheCreationTokens,
      totalTokens,
      inputCost: 0, // Costs will be calculated from model_prices during query
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      totalCost: 0,
      sourcePath: filePath,
      stopReason: (msg.stop_reason as string) || 'unknown',
    })
  }

  return { events, currentModel, firstSeenAt, lastSeenAt, warnings, linesRead, projectName: detectedProjectName }
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
