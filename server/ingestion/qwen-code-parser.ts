import fs from 'fs'
import path from 'path'
import { ParseResult, RawMessageEvent, RawUsageEvent } from './parser.js'

function resolveTimestamp(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return raw > 1e12 ? raw : Math.round(raw * 1000)
  }
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

function inferProjectName(text: string): string {
  const pathMatch = text.match(/\/Users\/[^/\s]+\/([A-Za-z0-9._-]+)/)
  if (pathMatch?.[1]) return pathMatch[1]
  const projectMatch = text.match(/(?:进入|在)\s*([A-Za-z0-9._-]+)\s*项目/)
  if (projectMatch?.[1]) return projectMatch[1]
  return 'unknown'
}

function parseUsageRecord(
  record: Record<string, unknown>,
  fallbackId: string,
  fallbackSessionId: string,
  fallbackProject: string
): RawUsageEvent | null {
  const source = (record.message && typeof record.message === 'object'
    ? record.message as Record<string, unknown>
    : record) as Record<string, unknown>
  const payload = (source.payload && typeof source.payload === 'object'
    ? source.payload as Record<string, unknown>
    : source) as Record<string, unknown>
  const usage = (payload.token_usage || payload.usage || payload.tokens || payload.tokenUsage) as Record<string, unknown> | undefined
  if (!usage) return null

  const inputTokens = Number(usage.input_other || usage.input || usage.inputTokens || usage.prompt_tokens || 0)
  const rawOutputTokens = Number(usage.output || usage.outputTokens || usage.completion_tokens || 0)
  const reasoningTokens = Number(usage.reasoning || usage.reasoning_tokens || usage.reasoningOutputTokens || usage.thoughts || 0)
  const outputTokens = Math.max(0, rawOutputTokens - reasoningTokens)
  const cacheReadTokens = Number(usage.input_cache_read || usage.cacheRead || usage.cache_read_tokens || usage.cached_tokens || 0)
  const cacheWriteTokens = Number(usage.input_cache_creation || usage.cacheWrite || usage.cache_write_tokens || 0)
  const totalTokens = Number(usage.total || usage.totalTokens || (inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens))
  if (totalTokens === 0) return null

  const ts = resolveTimestamp(record.timestamp || source.timestamp || payload.timestamp || payload.created_at || record.created_at)
  if (ts == null) return null

  const model = String(payload.model || source.model || record.model || 'unknown')
  const provider = String(payload.provider || source.provider || record.provider || 'alibaba')
  const sessionId = String(payload.session_id || source.session_id || record.session_id || fallbackSessionId)
  const project = String(payload.project || source.project || record.project || fallbackProject || 'unknown')
  const messageId = String(payload.message_id || source.message_id || record.id || fallbackId)

  return {
    id: `qwen-code::${sessionId}::${messageId}`,
    timestampMs: ts,
    sessionId,
    sessionKey: null,
    agent: project,
    provider,
    model,
    channel: 'qwen-code',
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    tokenSemantics: 'unknown',
    totalTokens,
    inputCost: 0,
    outputCost: 0,
    reasoningCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    totalCost: 0,
    sourcePath: '',
    stopReason: String(payload.stop_reason || source.stop_reason || 'end_turn'),
  }
}

export function parseQwenCodeFile(filePath: string, sessionId: string): ParseResult {
  const events: RawUsageEvent[] = []
  const messages = new Map<string, RawMessageEvent>()
  const warnings: string[] = []
  let currentModel: string | undefined
  let firstSeenAt: number | undefined
  let lastSeenAt: number | undefined
  let projectName = 'unknown'

  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return { events, messages: [], warnings: [`Cannot read ${filePath}`], linesRead: 0, projectName }
  }

  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.json') {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>
      const records = Array.isArray(parsed.messages) ? parsed.messages as Array<Record<string, unknown>> : [parsed]
      for (let index = 0; index < records.length; index++) {
        const messageRecord = records[index]
        collectQwenMessage(messageRecord, sessionId, projectName, filePath, `${path.basename(filePath, '.json')}-${index}`, messages)
        const event = parseUsageRecord(messageRecord, `${path.basename(filePath, '.json')}-${index}`, sessionId, projectName)
        if (!event) continue
        event.sourcePath = filePath
        events.push(event)
        currentModel = event.model
        projectName = event.agent
        if (!firstSeenAt || event.timestampMs < firstSeenAt) firstSeenAt = event.timestampMs
        if (!lastSeenAt || event.timestampMs > lastSeenAt) lastSeenAt = event.timestampMs
      }
      return { events, messages: Array.from(messages.values()), currentModel, firstSeenAt, lastSeenAt, warnings, linesRead: records.length, projectName }
    } catch {
      return { events, messages: Array.from(messages.values()), warnings: [`Cannot parse ${filePath}`], linesRead: 0, projectName }
    }
  }

  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()
    if (!line) continue

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      warnings.push(`Line ${index + 1}: invalid JSON`)
      continue
    }

    const candidateTexts = [
      typeof parsed.text === 'string' ? parsed.text : '',
      typeof parsed.command === 'string' ? parsed.command : '',
      typeof parsed.arguments === 'string' ? parsed.arguments : '',
      typeof parsed.content === 'string' ? parsed.content : '',
    ].filter(Boolean)
    for (const text of candidateTexts) {
      const inferred = inferProjectName(text)
      if (inferred !== 'unknown') projectName = inferred
    }

    collectQwenMessage(parsed, sessionId, projectName, filePath, `${sessionId}-${index}`, messages)
    const event = parseUsageRecord(parsed, `${sessionId}-${index}`, sessionId, projectName)
    if (!event) continue
    event.sourcePath = filePath
    events.push(event)
    currentModel = event.model
    projectName = event.agent
    if (!firstSeenAt || event.timestampMs < firstSeenAt) firstSeenAt = event.timestampMs
    if (!lastSeenAt || event.timestampMs > lastSeenAt) lastSeenAt = event.timestampMs
  }

  return { events, messages: Array.from(messages.values()), currentModel, firstSeenAt, lastSeenAt, warnings, linesRead: lines.length, projectName }
}

