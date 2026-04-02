import fs from 'fs'
import path from 'path'
import { ParseResult, RawUsageEvent } from './parser.js'

function resolveTimestamp(raw: unknown): number | null {
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

function getProject(context: Record<string, unknown> | undefined): string {
  const projectPath = (context?.gitRoot as string | undefined) || (context?.cwd as string | undefined)
  return projectPath ? path.basename(projectPath) || 'unknown' : 'unknown'
}

export function parseCopilotCliFile(filePath: string, sessionId: string): ParseResult {
  const events: RawUsageEvent[] = []
  const warnings: string[] = []
  let currentModel: string | undefined
  let firstSeenAt: number | undefined
  let lastSeenAt: number | undefined
  let project = 'unknown'
  let index = 0

  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return { events, warnings: [`Cannot read ${filePath}`], linesRead: 0 }
  }

  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }

    const ts = resolveTimestamp(obj.timestamp)
    if (ts == null) continue

    if (!firstSeenAt || ts < firstSeenAt) firstSeenAt = ts
    if (!lastSeenAt || ts > lastSeenAt) lastSeenAt = ts

    const type = obj.type as string | undefined
    if (type === 'session.start' || type === 'session.resume') {
      project = getProject(obj.data as Record<string, unknown> | undefined)
      continue
    }

    if (type !== 'session.shutdown') continue

    const modelMetrics = ((obj.data as Record<string, unknown> | undefined)?.modelMetrics || {}) as Record<string, { usage?: Record<string, number> }>
    for (const [model, metrics] of Object.entries(modelMetrics)) {
      const usage = metrics?.usage
      if (!usage) continue

      const cachedRead = usage.cacheReadTokens || 0
      const inputTokens = Math.max(0, (usage.inputTokens || 0) - cachedRead)
      const outputTokens = usage.outputTokens || 0
      const cacheWriteTokens = usage.cacheWriteTokens || 0
      const totalTokens = inputTokens + outputTokens + cachedRead + cacheWriteTokens
      if (totalTokens === 0) continue

      currentModel = model || currentModel
      index += 1
      events.push({
        id: `copilot-cli::${sessionId}::${index}`,
        timestampMs: ts,
        sessionId,
        sessionKey: null,
        agent: project,
        provider: 'github',
        model: model || 'unknown',
        channel: 'copilot-cli',
        inputTokens,
        outputTokens,
        cacheReadTokens: cachedRead,
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
  }

  return {
    events,
    currentModel,
    firstSeenAt,
    lastSeenAt,
    warnings,
    linesRead: lines.length,
    projectName: project,
  }
}
