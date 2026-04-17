import { createHash } from 'node:crypto'
import { supabase } from './supabase-client.js'
import { applyEstimatedCosts } from './prices.js'
import type { RawUsageEvent, ParseResult } from '../server/ingestion/parser.js'
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

const BATCH_SIZE = 2000

const PARSER_VERSIONS: Record<string, number> = {
  openclaw: 1, claudeCode: 1, codex: 2,
  geminiCli: 1, copilotCli: 1, opencode: 1,
  kimiCode: 1, qwenCode: 1,
}

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

interface HermesRemoteTotalsRow extends HermesImportedTotals {
  sessionId: string
}

function hashPath(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 16)
}

function stripEvent(e: RawUsageEvent, project?: string): Record<string, unknown> {
  return {
    id: e.id,
    timestampMs: e.timestampMs,
    sessionId: e.sessionId,
    sessionKey: e.sessionKey || null,
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
    inputCost: e.inputCost,
    outputCost: e.outputCost,
    reasoningCost: e.reasoningCost,
    cacheReadCost: e.cacheReadCost,
    cacheWriteCost: e.cacheWriteCost,
    totalCost: e.totalCost,
    stopReason: e.stopReason,
    project: project || null,
  }
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
    parserKey: string,
    project?: string,
    options: { trackSyncState?: boolean } = {},
  ) {
    const pv = PARSER_VERSIONS[parserKey] || 1
    for (const event of result.events) {
      applyEstimatedCosts(event)
      allEvents.push(stripEvent(event, project))
      sessionIds.add(event.sessionId)
    }
    for (const msg of result.messages) {
      allMessages.push({
        id: msg.id,
        timestampMs: msg.timestampMs,
        sessionId: msg.sessionId,
        agent: msg.agent,
        channel: msg.channel,
        kind: msg.kind,
      })
    }
    if (result.events.length > 0 || result.messages.length > 0) stats.filesProcessed++
    if (options.trackSyncState !== false) {
      allSyncStates.push({
        sourcePathHash: hashPath(filePath),
        lastProcessedLines: result.linesRead,
        parserVersion: pv,
      })
    }
  }

  // 2. Run all scanners and parsers

  // OpenClaw
  const openclawFiles = await discoverSessionFiles()
  for (const f of openclawFiles) {
    const startLine = getStartLine(f.filePath, PARSER_VERSIONS.openclaw)
    const result = parseSessionFile(f.filePath, f.sessionId, f.sessionKey, f.agent, f.channel || 'unknown', startLine)
    if (result.events.length > 0 || startLine === 0) {
      collect(result, f.filePath, 'openclaw')
    }
  }

  // Claude Code
  const ccFiles = await discoverClaudeCodeFiles()
  for (const f of ccFiles) {
    const startLine = getStartLine(f.filePath, PARSER_VERSIONS.claudeCode)
    const result = parseClaudeCodeFile(f.filePath, f.sessionId, f.project, startLine)
    if (result.events.length > 0 || startLine === 0) {
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
    if (result.events.length > 0 || startLine === 0) {
      collect(result, f.filePath, 'codex', f.title || f.cwd || undefined)
    }
  }

  // Gemini CLI
  const geminiFiles = await discoverGeminiCliFiles()
  for (const f of geminiFiles) {
    const result = parseGeminiCliFile(f.filePath, f.sessionId)
    if (result.events.length > 0) collect(result, f.filePath, 'geminiCli')
  }

  // Copilot CLI
  const copilotFiles = await discoverCopilotCliFiles()
  for (const f of copilotFiles) {
    const result = parseCopilotCliFile(f.filePath, f.sessionId)
    if (result.events.length > 0) collect(result, f.filePath, 'copilotCli')
  }

  // OpenCode
  const opencodeFiles = await discoverOpencodeFiles()
  for (const f of opencodeFiles) {
    const result = parseOpencodeFile(f)
    if (result.events.length > 0) collect(result, f.filePath, 'opencode')
  }

  // Kimi Code
  const kimiFiles = await discoverKimiCodeFiles()
  for (const f of kimiFiles) {
    const result = parseKimiCodeFile(f.filePath, f.sessionId)
    if (result.events.length > 0) collect(result, f.filePath, 'kimiCode')
  }

  // Qwen Code
  const qwenFiles = await discoverQwenCodeFiles()
  for (const f of qwenFiles) {
    const result = parseQwenCodeFile(f.filePath, f.sessionId)
    if (result.events.length > 0) collect(result, f.filePath, 'qwenCode')
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

  // 3. Upload in batches
  if (allEvents.length > 0) {
    for (let i = 0; i < allEvents.length; i += BATCH_SIZE) {
      const batch = allEvents.slice(i, i + BATCH_SIZE)
      const isLast = i + BATCH_SIZE >= allEvents.length
      const { data, error } = await supabase.rpc('tokend_upload_events', {
        p_token: token,
        p_events: batch,
        p_sync_states: isLast ? allSyncStates : [],
      })
      if (error) throw new Error(`Upload failed: ${error.message}`)
      stats.eventsInserted += data?.inserted || 0
    }
  } else if (allSyncStates.length > 0) {
    // No new events but still update sync states
    await supabase.rpc('tokend_upload_events', {
      p_token: token,
      p_events: [],
      p_sync_states: allSyncStates,
    })
  }

  // 3b. Upload message events in batches
  if (allMessages.length > 0) {
    for (let i = 0; i < allMessages.length; i += BATCH_SIZE) {
      const batch = allMessages.slice(i, i + BATCH_SIZE)
      try {
        await supabase.rpc('tokend_upload_messages', {
          p_token: token,
          p_messages: batch,
        })
      } catch {
        // Silently skip if RPC doesn't exist yet
      }
    }
  }

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
