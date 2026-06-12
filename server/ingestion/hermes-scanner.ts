import fs from 'fs'
import os from 'os'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'

interface HermesSessionIndexMetadata {
  updatedAtMs: number | null
  displayName: string | null
  chatName: string | null
  userName: string | null
}

interface HermesSourceOptions {
  stateDbPath?: string
  sessionsIndexPath?: string
}

export interface HermesSessionRecord {
  sessionId: string
  source: string
  model: string | null
  billingProvider: string | null
  billingBaseUrl: string | null
  startedAtMs: number | null
  endedAtMs: number | null
  updatedAtMs: number | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  estimatedCostUsd: number
  title: string
  sessionKey: string
  sourcePath: string
}

export interface HermesMessageRecord {
  id: number
  sessionId: string
  role: string
  content: string | null
  toolCallId: string | null
  toolCalls: string | null
  toolName: string | null
  timestampMs: number
}

export interface HermesSourceSnapshot {
  sessions: HermesSessionRecord[]
  messagesBySessionId: Map<string, HermesMessageRecord[]>
}

interface HermesSessionRow {
  sessionId: string
  source: string
  model: string | null
  billingProvider: string | null
  billingBaseUrl: string | null
  startedAt: number | null
  endedAt: number | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  reasoningTokens: number | null
  estimatedCostUsd: number | null
  title: string | null
}

interface HermesMessageRow {
  id: number
  sessionId: string
  role: string
  content: string | null
  toolCallId: string | null
  toolCalls: string | null
  toolName: string | null
  timestamp: number
}

function secondsToMs(raw: number | null | undefined): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return Math.round(raw * 1000)
}

function parseIsoToMs(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw) return null
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? null : parsed
}

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed ? trimmed : null
}

function resolveFallbackTitle(source: string, sessionId: string) {
  return `${source}:${sessionId}`
}

function resolveHermesTitle(
  source: string,
  sessionId: string,
  rowTitle: string | null,
  metadata: HermesSessionIndexMetadata | undefined,
) {
  return (
    metadata?.displayName ||
    normalizeText(rowTitle) ||
    metadata?.chatName ||
    metadata?.userName ||
    resolveFallbackTitle(source, sessionId)
  )
}

function loadSessionsIndex(filePath: string): Map<string, HermesSessionIndexMetadata> {
  const map = new Map<string, HermesSessionIndexMetadata>()
  if (!fs.existsSync(filePath)) return map

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>
    for (const value of Object.values(parsed)) {
      const entry = value as Record<string, unknown>
      const sessionId = normalizeText(entry.session_id)
      if (!sessionId) continue
      const origin = (entry.origin || {}) as Record<string, unknown>
      map.set(sessionId, {
        updatedAtMs: parseIsoToMs(entry.updated_at),
        displayName: normalizeText(entry.display_name),
        chatName: normalizeText(origin.chat_name),
        userName: normalizeText(origin.user_name),
      })
    }
  } catch {
    return map
  }

  return map
}

export function discoverHermesSource(options: HermesSourceOptions = {}): HermesSourceSnapshot {
  const stateDbPath = options.stateDbPath || path.join(os.homedir(), '.hermes', 'state.db')
  const sessionsIndexPath =
    options.sessionsIndexPath || path.join(os.homedir(), '.hermes', 'sessions', 'sessions.json')

  if (!fs.existsSync(stateDbPath)) {
    return { sessions: [], messagesBySessionId: new Map() }
  }

  const metadataBySessionId = loadSessionsIndex(sessionsIndexPath)
  const database = new DatabaseSync(stateDbPath, { readOnly: true })

  try {
    const sessionRows = database.prepare(`
      SELECT
        id as sessionId,
        source,
        model,
        billing_provider as billingProvider,
        billing_base_url as billingBaseUrl,
        started_at as startedAt,
        ended_at as endedAt,
        input_tokens as inputTokens,
        output_tokens as outputTokens,
        cache_read_tokens as cacheReadTokens,
        cache_write_tokens as cacheWriteTokens,
        reasoning_tokens as reasoningTokens,
        estimated_cost_usd as estimatedCostUsd,
        title
      FROM sessions
      ORDER BY started_at ASC, id ASC
    `).all() as unknown as HermesSessionRow[]

    const sessions = sessionRows.map((row) => {
      const metadata = metadataBySessionId.get(row.sessionId)
      return {
        sessionId: row.sessionId,
        source: row.source,
        model: row.model,
        billingProvider: row.billingProvider,
        billingBaseUrl: row.billingBaseUrl,
        startedAtMs: secondsToMs(row.startedAt),
        endedAtMs: secondsToMs(row.endedAt),
        updatedAtMs: metadata?.updatedAtMs ?? null,
        inputTokens: Number(row.inputTokens || 0),
        outputTokens: Number(row.outputTokens || 0),
        cacheReadTokens: Number(row.cacheReadTokens || 0),
        cacheWriteTokens: Number(row.cacheWriteTokens || 0),
        reasoningTokens: Number(row.reasoningTokens || 0),
        estimatedCostUsd: Number(row.estimatedCostUsd || 0),
        title: resolveHermesTitle(row.source, row.sessionId, row.title, metadata),
        sessionKey: `hermes:${row.source}:${row.sessionId}`,
        sourcePath: stateDbPath,
      } satisfies HermesSessionRecord
    })

    const messagesBySessionId = new Map<string, HermesMessageRecord[]>()
    const messageRows = database.prepare(`
      SELECT
        id,
        session_id as sessionId,
        role,
        content,
        tool_call_id as toolCallId,
        tool_calls as toolCalls,
        tool_name as toolName,
        timestamp
      FROM messages
      ORDER BY session_id ASC, timestamp ASC, id ASC
    `).all() as unknown as HermesMessageRow[]

    for (const row of messageRows) {
      const existing = messagesBySessionId.get(row.sessionId) || []
      existing.push({
        id: row.id,
        sessionId: row.sessionId,
        role: row.role,
        content: row.content,
        toolCallId: row.toolCallId,
        toolCalls: row.toolCalls,
        toolName: row.toolName,
        timestampMs: secondsToMs(row.timestamp) || 0,
      })
      messagesBySessionId.set(row.sessionId, existing)
    }

    return { sessions, messagesBySessionId }
  } finally {
    database.close()
  }
}
