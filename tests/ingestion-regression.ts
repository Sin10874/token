import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseCodexFile } from '../server/ingestion/codex-parser.ts'
import { parseGeminiCliFile } from '../server/ingestion/gemini-cli-parser.ts'
import { parseCopilotCliFile } from '../server/ingestion/copilot-cli-parser.ts'
import { parseOpencodeFile } from '../server/ingestion/opencode-parser.ts'
import { rebuildSessionsFromUsage, upsertSessionSnapshot } from '../server/ingestion/session-upsert.ts'

function testCodexParserNormalizesOpenAIUsage() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmeter-codex-'))
  const filePath = path.join(tmpDir, 'session.jsonl')
  const lines = [
    JSON.stringify({
      timestamp: '2026-04-02T03:31:49.000Z',
      type: 'session_meta',
      payload: { cwd: '/Users/xinzechao/project-a' },
    }),
    JSON.stringify({
      timestamp: '2026-04-02T03:32:00.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-5.4', cwd: '/Users/xinzechao/project-a' },
    }),
    JSON.stringify({
      timestamp: '2026-04-02T03:33:00.815Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 25351,
            cached_input_tokens: 13184,
            output_tokens: 282,
            reasoning_output_tokens: 90,
            total_tokens: 25633,
          },
          last_token_usage: {
            input_tokens: 25351,
            cached_input_tokens: 13184,
            output_tokens: 282,
            reasoning_output_tokens: 90,
            total_tokens: 25633,
          },
        },
      },
    }),
  ]

  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8')
  const result = parseCodexFile(filePath, 'codex-session', 'Thread', '/Users/xinzechao/project-a')

  assert.equal(result.events.length, 1)
  const event = result.events[0]
  assert.equal(event.inputTokens, 12167)
  assert.equal(event.outputTokens, 282)
  assert.equal(event.cacheReadTokens, 13184)
  assert.equal(event.totalTokens, 25633)
}

function testSessionUpsertUsesAuthoritativeUsageTotals() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE usage_events (
      id TEXT PRIMARY KEY,
      timestamp_ms INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      session_key TEXT,
      agent TEXT,
      provider TEXT,
      model TEXT,
      channel TEXT,
      total_tokens INTEGER DEFAULT 0,
      total_cost REAL DEFAULT 0
    );

    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      session_key TEXT,
      agent TEXT,
      channel TEXT,
      first_seen_at INTEGER,
      last_seen_at INTEGER,
      current_model TEXT,
      call_count INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      total_cost REAL DEFAULT 0,
      source_path TEXT
    );
  `)

  db.exec(`
    INSERT INTO usage_events (id, timestamp_ms, session_id, session_key, agent, provider, model, channel, total_tokens, total_cost)
    VALUES
      ('e1', 1000, 's1', 'key-1', 'agent-1', 'openai', 'gpt-5.4', 'codex', 10, 1.5),
      ('e2', 2000, 's1', 'key-1', 'agent-1', 'openai', 'gpt-5.4', 'codex', 20, 2.5);

    INSERT INTO sessions (session_id, call_count, total_tokens, total_cost)
    VALUES ('s1', 99, 999, 999.0);
  `)

  const fallback = {
    sessionId: 's1',
    sessionKey: 'key-1',
    agent: 'agent-1',
    channel: 'codex',
    currentModel: 'gpt-5.4',
    sourcePath: '/tmp/session.jsonl',
  }

  assert.equal(upsertSessionSnapshot(db, fallback), true)
  assert.equal(upsertSessionSnapshot(db, fallback), true)

  const row = db.prepare(`
    SELECT call_count as callCount, total_tokens as totalTokens, total_cost as totalCost, current_model as currentModel
    FROM sessions
    WHERE session_id = 's1'
  `).get() as { callCount: number; totalTokens: number; totalCost: number; currentModel: string }

  assert.equal(row.callCount, 2)
  assert.equal(row.totalTokens, 30)
  assert.equal(row.totalCost, 4)
  assert.equal(row.currentModel, 'gpt-5.4')
}

function testRebuildSessionsDropsOrphansAndRecalculatesAllRows() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE usage_events (
      id TEXT PRIMARY KEY,
      timestamp_ms INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      session_key TEXT,
      agent TEXT,
      provider TEXT,
      model TEXT,
      channel TEXT,
      total_tokens INTEGER DEFAULT 0,
      total_cost REAL DEFAULT 0,
      source_path TEXT
    );

    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      session_key TEXT,
      agent TEXT,
      channel TEXT,
      first_seen_at INTEGER,
      last_seen_at INTEGER,
      current_model TEXT,
      call_count INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      total_cost REAL DEFAULT 0,
      source_path TEXT
    );
  `)

  db.exec(`
    INSERT INTO usage_events (id, timestamp_ms, session_id, session_key, agent, provider, model, channel, total_tokens, total_cost, source_path)
    VALUES
      ('e1', 1000, 'live', 'key-live', 'agent-live', 'openai', 'gpt-5.4', 'codex', 10, 1.5, '/tmp/live.jsonl'),
      ('e2', 2000, 'live', 'key-live', 'agent-live', 'openai', 'gpt-5.4-mini', 'codex', 20, 2.5, '/tmp/live.jsonl');

    INSERT INTO sessions (session_id, call_count, total_tokens, total_cost)
    VALUES
      ('live', 99, 999, 999.0),
      ('orphan', 1, 1, 1.0);
  `)

  assert.equal(rebuildSessionsFromUsage(db), 1)

  const rows = (db.prepare(`
    SELECT session_id as sessionId, call_count as callCount, total_tokens as totalTokens, total_cost as totalCost, current_model as currentModel
    FROM sessions
    ORDER BY session_id
  `).all() as Array<{ sessionId: string; callCount: number; totalTokens: number; totalCost: number; currentModel: string }>).map(row => ({ ...row }))

  assert.deepEqual(rows, [
    { sessionId: 'live', callCount: 2, totalTokens: 30, totalCost: 4, currentModel: 'gpt-5.4-mini' },
  ])
}