function collectQwenMessage(
  record: Record<string, unknown>,
  sessionId: string,
  projectName: string,
  filePath: string,
  fallbackId: string,
  collector: Map<string, RawMessageEvent>,
) {
  const source = (record.message && typeof record.message === 'object'
    ? record.message as Record<string, unknown>
    : record) as Record<string, unknown>
  const payload = (source.payload && typeof source.payload === 'object'
    ? source.payload as Record<string, unknown>
    : source) as Record<string, unknown>

  const ts = resolveTimestamp(record.timestamp || source.timestamp || payload.timestamp || payload.created_at || record.created_at)
  if (ts == null) return

  const role = String(payload.role || source.role || record.role || payload.type || source.type || record.type || '')
  const model = String(payload.model || source.model || record.model || 'unknown')
  const provider = String(payload.provider || source.provider || record.provider || 'alibaba')
  const effectiveSessionId = String(payload.session_id || source.session_id || record.session_id || sessionId)

  if (role === 'user') {
    collector.set(`qwen-code-msg::${effectiveSessionId}::${fallbackId}`, {
      id: `qwen-code-msg::${effectiveSessionId}::${fallbackId}`,
      timestampMs: ts,
      sessionId: effectiveSessionId,
      sessionKey: null,
      agent: projectName,
      provider,
      model,
      channel: 'qwen-code',
      kind: 'user',
      sourcePath: filePath,
    })
    return
  }

  if (role === 'assistant') {
    collector.set(`qwen-code-msg::${effectiveSessionId}::${fallbackId}`, {
      id: `qwen-code-msg::${effectiveSessionId}::${fallbackId}`,
      timestampMs: ts,
      sessionId: effectiveSessionId,
      sessionKey: null,
      agent: projectName,
      provider,
      model,
      channel: 'qwen-code',
      kind: 'assistant',
      sourcePath: filePath,
    })
    return
  }

  if (role === 'TurnBegin' && Array.isArray(payload.user_input)) {
    collector.set(`qwen-code-msg::${effectiveSessionId}::${fallbackId}::user`, {
      id: `qwen-code-msg::${effectiveSessionId}::${fallbackId}::user`,
      timestampMs: ts,
      sessionId: effectiveSessionId,
      sessionKey: null,
      agent: projectName,
      provider,
      model,
      channel: 'qwen-code',
      kind: 'user',
      sourcePath: filePath,
    })
    return
  }

  if (role === 'ContentPart' && payload.type === 'text') {
    collector.set(`qwen-code-msg::${effectiveSessionId}::${fallbackId}::assistant`, {
      id: `qwen-code-msg::${effectiveSessionId}::${fallbackId}::assistant`,
      timestampMs: ts,
      sessionId: effectiveSessionId,
      sessionKey: null,
      agent: projectName,
      provider,
      model,
      channel: 'qwen-code',
      kind: 'assistant',
      sourcePath: filePath,
    })
    return
  }

  if (role === 'ToolCall') {
    const toolId = typeof payload.id === 'string' ? payload.id : fallbackId
    collector.set(`qwen-code-tool-call::${effectiveSessionId}::${toolId}`, {
      id: `qwen-code-tool-call::${effectiveSessionId}::${toolId}`,
      timestampMs: ts,
      sessionId: effectiveSessionId,
      sessionKey: null,
      agent: projectName,
      provider,
      model,
      channel: 'qwen-code',
      kind: 'tool_call',
      sourcePath: filePath,
    })
    return
  }

  if (role === 'ToolResult') {
    const toolCallId = typeof payload.tool_call_id === 'string' ? payload.tool_call_id : fallbackId
    collector.set(`qwen-code-tool-result::${effectiveSessionId}::${toolCallId}`, {
      id: `qwen-code-tool-result::${effectiveSessionId}::${toolCallId}`,
      timestampMs: ts,
      sessionId: effectiveSessionId,
      sessionKey: null,
      agent: projectName,
      provider,
      model,
      channel: 'qwen-code',
      kind: 'tool_result',
      sourcePath: filePath,
    })
  }
}
