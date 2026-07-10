import { createHash } from 'node:crypto'
import { supabase } from './supabase-client.js'
import { applyEstimatedCosts } from './prices.js'
import type { RawUsageEvent, ParseResult } from '../server/ingestion/parser.js'
import { validateUsageBuckets } from '../server/ingestion/token-normalization.js'
import { discoverSessionFiles } from '../server/ingestion/scanner.js'
import { parseSessionFile } from '../server/ingestion/parser.js'
import { discoverClaudeCodeFiles } from '../server/ingestion/claude-code-scanner.js'
import { parseClaudeCodeFile } from '../server/ingestion/claude-code-parser.js'
import { discoverCodexFiles } from '../server/ingestion/codex-scanner.js'
import { parseCodexFile } from '../server/ingestion/codex-parser.js'
import { discoverGeminiCliFiles } from '../server/ingestion/gemini-cli-scanner.js'
import { parseGeminiCliFile } from '../server/ingestion/gemini-cli-parser.js'
import { discoverCopilotCliFiles } from '../server/ingestion/copilot-cli-scanner.js'
import { parseCopilotCliFile } from '../server/ingestion/copilot-cli-parser.js'
import { discoverOpencodeFiles } from '../server/ingestion/opencode-scanner.js'
import { parseOpencodeFile } from '../server/ingestion/opencode-parser.js'
import { discoverKimiCodeFiles } from '../server/ingestion/kimi-code-scanner.js'
import { parseKimiCodeFile } from '../server/ingestion/kimi-code-parser.js'
import { discoverQwenCodeFiles } from '../server/ingestion/qwen-code-scanner.js'
import { parseQwenCodeFile } from '../server/ingestion/qwen-code-parser.js'
import { discoverHermesSource } from '../server/ingestion/hermes-scanner.js'
import { HermesImportedTotals, parseHermesSession } from '../server/ingestion/hermes-parser.js'
import { PARSER_VERSIONS } from '../server/ingestion/parser-versions.js'

const BATCH_SIZE = 2000

interface SyncStats {
  filesProcessed: number
  eventsInserted: number
  sessionsUpdated: number
  duration: number
}

interface SyncState {
  sourcePathHash: string
  lastProcessedLines: number
  parserVersion: number
}

interface CollectOptions {
  trackSyncState?: boolean
}

interface CollectedSyncPayload {
  uploadEvents: Record<string, unknown>[]
  uploadMessages: Record<string, unknown>[]
  syncStates: SyncState[]
  sessionIds: string[]
  warnings: string[]
  hadActivity: boolean
}

interface SyncRpcData {
  ok?: boolean
  inserted?: number
  error?: unknown
  [key: string]: unknown
}

interface SyncRpcError {
  code?: string
  message: string
  cause?: unknown
}

interface SyncRpcResult {
  data?: SyncRpcData | null
  error?: SyncRpcError | null
}

type SyncRpc = (name: string, args: Record<string, unknown>) => PromiseLike<SyncRpcResult>

export function isMissingRpcError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'PGRST202'
}

interface UploadEventBatchParams extends Record<string, unknown> {
  p_token: string
  p_events: Record<string, unknown>[]
  p_sync_states: SyncState[]
}

interface UploadEventBatchResult {
  ok: true
  inserted: number
}

async function callEventUploadRpc(
  rpc: SyncRpc,
  name: 'tokend_upload_events_v2' | 'tokend_upload_events',
  params: UploadEventBatchParams,
): Promise<UploadEventBatchResult> {
  const { data, error } = await rpc(name, params)
  if (error) throw error
  if (data?.ok === false) {
    throw new Error(`Upload failed: ${String(data.error || 'unknown_error')}`)
  }

  return {
    ok: true,
    inserted: typeof data?.inserted === 'number' ? data.inserted : 0,
  }
}

export async function uploadEventBatch(
  rpc: SyncRpc,
  params: UploadEventBatchParams,
): Promise<UploadEventBatchResult> {
  try {
    return await callEventUploadRpc(rpc, 'tokend_upload_events_v2', params)
  } catch (error) {
    if (!isMissingRpcError(error)) throw error
  }

  return callEventUploadRpc(rpc, 'tokend_upload_events', params)
}

interface UploadSyncPayloadOptions {
  token: string
  events: Record<string, unknown>[]
  messages: Record<string, unknown>[]
  syncStates: SyncState[]
  rpc: SyncRpc
  batchSize?: number
}

