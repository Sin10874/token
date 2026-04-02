import fs from 'fs'
import path from 'path'
import os from 'os'
import { glob } from 'glob'
import { DatabaseSync } from 'node:sqlite'

export interface CodexFileInfo {
  sessionId: string
  filePath: string
  source: string
  title: string | null
  cwd: string | null
}

export async function discoverCodexFiles(): Promise<CodexFileInfo[]> {
  const home = os.homedir()
  const sessionsDir = path.join(home, '.codex', 'sessions')
  if (!fs.existsSync(sessionsDir)) return []

  // Load thread metadata from state_5.sqlite for project names
  const threadMeta = new Map<string, { title: string | null; cwd: string | null }>()
  const stateDbPath = path.join(home, '.codex', 'state_5.sqlite')
  if (fs.existsSync(stateDbPath)) {
    try {
      const stateDb = new DatabaseSync(stateDbPath, { readOnly: true })
      const rows = stateDb.prepare('SELECT id, title, cwd FROM threads').all() as { id: string; title: string | null; cwd: string | null }[]
      for (const r of rows) {
        threadMeta.set(r.id, { title: r.title, cwd: r.cwd })
      }
      stateDb.close()
    } catch {}
  }

  const jsonlFiles = await glob('**/*.jsonl', { cwd: sessionsDir, absolute: true })

  const results: CodexFileInfo[] = []
  for (const filePath of jsonlFiles) {
    const basename = path.basename(filePath, '.jsonl')
    const match = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/)
    const sessionId = match ? match[1] : basename

    const meta = threadMeta.get(sessionId)
    results.push({
      sessionId,
      filePath,
      source: '',
      title: meta?.title || null,
      cwd: meta?.cwd || null,
    })
  }

  return results
}
