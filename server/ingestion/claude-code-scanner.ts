import fs from 'fs'
import path from 'path'
import os from 'os'
import { glob } from 'glob'

export interface ClaudeCodeFileInfo {
  sessionId: string
  project: string
  filePath: string
  isSubagent: boolean
}

export async function discoverClaudeCodeFiles(): Promise<ClaudeCodeFileInfo[]> {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects')
  if (!fs.existsSync(claudeDir)) return []

  const results: ClaudeCodeFileInfo[] = []

  // Find all .jsonl files recursively under ~/.claude/projects/
  const jsonlFiles = await glob('**/*.jsonl', { cwd: claudeDir, absolute: true })

  for (const filePath of jsonlFiles) {
    const rel = path.relative(claudeDir, filePath)
    const parts = rel.split(path.sep)

    // Structure: <project-dir>/<session-uuid>.jsonl
    // Or: <project-dir>/<session-uuid>/subagents/<agent-id>.jsonl
    const project = parts[0] || 'unknown'
    const basename = path.basename(filePath, '.jsonl')
    const isSubagent = parts.includes('subagents')

    // Session ID: for main sessions it's the filename, for subagents use parent dir + agent id
    const sessionId = isSubagent
      ? `${parts[1]}::${basename}`
      : basename

    results.push({
      sessionId,
      project,
      filePath,
      isSubagent,
    })
  }

  return results
}