interface HermesRemoteTotalsRow extends HermesImportedTotals {
  sessionId: string
}

function hashPath(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 16)
}

export function stripEvent(e: RawUsageEvent, project?: string): Record<string, unknown> {
  const isUnpriced = e.pricingStatus === 'unpriced'

  return {
    id: e.id,
    timestampMs: e.timestampMs,
    sessionId: e.sessionId,
    sessionKey: e.sessionKey ?? null,
    agent: e.agent,
    provider: e.provider,
    model: e.model,
    channel: e.channel,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    reasoningTokens: e.reasoningTokens,
    cacheReadTokens: e.cacheReadTokens,
    cacheWriteTokens: e.cacheWriteTokens,
    totalTokens: e.totalTokens,
    inputCost: isUnpriced ? 0 : e.inputCost,
    outputCost: isUnpriced ? 0 : e.outputCost,
    reasoningCost: isUnpriced ? 0 : e.reasoningCost,
    cacheReadCost: isUnpriced ? 0 : e.cacheReadCost,
    cacheWriteCost: isUnpriced ? 0 : e.cacheWriteCost,
    totalCost: isUnpriced ? 0 : e.totalCost,
    stopReason: e.stopReason,
    // codex 等渠道的 title 可能是整段 prompt（实测 46KB），超过
    // Postgres 索引行 8191 字节上限会导致整批上传失败
    project: project === undefined ? null : project.slice(0, 256),
    pricingStatus: e.pricingStatus ?? null,
    pricingTier: isUnpriced ? null : (e.pricingTier ?? null),
    priceVersion: isUnpriced ? null : (e.priceVersion ?? null),
    matchedModelId: isUnpriced ? null : (e.matchedModelId ?? null),
    tokenSemantics: e.tokenSemantics,
    unallocatedCost: isUnpriced ? 0 : (e.unallocatedCost ?? 0),
    breakdownStatus: e.breakdownStatus ?? null,
  }
}

export function collectSyncPayload(
  result: ParseResult,
  filePath: string,
  parserKey: keyof typeof PARSER_VERSIONS,
  project?: string,
  options: CollectOptions = {},
): CollectedSyncPayload {
  const uploadEvents: Record<string, unknown>[] = []
  const sessionIds: string[] = []
  const warnings = result.warnings.map(warning => `${filePath}: ${warning}`)

  for (const event of result.events) {
    const validation = validateUsageBuckets(event)
    if (!validation.ok) {
      warnings.push(`${filePath}: skipped usage event ${event.id}: ${validation.warning}`)
      continue
    }

    const pricedEvent = { ...event }
    applyEstimatedCosts(pricedEvent)
    uploadEvents.push(stripEvent(pricedEvent, project))
    sessionIds.push(event.sessionId)
  }

  const uploadMessages = result.messages.map(message => ({
    id: message.id,
    timestampMs: message.timestampMs,
    sessionId: message.sessionId,
    agent: message.agent,
    channel: message.channel,
    kind: message.kind,
  }))

  const parserVersion = PARSER_VERSIONS[parserKey]
  const syncStates = options.trackSyncState === false
    ? []
    : [{
        sourcePathHash: hashPath(filePath),
        lastProcessedLines: result.linesRead,
        parserVersion,
      }]

  return {
    uploadEvents,
    uploadMessages,
    syncStates,
    sessionIds,
    warnings,
    hadActivity: result.events.length > 0 || result.messages.length > 0,
  }
}

export async function uploadSyncPayload({
  token,
  events,
  messages,
  syncStates,
  rpc,
  batchSize = BATCH_SIZE,
}: UploadSyncPayloadOptions): Promise<number> {
  let eventsInserted = 0

  async function uploadEventSlice(
    eventBatch: Record<string, unknown>[],
    stateBatch: SyncState[],
  ): Promise<void> {
    const result = await uploadEventBatch(rpc, {
      p_token: token,
      p_events: eventBatch,
      p_sync_states: stateBatch,
    })
    eventsInserted += result.inserted
  }

  if (messages.length > 0) {
    if (events.length === 0) {
      await uploadEventSlice([], [])
    } else {
      for (let i = 0; i < events.length; i += batchSize) {
        await uploadEventSlice(events.slice(i, i + batchSize), [])
      }
    }

    for (let i = 0; i < messages.length; i += batchSize) {
      const { data, error } = await rpc('tokend_upload_messages', {
        p_token: token,
        p_messages: messages.slice(i, i + batchSize),
      })
      if (error) throw new Error(`Message upload failed: ${error.message}`)
      if (data?.ok === false) {
        throw new Error(`Message upload failed: ${String(data.error || 'unknown_error')}`)
      }
    }

    if (syncStates.length > 0) {
      await uploadEventSlice([], syncStates)
    }
    return eventsInserted
  }

  if (events.length > 0) {
    for (let i = 0; i < events.length; i += batchSize) {
      const isLast = i + batchSize >= events.length
      await uploadEventSlice(events.slice(i, i + batchSize), isLast ? syncStates : [])
    }
  } else if (syncStates.length > 0) {
    await uploadEventSlice([], syncStates)
  }

  return eventsInserted
}

