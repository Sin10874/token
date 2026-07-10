import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { prepareIngestionStateStatements, resolveStartLine } from '../server/ingestion/ingestion-state.ts'
import { parseCodexFile } from '../server/ingestion/codex-parser.ts'
import { PARSER_VERSIONS } from '../server/ingestion/parser-versions.ts'

function testSharedIncrementalParserVersions() {
  assert.deepEqual({
    openclaw: PARSER_VERSIONS.openclaw,
    claudeCode: PARSER_VERSIONS.claudeCode,
    codex: PARSER_VERSIONS.codex,
  }, {
    openclaw: 2,
    claudeCode: 2,
    codex: 3,
  })
}

function testResolveStartLineHonorsParserVersion() {
  const currentVersion = PARSER_VERSIONS.codex
  assert.equal(resolveStartLine(false, undefined, currentVersion), 0)
  assert.equal(resolveStartLine(false, { last_processed_lines: 9 }, currentVersion), 0)
  assert.equal(resolveStartLine(true, {
    last_processed_lines: 9,
    parser_version: currentVersion,
  }, currentVersion), 0)
  assert.equal(resolveStartLine(false, {
    last_processed_lines: 9,
    parser_version: currentVersion - 1,
  }, currentVersion), 0)
  assert.equal(resolveStartLine(false, {
    last_processed_lines: 9,
    parser_version: currentVersion,
  }, currentVersion), 9)
}

function testIngestionStateUpsertPersistsCurrentVersion() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE ingestion_state (
      source_path TEXT PRIMARY KEY,
      last_processed_lines INTEGER DEFAULT 0,
      last_scan_at INTEGER,
      event_count INTEGER DEFAULT 0,
      parser_version INTEGER DEFAULT 1
    )
  `)
  const { getState, upsertState } = prepareIngestionStateStatements(db)

  upsertState.run({
    sourcePath: '/tmp/codex.jsonl',
    lines: 7,
    scanAt: 100,
    eventCount: 1,
    parserVersion: PARSER_VERSIONS.codex,
  })
  assert.deepEqual({ ...getState.get('/tmp/codex.jsonl') as Record<string, unknown> }, {
    source_path: '/tmp/codex.jsonl',
    last_processed_lines: 7,
    last_scan_at: 100,
    event_count: 1,
    parser_version: 3,
  })

  upsertState.run({
    sourcePath: '/tmp/codex.jsonl',
    lines: 8,
    scanAt: 200,
    eventCount: 2,
    parserVersion: PARSER_VERSIONS.codex,
  })
  const updated = getState.get('/tmp/codex.jsonl') as {
    last_processed_lines: number
    parser_version: number
  }
  assert.equal(updated.last_processed_lines, 8)
  assert.equal(updated.parser_version, PARSER_VERSIONS.codex)
}

function codexTokenLine(
  timestamp: string,
  totalUsage: Record<string, number>,
  lastUsage: Record<string, number>,
): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: totalUsage, last_token_usage: lastUsage },
    },
  })
}

function testCodexVersionUpgradeReplaysIdsIdempotentlyAndAddsMissingEvent() {
  const firstUsage = {
    input_tokens: 10,
    cached_input_tokens: 2,
    output_tokens: 5,
    reasoning_output_tokens: 1,
    total_tokens: 15,
  }
  const secondTotal = {
    input_tokens: 20,
    cached_input_tokens: 4,
    output_tokens: 10,
    reasoning_output_tokens: 2,
    total_tokens: 30,
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokend-local-codex-upgrade-'))
  const filePath = path.join(tmpDir, 'session.jsonl')
  fs.writeFileSync(filePath, [
    codexTokenLine('2026-07-10T00:00:01.000Z', firstUsage, firstUsage),
    codexTokenLine('2026-07-10T00:00:02.000Z', secondTotal, firstUsage),
    '',
  ].join('\n'), 'utf8')

  const oldState = { last_processed_lines: 2, parser_version: 2 }
  const startLine = resolveStartLine(false, oldState, PARSER_VERSIONS.codex)
  assert.equal(startLine, 0)
  const replay = parseCodexFile(filePath, 'local-codex', null, '/Users/xinzechao/project', startLine)
  assert.deepEqual(replay.events.map(event => event.id), [
    'codex::local-codex::1',
    'codex::local-codex::2',
  ])

  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE usage_events (id TEXT PRIMARY KEY)')
  db.prepare('INSERT INTO usage_events (id) VALUES (?)').run('codex::local-codex::1')
  const insert = db.prepare('INSERT OR IGNORE INTO usage_events (id) VALUES (?)')
  for (const event of replay.events) insert.run(event.id)
  const ids = db.prepare('SELECT id FROM usage_events ORDER BY id').all() as Array<{ id: string }>
  assert.deepEqual(ids.map(row => row.id), [
    'codex::local-codex::1',
    'codex::local-codex::2',
  ])
}

testSharedIncrementalParserVersions()
testResolveStartLineHonorsParserVersion()
testIngestionStateUpsertPersistsCurrentVersion()
testCodexVersionUpgradeReplaysIdsIdempotentlyAndAddsMissingEvent()
console.log('local ingestion state regression tests passed')
