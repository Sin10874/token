import fs from 'fs'
import path from 'path'
import os from 'os'
import { ParseResult, RawMessageEvent, RawUsageEvent } from './parser.js'

interface KimiWireLine {
  timestamp?: number
  message?: {
    type?: string
    payload?: Record<string, unknown>
  }
}

type TokenUsageRecord = Record<string, unknown> & {
  input_other?: unknown
  output?: unknown
  input_cache_read?: unknown
  input_cache_creation?: unknown
}

function loadDefaultModel(): string {
  const configPath = path.join(os.homedir(), '.kimi', 'config.toml')
  try {
    const content = fs.readFileSync(configPath, 'utf8')
    const match = content.match(/default_model\s*=\s*"([^"]+)"/)
    return match?.[1] || 'kimi-code/kimi-for-coding'
  } catch {
    return 'kimi-code/kimi-for-coding'
  }
}

function inferProjectName(text: string): string | null {
  const projectMatch = text.match(/(?:进入|在)\s*([A-Za-z0-9._-]+)\s*项目/)
  if (projectMatch?.[1]) return projectMatch[1]

  const pathMatch = text.match(/\/Users\/[^/\s]+\/([A-Za-z0-9._-]+)/)
  if (pathMatch?.[1]) return pathMatch[1]

  return null
}

export function parseKimiCodeFile(filePath: string, sessionId: string): ParseResult {
  const events: RawUsageEvent[] = []
  const messages = new Map<string, RawMessageEvent>()
  const warnings: string[] = []
  const defaultModel = loadDefaultModel()
  let currentModel = defaultModel
  let currentProject = 'unknown'
  let firstSeenAt: number | undefined
  let lastSeenAt: number | undefined
  let turnIndex = 0

  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return { events, messages: [], warnings: [`Cannot read ${filePath}`], linesRead: 0, projectName: currentProject }
  }

  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()
    if (!line) continue

    let parsed: KimiWireLine
    try {
      parsed = JSON.parse(line) as KimiWireLine
    } catch {
      warnings.push(`Line ${index + 1}: invalid JSON`)
      continue
    }

    const ts = typeof parsed.timestamp === 'number' ? Math.round(parsed.timestamp * 1000) : null
    if (ts != null) {
      if (!firstSeenAt || ts < firstSeenAt) firstSeenAt = ts
      if (!lastSeenAt || ts > lastSeenAt) lastSeenAt = ts
    }

    const messageType = parsed.message?.type
    const payload = parsed.message?.payload || {}

    if (messageType === 'TurnBegin') {
      turnIndex += 1
      const userInput = payload.user_input
      if (Array.isArray(userInput)) {
        const text = userInput
          .filter((part): part is Record<string, unknown> => !!part && typeof part === 'object')
          .map((part) => typeof part.text === 'string' ? part.text : '')
          .filter(Boolean)
          .join('\n')
        for (const part of userInput) {
          if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
            const inferred = inferProjectName(part.text)
            if (inferred) currentProject = inferred
          }
        }
        if (ts != null && text) {
          messages.set(`kimi-code-msg::${sessionId}::turn-${turnIndex}::user`, {
            id: `kimi-code-msg::${sessionId}::turn-${turnIndex}::user`,
            timestampMs: ts,
            sessionId,
            sessionKey: null,
            agent: currentProject,
            provider: 'moonshot',
            model: currentModel,
            channel: 'kimi-code',
            kind: 'user',
            sourcePath: filePath,
          })
        }
      }
      continue
    }

    if (messageType === 'ToolCall') {
      const functionPayload = payload.function
      if (functionPayload && typeof functionPayload === 'object' && 'arguments' in functionPayload && typeof functionPayload.arguments === 'string') {
        const inferred = inferProjectName(functionPayload.arguments)
        if (inferred) currentProject = inferred
      }
      if (ts != null) {
        const toolId = typeof payload.id === 'string' ? payload.id : `${sessionId}-${index}`
        messages.set(`kimi-code-tool-call::${sessionId}::${toolId}`, {
          id: `kimi-code-tool-call::${sessionId}::${toolId}`,
          timestampMs: ts,
          sessionId,
          sessionKey: null,
          agent: currentProject,
          provider: 'moonshot',
          model: currentModel,
          channel: 'kimi-code',
          kind: 'tool_call',
          sourcePath: filePath,
        })
      }
      continue
    }

    if (messageType === 'ToolResult') {
      if (ts != null) {
        const toolCallId = typeof payload.tool_call_id === 'string' ? payload.tool_call_id : `${sessionId}-${index}`
        messages.set(`kimi-code-tool-result::${sessionId}::${toolCallId}`, {
          id: `kimi-code-tool-result::${sessionId}::${toolCallId}`,
          timestampMs: ts,
          sessionId,
          sessionKey: null,
          agent: currentProject,
          provider: 'moonshot',
          model: currentModel,
          channel: 'kimi-code',
          kind: 'tool_result',
          sourcePath: filePath,
        })
      }
      continue
    }

    if (messageType === 'ContentPart' && ts != null) {
      if (payload.type === 'text' && typeof payload.text === 'string' && payload.text.trim()) {
        messages.set(`kimi-code-msg::${sessionId}::turn-${turnIndex}::assistant`, {
          id: `kimi-code-msg::${sessionId}::turn-${turnIndex}::assistant`,
          timestampMs: ts,
          sessionId,
          sessionKey: null,
          agent: currentProject,
          provider: 'moonshot',
          model: currentModel,
          channel: 'kimi-code',
          kind: 'assistant',
          sourcePath: filePath,
        })
      }
      continue
    }

    if (messageType !== 'StatusUpdate' || ts == null) continue

    const tokenUsage = payload.token_usage
    if (!tokenUsage || typeof tokenUsage !== 'object') continue
    const usage = tokenUsage as TokenUsageRecord

    const inputTokens = Number(usage.input_other || 0)
    const outputTokens = Number(usage.output || 0)
    const cacheReadTokens = Number(usage.input_cache_read || 0)
    const cacheWriteTokens = Number(usage.input_cache_creation || 0)
    const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
    if (totalTokens === 0) continue

    const messageId = typeof payload.message_id === 'string' ? payload.message_id : `${sessionId}-${index}`
    events.push({
      id: `kimi-code::${sessionId}::${messageId}`,
      timestampMs: ts,
      sessionId,
      sessionKey: null,
      agent: currentProject,
      provider: 'moonshot',
      model: currentModel,
      channel: 'kimi-code',
      inputTokens,
      outputTokens,
      reasoningTokens: 0,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      inputCost: 0,
      outputCost: 0,
      reasoningCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      totalCost: 0,
      sourcePath: filePath,
      stopReason: 'end_turn',
    })
  }

  return {
    events,
    messages: Array.from(messages.values()),
    currentModel,
    firstSeenAt,
    lastSeenAt,
    warnings,
    linesRead: lines.length,
    projectName: currentProject,
  }
}
