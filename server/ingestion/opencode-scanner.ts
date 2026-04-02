import fs from 'fs'
import path from 'path'
import os from 'os'
import { glob } from 'glob'

export interface OpencodeFileInfo {
  filePath: string
  sessionId: string
  kind: 'sqlite' | 'json'
}

export async function discoverOpencodeFiles(): Promise<OpencodeFileInfo[]> {
  const dataDir = path.join(os.homedir(), '.local', 'share', 'opencode')
  if (!fs.existsSync(dataDir)) return []

  const dbPath = path.join(dataDir, 'opencode.db')
  if (fs.existsSync(dbPath)) {
    return [{ filePath: dbPath, sessionId: 'opencode-db', kind: 'sqlite' }]
  }

  const messagesDir = path.join(dataDir, 'storage', 'message')
  if (!fs.existsSync(messagesDir)) return []

  const files = await glob('ses_*/*.json', { cwd: messagesDir, absolute: true })
  return files.map((filePath) => ({
    filePath,
    sessionId: path.basename(path.dirname(filePath)),
    kind: 'json' as const,
  }))
}
