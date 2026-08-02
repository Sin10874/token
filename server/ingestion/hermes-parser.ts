import type { DatabaseSync } from 'node:sqlite'
import { MessageKind, ParseResult, RawMessageEvent, RawUsageEvent } from './parser.js'
import type { HermesMessageRecord, HermesSessionRecord } from './hermes-scanner.js'

export interface HermesImportedTotals {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

interface HermesDeltaTotals extends HermesImportedTotals {
  totalTokens: number
}

const ZERO_TOTALS: HermesImportedTotals = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

function normalizeText(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed ? trimmed : null
}

function clampDelta(current: number, prior: number) {
  return Math.max(0, current - prior)
}

function computeHermesDelta(
  session: HermesSessionRecord,
  prior: HermesImportedTotals,
): HermesDeltaTotals {
  const inputTokens = clampDelta(session.inputTokens, prior.inputTokens)
  const outputTokens = clampDelta(session.outputTokens, prior.outputTokens)
  const reasoningTokens = clampDelta(session.reasoningTokens, prior.reasoningTokens)
  const cacheReadTokens = clampDelta(session.cacheReadTokens, prior.cacheReadTokens)
  const cacheWriteTokens = clampDelta(session.cacheWriteTokens, prior.cacheWriteTokens)

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens,
  }
}

function parseToolCalls(raw: string | null): Array<Record<string, unknown>> {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') as Array<Record<string, unknown>> : []
  } catch {
    return []
  }
}

function resolveHermesEventTimestamp(session: HermesSessionRecord, messages: HermesMessageRecord[]) {
  const latestMessageAt = messages.reduce<number | null>((latest, message) => {
    if (!message.timestampMs || message.timestampMs <= 0) return latest
    return latest == null || message.timestampMs > latest ? message.timestampMs : latest
  }, null)
  return latestMessageAt || session.endedAtMs || session.updatedAtMs || session.startedAtMs || Date.now()
}

function createMessageBase(
  session: HermesSessionRecord,
  message: HermesMessageRecord,
  kind: MessageKind,
  id: string,
): RawMessageEvent {
  return {
    id,
    timestampMs: message.timestampMs || session.updatedAtMs || session.startedAtMs || Date.now(),
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    agent: session.title,
    provider: session.billingProvider || 'unknown',
    model: session.model || 'unknown',
    channel: 'hermes',
    kind,
    sourcePath: session.sourcePath,
  }
}

function mapHermesMessages(session: HermesSessionRecord, messages: HermesMessageRecord[]) {
  const mapped: RawMessageEvent[] = []

  for (const message of messages) {
    if (message.role === 'user') {
      if (normalizeText(message.content)) {
        mapped.push(createMessageBase(session, message, 'user', `hermes-msg::${session.sessionId}::${message.id}`))
      }
      continue
    }

    if (message.role === 'assistant') {
      if (normalizeText(message.content)) {
        mapped.push(createMessageBase(session, message, 'assistant', `hermes-msg::${session.sessionId}::${message.id}`))
      }

      const toolCalls = parseToolCalls(message.toolCalls)
      for (let index = 0; index < toolCalls.length; index++) {
        const toolCall = toolCalls[index]
        const toolId = typeof toolCall.call_id === 'string'
          ? toolCall.call_id
          : typeof toolCall.id === 'string'
            ? toolCall.id
            : `${message.id}-${index}`
        mapped.push(createMessageBase(session, message, 'tool_call', `hermes-tool-call::${session.sessionId}::${toolId}`))
      }
      continue
    }

    if (message.role === 'tool' && (message.toolCallId || normalizeText(message.toolName) || normalizeText(message.content))) {
      const toolId = message.toolCallId || `${message.id}`
      mapped.push(createMessageBase(session, message, 'tool_result', `hermes-tool-result::${session.sessionId}::${toolId}`))
    }
  }

  return mapped
}

export function readPriorHermesTotals(db: DatabaseSync, sessionId: string): HermesImportedTotals {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as inputTokens,
      COALESCE(SUM(output_tokens), 0) as outputTokens,
      COALESCE(SUM(reasoning_tokens), 0) as reasoningTokens,
      COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens,
      COALESCE(SUM(cache_write_tokens), 0) as cacheWriteTokens
    FROM usage_events
    WHERE session_id = ? AND channel = 'hermes'
  `).get(sessionId) as HermesImportedTotals | undefined

  return row || ZERO_TOTALS
}

export function parseHermesSession(
  session: HermesSessionRecord,
  messages: HermesMessageRecord[],
  prior: HermesImportedTotals = ZERO_TOTALS,
): ParseResult {
  const delta = computeHermesDelta(session, prior)
  const timestampMs = resolveHermesEventTimestamp(session, messages)
  const mappedMessages = mapHermesMessages(session, messages)
  const events: RawUsageEvent[] = []

  if (delta.totalTokens > 0) {
    events.push({
      id: `hermes::${session.sessionId}::${session.inputTokens}:${session.outputTokens}:${session.cacheReadTokens}:${session.cacheWriteTokens}:${session.reasoningTokens}`,
      timestampMs,
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      agent: session.title,
      provider: session.billingProvider || 'unknown',
      model: session.model || 'unknown',
      channel: 'hermes',
      inputTokens: delta.inputTokens,
      outputTokens: delta.outputTokens,
      reasoningTokens: delta.reasoningTokens,
      cacheReadTokens: delta.cacheReadTokens,
      cacheWriteTokens: delta.cacheWriteTokens,
      totalTokens: delta.totalTokens,
      inputCost: 0,
      outputCost: 0,
      reasoningCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      totalCost: 0,
      sourcePath: session.sourcePath,
      stopReason: 'session_delta',
    })
  }

  return {
    events,
    messages: mappedMessages,
    currentModel: session.model || undefined,
    firstSeenAt: session.startedAtMs || undefined,
    lastSeenAt: timestampMs,
    warnings: [],
    linesRead: 1,
    projectName: session.title,
  }
}
