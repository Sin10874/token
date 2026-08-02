import fs from 'fs'
import path from 'path'
import os from 'os'
import { glob } from 'glob'

export interface QwenCodeFileInfo {
  sessionId: string
  filePath: string
}

const CANDIDATE_GLOBS = [
  path.join(os.homedir(), '.qwen', 'sessions', '**', '*.jsonl'),
  path.join(os.homedir(), '.qwen', 'sessions', '**', '*.json'),
  path.join(os.homedir(), '.qwen', 'history', '**', '*.jsonl'),
  path.join(os.homedir(), '.qwen', 'history', '**', '*.json'),
  path.join(os.homedir(), '.local', 'share', 'qwen', '**', '*.jsonl'),
  path.join(os.homedir(), '.local', 'share', 'qwen', '**', '*.json'),
]

export async function discoverQwenCodeFiles(): Promise<QwenCodeFileInfo[]> {
  const files = new Set<string>()
  for (const pattern of CANDIDATE_GLOBS) {
    const matches = await glob(pattern, { absolute: true })
    for (const filePath of matches) {
      if (!fs.existsSync(filePath)) continue
      files.add(filePath)
    }
  }

  return [...files].map((filePath) => ({
    sessionId: path.basename(filePath).replace(/\.(jsonl|json)$/i, ''),
    filePath,
  }))
}
