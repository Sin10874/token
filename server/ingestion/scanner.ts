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
      results.push({
        sessionId,
        agent,
        filePath,
        sessionKey: meta?.sessionKey,
        channel: meta?.channel || 'unknown',
      })
    }
  }

  return results
}