async function getRemoteHermesTotals(token: string, sessionIds: string[]): Promise<Map<string, HermesImportedTotals>> {
  const uniqueSessionIds = Array.from(new Set(sessionIds))
  if (uniqueSessionIds.length === 0) return new Map()

  const { data, error } = await supabase.rpc('tokend_get_hermes_session_totals', {
    p_token: token,
    p_session_ids: uniqueSessionIds,
  })

  if (error) {
    throw new Error(
      `Hermes sync requires Supabase SQL upgrade. Please run scripts/supabase-v9-hermes-sync.sql first. (${error.message})`,
    )
  }

  if (!data?.ok) {
    throw new Error(`Hermes session lookup failed: ${data?.error || 'unknown_error'}`)
  }

  const totals = new Map<string, HermesImportedTotals>()
  const sessions = Array.isArray(data.sessions) ? data.sessions as HermesRemoteTotalsRow[] : []
  for (const session of sessions) {
    totals.set(session.sessionId, {
      inputTokens: Number(session.inputTokens || 0),
      outputTokens: Number(session.outputTokens || 0),
      reasoningTokens: Number(session.reasoningTokens || 0),
      cacheReadTokens: Number(session.cacheReadTokens || 0),
      cacheWriteTokens: Number(session.cacheWriteTokens || 0),
    })
  }

  return totals
}

