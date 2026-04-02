import fs from 'fs'

export interface RawUsageEvent {
  id: string
  timestampMs: number
  sessionId: string
  sessionKey?: string | null
  agent: string
  provider: string
  model: string
  channel: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  inputCost: number
  outputCost: number
  cacheReadCost: number
  cacheWriteCost: number
  totalCost: number
  sourcePath: string
  stopReason: string
}

export interface ParseResult {
  events: RawUsageEvent[]
  currentModel?: string
  firstSeenAt?: number
  lastSeenAt?: number
  warnings: string[]
  linesRead: number
  projectName?: string
}

// Normalize model names (merge aliases into canonical name)
const MODEL_ALIASES: Record<string, string> = {
  'M-2.7': 'MiniMax-M2.7',
}

function normalizeModel(model: string): string {
  return MODEL_ALIASES[model] || model
}

function resolveTimestamp(raw: unknown): number {
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const n = Date.parse(raw)
    return isNaN(n) ? Date.now() : n
  }
  return Date.now()
}

export function parseSessionFile(
  filePath: string,
  sessionId: string,
  sessionKey: string | undefined,
  agent: string,
  channel: string,
  startLine = 0
): ParseResult {
  const events: RawUsageEvent[] = []
  const warnings: string[] = []
  let currentModel: string | undefined
  let firstSeenAt: number | undefined
  let lastSeenAt: number | undefined

  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch (e) {
    return { events, warnings: [`Cannot read ${filePath}`], linesRead: 0 }
  }

  const lines = content.split('\n')
  let linesRead = lines.length

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line)
    } catch (_e) {
      warnings.push(`Line ${i + 1}: invalid JSON`)
      continue
    }

    const type = parsed.type as string
    const ts = resolveTimestamp(parsed.timestamp)

    if (!firstSeenAt || ts < firstSeenAt) firstSeenAt = ts
    if (!lastSeenAt || ts > lastSeenAt) lastSeenAt = ts

    if (type === 'model_change') {
      currentModel = (parsed.modelId as string) || currentModel
      continue
    }

    if (type !== 'message') continue

    const msg = parsed.message as Record<string, unknown> | undefined
    if (!msg || msg.role !== 'assistant') continue

    const usage = msg.usage as Record<string, unknown> | undefined
    if (!usage) continue

    const inputTokens = (usage.input as number) || 0
    const outputTokens = (usage.output as number) || 0
    const cacheReadTokens = (usage.cacheRead as number) || 0
    const cacheWriteTokens = (usage.cacheWrite as number) || 0
    const totalTokens =
      (usage.totalTokens as number) ||
      inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens

    // Skip zero-usage events
    if (totalTokens === 0) continue

    const costRaw = usage.cost as Record<string, number> | undefined
    const inputCost = costRaw?.input || 0
    const outputCost = costRaw?.output || 0
    const cacheReadCost = costRaw?.cacheRead || 0
    const cacheWriteCost = costRaw?.cacheWrite || 0
    const totalCost = costRaw?.total || inputCost + outputCost + cacheReadCost + cacheWriteCost

    const msgTimestamp = (msg.timestamp as number) || ts
    const msgId = (parsed.id as string) || `${sessionId}-${i}`
    const model = normalizeModel((msg.model as string) || currentModel || 'unknown')
    const provider = (msg.provider as string) || 'unknown'

    currentModel = model

    events.push({
      id: `${sessionId}::${msgId}`,
      timestampMs: msgTimestamp,
      sessionId,
      sessionKey: sessionKey ?? null,
      agent,
      provider,
      model,
      channel,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      inputCost,
      outputCost,
      cacheReadCost,
      cacheWriteCost,
      totalCost,
      sourcePath: filePath,
      stopReason: (msg.stopReason as string) || 'unknown',
    })
  }

  return { events, currentModel, firstSeenAt, lastSeenAt, warnings, linesRead }
}
