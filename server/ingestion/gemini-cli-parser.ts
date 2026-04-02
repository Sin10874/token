import fs from 'fs'
import { ParseResult, RawUsageEvent } from './parser.js'

interface GeminiMessage {
  id?: string
  timestamp?: string
  createTime?: string
  role?: string
  type?: string
  model?: string
  tokens?: {
    input?: number
    output?: number
    cached?: number
    thoughts?: number
    total?: number
  }
  usage?: Record<string, number>
  usageMetadata?: Record<string, number>
  token_count?: Record<string, number>
}

function resolveTimestamp(raw: unknown): number | null {
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

export function parseGeminiCliFile(
  filePath: string,
  sessionId: string,
): ParseResult {
  const events: RawUsageEvent[] = []
  const warnings: string[] = []
  let currentModel: string | undefined
  let firstSeenAt: number | undefined
  let lastSeenAt: number | undefined

  let data: { messages?: GeminiMessage[]; history?: GeminiMessage[]; model?: string; createTime?: string }
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return { events, warnings: [`Cannot read ${filePath}`], linesRead: 0 }
  }

  const messages = data.messages || data.history || []
  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index]
    const ts = resolveTimestamp(msg.timestamp || msg.createTime || data.createTime)
    if (ts == null) continue

    if (!firstSeenAt || ts < firstSeenAt) firstSeenAt = ts
    if (!lastSeenAt || ts > lastSeenAt) lastSeenAt = ts

    const role = msg.role || msg.type
    if (role === 'user') continue

    const model = msg.model || data.model || currentModel || 'unknown'
    currentModel = model

    const tokens = msg.tokens
    const usage = msg.usage || msg.usageMetadata || msg.token_count
    if (!tokens && !usage) continue

    let cacheReadTokens = 0
    let reasoningTokens = 0
    let inputTokens = 0
    let outputTokens = 0
    let totalTokens = 0

    if (tokens) {
      cacheReadTokens = tokens.cached || 0
      reasoningTokens = tokens.thoughts || 0
      inputTokens = Math.max(0, (tokens.input || 0) - cacheReadTokens)
      outputTokens = Math.max(0, (tokens.output || 0) - reasoningTokens)
      totalTokens = tokens.total || (inputTokens + outputTokens + cacheReadTokens + reasoningTokens)
    } else if (usage) {
      cacheReadTokens = usage.cachedContentTokenCount || 0
      reasoningTokens = usage.thoughtsTokenCount || 0
      inputTokens = Math.max(0, (usage.promptTokenCount || usage.input_tokens || 0) - cacheReadTokens)
      outputTokens = Math.max(0, (usage.candidatesTokenCount || usage.output_tokens || 0) - reasoningTokens)
      totalTokens = usage.totalTokenCount || (inputTokens + outputTokens + cacheReadTokens + reasoningTokens)
    }

    if (totalTokens === 0) continue

    events.push({
      id: `gemini-cli::${sessionId}::${msg.id || index}`,
      timestampMs: ts,
      sessionId,
      sessionKey: null,
      agent: 'unknown',
      provider: 'google',
      model,
      channel: 'gemini-cli',
      inputTokens,
      outputTokens,
      cacheReadTokens,
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

  return { events, currentModel, firstSeenAt, lastSeenAt, warnings, linesRead: messages.length }
}
