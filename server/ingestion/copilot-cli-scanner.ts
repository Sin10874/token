import fs from 'fs'
import path from 'path'
import os from 'os'

export interface CopilotCliFileInfo {
  sessionId: string
  filePath: string
}

export async function discoverCopilotCliFiles(): Promise<CopilotCliFileInfo[]> {
  const baseDir = path.join(os.homedir(), '.copilot', 'session-state')
  if (!fs.existsSync(baseDir)) return []

  const entries = fs.readdirSync(baseDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  return entries
    .map((entry) => ({
      sessionId: entry.name,
      filePath: path.join(baseDir, entry.name, 'events.jsonl'),
    }))
    .filter((entry) => fs.existsSync(entry.filePath))
}