export async function runCloudSync(token: string): Promise<SyncStats> {
  const start = Date.now()
  const stats: SyncStats = { filesProcessed: 0, eventsInserted: 0, sessionsUpdated: 0, duration: 0 }

  // 1. Fetch existing sync state from Supabase
  const { data: syncData } = await supabase.rpc('tokend_get_sync_state', { p_token: token })
  const remoteStates = new Map<string, { lastProcessedLines: number; parserVersion: number }>()
  if (syncData?.ok && Array.isArray(syncData.states)) {
    for (const s of syncData.states) {
      remoteStates.set(s.sourcePathHash, {
        lastProcessedLines: s.lastProcessedLines,
        parserVersion: s.parserVersion,
      })
    }
  }

  function getStartLine(filePath: string, parserVersion: number): number {
    const hash = hashPath(filePath)
    const state = remoteStates.get(hash)
    if (!state) return 0
    if (state.parserVersion !== parserVersion) return 0
    return state.lastProcessedLines || 0
  }

  const allEvents: Record<string, unknown>[] = []
  const allMessages: Record<string, unknown>[] = []
  const allSyncStates: SyncState[] = []
  const sessionIds = new Set<string>()

  function collect(
    result: ParseResult,
    filePath: string,
    parserKey: keyof typeof PARSER_VERSIONS,
    project?: string,
    options: CollectOptions = {},
  ) {
    const collected = collectSyncPayload(result, filePath, parserKey, project, options)
    allEvents.push(...collected.uploadEvents)
    allMessages.push(...collected.uploadMessages)
    allSyncStates.push(...collected.syncStates)
    for (const sessionId of collected.sessionIds) sessionIds.add(sessionId)
    for (const warning of collected.warnings) {
      console.warn(`[tokend sync] ${warning}`)
    }
    if (collected.hadActivity) stats.filesProcessed++
  }

  // 2. Run all scanners and parsers

  // OpenClaw
  const openclawFiles = await discoverSessionFiles()
  for (const f of openclawFiles) {
    const startLine = getStartLine(f.filePath, PARSER_VERSIONS.openclaw)
    const result = parseSessionFile(f.filePath, f.sessionId, f.sessionKey, f.agent, f.channel || 'unknown', startLine)
    if (result.events.length > 0 || result.messages.length > 0 || result.warnings.length > 0 || startLine === 0) {
      collect(result, f.filePath, 'openclaw')
    }
  }

  // Claude Code
  const ccFiles = await discoverClaudeCodeFiles()
  for (const f of ccFiles) {
    const startLine = getStartLine(f.filePath, PARSER_VERSIONS.claudeCode)
    const result = parseClaudeCodeFile(f.filePath, f.sessionId, f.project, startLine)
    if (result.events.length > 0 || result.messages.length > 0 || result.warnings.length > 0 || startLine === 0) {
      // project name is already cleaned by parser into agent field — use that
      const cleanProject = result.events.length > 0 ? result.events[0].agent : undefined
      collect(result, f.filePath, 'claudeCode', cleanProject || undefined)
    }
  }

  // Codex
  const codexFiles = await discoverCodexFiles()
  for (const f of codexFiles) {
    const startLine = getStartLine(f.filePath, PARSER_VERSIONS.codex)
    const result = parseCodexFile(f.filePath, f.sessionId, f.title, f.cwd, startLine)
    if (result.events.length > 0 || result.messages.length > 0 || result.warnings.length > 0 || startLine === 0) {
      collect(result, f.filePath, 'codex', f.title || f.cwd || undefined)
    }
  }

  // Gemini CLI
  const geminiFiles = await discoverGeminiCliFiles()
  for (const f of geminiFiles) {
    const result = parseGeminiCliFile(f.filePath, f.sessionId)
    if (result.events.length > 0 || result.messages.length > 0 || result.warnings.length > 0) {
      collect(result, f.filePath, 'geminiCli')
    }
  }

  // Copilot CLI
  const copilotFiles = await discoverCopilotCliFiles()
  for (const f of copilotFiles) {
    const result = parseCopilotCliFile(f.filePath, f.sessionId)
    if (result.events.length > 0 || result.messages.length > 0 || result.warnings.length > 0) {
      collect(result, f.filePath, 'copilotCli')
    }
  }

  // OpenCode
  const opencodeFiles = await discoverOpencodeFiles()
  for (const f of opencodeFiles) {
    const result = parseOpencodeFile(f)
    if (result.events.length > 0 || result.messages.length > 0 || result.warnings.length > 0) {
      collect(result, f.filePath, 'opencode')
    }
  }

  // Kimi Code
  const kimiFiles = await discoverKimiCodeFiles()
  for (const f of kimiFiles) {
    const result = parseKimiCodeFile(f.filePath, f.sessionId)
    if (result.events.length > 0 || result.messages.length > 0 || result.warnings.length > 0) {
      collect(result, f.filePath, 'kimiCode')
    }
  }

  // Qwen Code
  const qwenFiles = await discoverQwenCodeFiles()
  for (const f of qwenFiles) {
    const result = parseQwenCodeFile(f.filePath, f.sessionId)
    if (result.events.length > 0 || result.messages.length > 0 || result.warnings.length > 0) {
      collect(result, f.filePath, 'qwenCode')
    }
  }

  // Hermes
  const hermesSnapshot = discoverHermesSource()
  if (hermesSnapshot.sessions.length > 0) {
    const remoteHermesTotals = await getRemoteHermesTotals(
      token,
      hermesSnapshot.sessions.map((session) => session.sessionId),
    )

    for (const session of hermesSnapshot.sessions) {
      const result = parseHermesSession(
        session,
        hermesSnapshot.messagesBySessionId.get(session.sessionId) || [],
        remoteHermesTotals.get(session.sessionId),
      )
      collect(
        result,
        `${session.sourcePath}::${session.sessionId}`,
        'hermes',
        session.title,
        { trackSyncState: false },
      )
    }
  }

  // 3. Upload payloads before committing sync cursors.
  stats.eventsInserted += await uploadSyncPayload({
    token,
    events: allEvents,
    messages: allMessages,
    syncStates: allSyncStates,
    rpc: (name, args) => supabase.rpc(name, args),
  })

  // 4. Rebuild sessions
  if (sessionIds.size > 0) {
    const ids = Array.from(sessionIds)
    // Batch session rebuilds in groups of 100
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100)
      const { data } = await supabase.rpc('tokend_rebuild_sessions', {
        p_token: token,
        p_session_ids: batch,
      })
      stats.sessionsUpdated += data?.sessions_updated || 0
    }
  }

  stats.duration = Date.now() - start
  return stats
}
