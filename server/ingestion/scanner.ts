import fs from 'fs'
import path from 'path'
import os from 'os'
import { glob } from 'glob'

export interface SessionFileInfo {
  sessionId: string
  agent: string
  filePath: string
  sessionKey?: string
  channel?: string
}

// Parse sessions.json index to extract channel info per sessionId
function parseSessionsIndex(filePath: string): Map<string, { channel: string; sessionKey: string }> {
  const map = new Map<string, { channel: string; sessionKey: string }>()
  try {
    if (!fs.existsSync(filePath)) return map
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    for (const [key, value] of Object.entries(data)) {
      const v = value as Record<string, unknown>
      const sessionId = v.sessionId as string
      if (!sessionId) continue
      const deliveryCtx = v.deliveryContext as Record<string, string> | undefined
      const channel =
        (v.lastChannel as string) ||
        deliveryCtx?.channel ||
        // Fallback: parse from session key (e.g. "agent:main:openclaw-weixin:..." → "weixin")
        (() => {
          const parts = key.split(':')
          if (parts.length >= 3 && parts[2] !== 'main') {
            const raw = parts[2]
            return raw.replace(/^openclaw-/, '').replace(/^agent:/, '')
          }
          return key === 'agent:main:main' ? 'webchat' : 'unknown'
        })()
      map.set(sessionId, { channel, sessionKey: key })
    }
  } catch (_e) {
    // Non-fatal
  }
  return map
}

/**
 * Read the first line of a JSONL session file to infer channel.
 * OpenClaw internal tasks (heartbeat, cron) run from .openclaw/workspace
 * and don't get registered in sessions.json.
 */
function inferChannelFromJsonl(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const firstNewline = content.indexOf('\n')
    const firstLine = firstNewline > 0 ? content.slice(0, firstNewline) : content
    const parsed = JSON.parse(firstLine)
    if (parsed.type !== 'session') return null

    // If it has a channel field, use it
    if (parsed.channel && typeof parsed.channel === 'string') return parsed.channel

    // If cwd is the openclaw workspace, it's an internal cron/heartbeat task
    const cwd = parsed.cwd as string | undefined
    if (cwd && cwd.includes('.openclaw/workspace')) return 'cron'

    return null
  } catch {
    return null
  }
}

export async function discoverSessionFiles(): Promise<SessionFileInfo[]> {
  const openclawDir = path.join(os.homedir(), '.openclaw', 'agents')
  if (!fs.existsSync(openclawDir)) return []

  const agentDirs = fs
    .readdirSync(openclawDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  const results: SessionFileInfo[] = []

  for (const agent of agentDirs) {
    const sessionsDir = path.join(openclawDir, agent, 'sessions')
    if (!fs.existsSync(sessionsDir)) continue

    // Load sessions.json for channel info
    const sessionsJson = path.join(sessionsDir, 'sessions.json')
    const sessionMap = parseSessionsIndex(sessionsJson)

    // Find all .jsonl files
    const jsonlFiles = await glob('*.jsonl', { cwd: sessionsDir, absolute: true })

    for (const filePath of jsonlFiles) {
      const sessionId = path.basename(filePath, '.jsonl')
      const meta = sessionMap.get(sessionId)
      let channel = meta?.channel
      let sessionKey = meta?.sessionKey

      // Fallback: when sessions.json doesn't have this session,
      // read the JSONL header line to infer channel from context
      if (!channel || channel === 'unknown') {
        channel = inferChannelFromJsonl(filePath) || 'unknown'
      }

      results.push({
        sessionId,
        agent,
        filePath,
        sessionKey,
        channel,
      })
    }
  }

  return results
}
