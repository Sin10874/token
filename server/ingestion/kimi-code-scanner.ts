import fs from 'fs'
import path from 'path'
import os from 'os'
import { glob } from 'glob'

export interface KimiCodeFileInfo {
  sessionId: string
  filePath: string
}

export async function discoverKimiCodeFiles(): Promise<KimiCodeFileInfo[]> {
  const baseDir = path.join(os.homedir(), '.kimi', 'sessions')
  if (!fs.existsSync(baseDir)) return []

  const files = await glob('*/*/wire.jsonl', { cwd: baseDir, absolute: true })
  return files.map((filePath) => ({
    sessionId: path.basename(path.dirname(filePath)),
    filePath,
  }))
}