function testGeminiCliParserNormalizesCachedAndThoughtTokens() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmeter-gemini-'))
  const filePath = path.join(tmpDir, 'session.json')
  fs.writeFileSync(filePath, JSON.stringify({
    sessionId: 'gemini-session',
    messages: [
      { id: 'u1', timestamp: '2025-12-09T06:16:43.056Z', role: 'user', content: 'hello' },
      {
        id: 'a1',
        timestamp: '2025-12-09T06:16:47.432Z',
        type: 'gemini',
        model: 'gemini-2.5-pro',
        tokens: { input: 8112, output: 16, cached: 6347, thoughts: 60, total: 8188 },
      },
    ],
  }), 'utf8')

  const result = parseGeminiCliFile(filePath, 'gemini-session')
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].inputTokens, 1765)
  assert.equal(result.events[0].outputTokens, 0)
  assert.equal(result.events[0].cacheReadTokens, 6347)
  assert.equal(result.events[0].totalTokens, 8188)
}

function testCopilotCliParserSeparatesCacheReadAndWrite() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmeter-copilot-'))
  const filePath = path.join(tmpDir, 'events.jsonl')
  fs.writeFileSync(filePath, [
    JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'session.start',
      data: { context: { cwd: '/Users/xinzechao/copilot-app' } },
    }),
    JSON.stringify({
      timestamp: '2026-01-01T00:00:10.000Z',
      type: 'session.shutdown',
      data: {
        modelMetrics: {
          'gpt-4.1': {
            usage: { inputTokens: 1000, cacheReadTokens: 300, cacheWriteTokens: 200, outputTokens: 400 },
          },
        },
      },
    }),
  ].join('\n'), 'utf8')

  const result = parseCopilotCliFile(filePath, 'copilot-session')
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].inputTokens, 700)
  assert.equal(result.events[0].cacheReadTokens, 300)
  assert.equal(result.events[0].cacheWriteTokens, 200)
  assert.equal(result.events[0].totalTokens, 1600)
}

function testOpencodeJsonParserIncludesReasoningAndCacheWrite() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmeter-opencode-'))
  const sessionDir = path.join(tmpDir, 'ses_123')
  fs.mkdirSync(sessionDir, { recursive: true })
  const filePath = path.join(sessionDir, 'msg_1.json')
  fs.writeFileSync(filePath, JSON.stringify({
    id: 'msg_1',
    sessionID: 'ses_123',
    role: 'assistant',
    time: { created: 1768715098162 },
    modelID: 'minimax-m2.1-free',
    providerID: 'opencode',
    path: { root: '/Users/xinzechao/opencode_test' },
    tokens: { input: 88, output: 181, reasoning: 3, cache: { read: 517, write: 25501 } },
    finish: 'tool-calls',
  }), 'utf8')

  const result = parseOpencodeFile({ filePath, sessionId: 'ses_123', kind: 'json' })
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].inputTokens, 88)
  assert.equal(result.events[0].outputTokens, 181)
  assert.equal(result.events[0].cacheReadTokens, 517)
  assert.equal(result.events[0].cacheWriteTokens, 25501)
  assert.equal(result.events[0].totalTokens, 26290)
}

testCodexParserNormalizesOpenAIUsage()
testSessionUpsertUsesAuthoritativeUsageTotals()
testRebuildSessionsDropsOrphansAndRecalculatesAllRows()
testGeminiCliParserNormalizesCachedAndThoughtTokens()
testCopilotCliParserSeparatesCacheReadAndWrite()
testOpencodeJsonParserIncludesReasoningAndCacheWrite()
console.log('ingestion regression tests passed')
