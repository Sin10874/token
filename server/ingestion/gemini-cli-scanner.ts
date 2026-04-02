import fs from 'fs'
import path from 'path'
import os from 'os'
import { glob } from 'glob'

export interface GeminiCliFileInfo {
  sessionId: string
  filePath: string
}

export async function discoverGeminiCliFiles(): Promise<GeminiCliFileInfo[]> {
  const baseDir = path.join(os.homedir(), '.gemini', 'tmp')
  if (!fs.existsSync(baseDir)) return []

  const files = await glob('*/chats/session-*.json', { cwd: baseDir, absolute: true })
  return files.map((filePath) => ({
    sessionId: path.basename(filePath, '.json'),
    filePath,
  }))
}
