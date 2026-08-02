import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseCodexFile } from '../server/ingestion/codex-parser.ts'
import { parseClaudeCodeFile } from '../server/ingestion/claude-code-parser.ts'
import { parseGeminiCliFile } from '../server/ingestion/gemini-cli-parser.ts'
import { parseCopilotCliFile } from '../server/ingestion/copilot-cli-parser.ts'
import { parseOpencodeFile } from '../server/ingestion/opencode-parser.ts'
import { parseKimiCodeFile } from '../server/ingestion/kimi-code-parser.ts'
import { parseQwenCodeFile } from '../server/ingestion/qwen-code-parser.ts'
import { resetDerivedUsageData, resolvePricedModelId, resolveStartLine } from '../server/ingestion/index.ts'
import { resolveOfficialPriceOverride } from '../server/db/model-price-overrides.ts'
import { rebuildSessionsFromUsage, upsertSessionSnapshot } from '../server/ingestion/session-upsert.ts'
import {
  getDashboardDailyRows,
  getDashboardSummaryRows,
  getDashboardTopConversations,
  getDashboardTopProjects,
} from '../server/api/dashboard-metrics.ts'
import { getModelsList } from '../server/api/model-list.ts'
import { getPlatformOverviewData } from '../server/api/platform-overview.ts'
import { getPlatformsSummary } from '../server/api/platform-summary.ts'

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
  assert.equal(event.outputTokens, 192)
  assert.equal(event.reasoningTokens, 90)
  assert.equal(event.cacheReadTokens, 13184)
  assert.equal(event.totalTokens, 25633)
}

function testClaudeCodeParserKeepsSessionRootProjectWhenCwdEntersSubdir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmeter-claude-code-'))
  const filePath = path.join(tmpDir, 'session.jsonl')
  fs.writeFileSync(filePath, [
    JSON.stringify({
      sessionId: 'cc-session',
      cwd: '/Users/xinzechao/One/desktop/src-tauri',
      version: '1.0.0',
      timestamp: '2026-04-06T01:00:00.000Z',
      type: 'assistant',
      uuid: 'msg-1',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6',
        usage: {
          input_tokens: 120,
          output_tokens: 80,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 20,
        },
      },
    }),
  ].join('\n'), 'utf8')

  const result = parseClaudeCodeFile(filePath, 'cc-session', '-Users-xinzechao-One')
  assert.equal(result.events.length, 1)
  assert.equal(result.projectName, 'One')
  assert.equal(result.events[0].agent, 'One')
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
      title TEXT,
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
      title TEXT,
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

function testResolveStartLineReindexesWhenParserVersionChanges() {
  assert.equal(resolveStartLine(false, undefined, 2), 0)
  assert.equal(resolveStartLine(true, { last_processed_lines: 999, parser_version: 2 }, 2), 0)
  assert.equal(resolveStartLine(false, { last_processed_lines: 999, parser_version: 1 }, 2), 0)
  assert.equal(resolveStartLine(false, { last_processed_lines: 999, parser_version: 2 }, 2), 999)
}

function testOfficialPriceOverrideCorrectsClaudeOpus46() {
  const overridden = resolveOfficialPriceOverride('claude-opus-4-6', {
    input_price: 15,
    output_price: 75,
    cache_read_price: 1.5,
    cache_write_price: 18.75,
  })
  assert.deepEqual(overridden, {
    input_price: 5,
    output_price: 25,
    cache_read_price: 0.5,
    cache_write_price: 6.25,
  })

  const untouched = resolveOfficialPriceOverride('claude-sonnet-4-6', {
    input_price: 3,
    output_price: 15,
    cache_read_price: 0.3,
    cache_write_price: 3.75,
  })
  assert.deepEqual(untouched, {
    input_price: 3,
    output_price: 15,
    cache_read_price: 0.3,
    cache_write_price: 3.75,
  })
}

function testResolvePricedModelIdMapsKnownAliases() {
  assert.equal(resolvePricedModelId('k2p5'), 'kimi-k2.5')
  assert.equal(resolvePricedModelId('kimi-code/kimi-for-coding'), 'kimi-k2.5')
  assert.equal(resolvePricedModelId('kimi-for-coding'), 'kimi-k2.5')
  assert.equal(resolvePricedModelId('kimi-k2-thinking'), 'kimi-k2.5')
  assert.equal(resolvePricedModelId('deepseek-chat'), 'deepseek-v4-flash')
  assert.equal(resolvePricedModelId('deepseek-reasoner'), 'deepseek-v4-flash')
  assert.equal(resolvePricedModelId('mimo-v2-flash'), 'mimo-v2.5')
  assert.equal(resolvePricedModelId('mimo-v2-omni'), 'mimo-v2.5')
  assert.equal(resolvePricedModelId('mimo-v2-pro'), 'mimo-v2.5-pro')
  assert.equal(resolvePricedModelId('GLM-5.2'), 'glm-5.2')
  assert.equal(resolvePricedModelId('Pro/zai-org/GLM-5'), 'glm-5')
  assert.equal(resolvePricedModelId('zhanlu/glm-4.7'), 'glm-4.7')
  assert.equal(resolvePricedModelId('minimax-m2.5'), 'MiniMax-M2.5')
  assert.equal(resolvePricedModelId('minimax-m2.7-highspeed'), 'MiniMax-M2.7-highspeed')
  assert.equal(resolvePricedModelId('M-2.7'), 'MiniMax-M2.7')
  assert.equal(resolvePricedModelId('claude-sonnet-4-6'), 'claude-sonnet-4-6')
}

function testResetDerivedUsageDataClearsReindexTables() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE usage_events (id TEXT PRIMARY KEY);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
    CREATE TABLE ingestion_state (source_path TEXT PRIMARY KEY);
    CREATE TABLE source_warnings (id INTEGER PRIMARY KEY AUTOINCREMENT, source_path TEXT, warning TEXT, created_at INTEGER);

    INSERT INTO usage_events (id) VALUES ('e1');
    INSERT INTO sessions (session_id) VALUES ('s1');
    INSERT INTO ingestion_state (source_path) VALUES ('/tmp/a.jsonl');
    INSERT INTO source_warnings (source_path, warning, created_at) VALUES ('/tmp/a.jsonl', 'warn', 1);
  `)

  resetDerivedUsageData(db)

  assert.equal((db.prepare('SELECT COUNT(*) as c FROM usage_events').get() as { c: number }).c, 0)
  assert.equal((db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c, 0)
  assert.equal((db.prepare('SELECT COUNT(*) as c FROM ingestion_state').get() as { c: number }).c, 0)
  assert.equal((db.prepare('SELECT COUNT(*) as c FROM source_warnings').get() as { c: number }).c, 0)
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
  assert.equal(result.events[0].reasoningTokens, 60)
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
  assert.equal(result.events[0].reasoningTokens, 3)
  assert.equal(result.events[0].cacheReadTokens, 517)
  assert.equal(result.events[0].cacheWriteTokens, 25501)
  assert.equal(result.events[0].totalTokens, 26290)
}

function testDashboardMetricsUseActiveUsageForHomepage() {
  const db = new DatabaseSync(':memory:')
  const now = Date.now()
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
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      input_cost REAL DEFAULT 0,
      output_cost REAL DEFAULT 0,
      reasoning_cost REAL DEFAULT 0,
      cache_read_cost REAL DEFAULT 0,
      cache_write_cost REAL DEFAULT 0,
      total_cost REAL DEFAULT 0,
      stop_reason TEXT
    );
  `)

  db.exec(`
    INSERT INTO usage_events (
      id, timestamp_ms, session_id, agent, provider, model, channel,
      input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
      total_tokens, input_cost, output_cost, reasoning_cost, cache_read_cost, cache_write_cost, total_cost, stop_reason
    ) VALUES
      ('e1', ${now - 1000}, 's1', 'proj', 'openai', 'gpt-5.4', 'codex', 100, 50, 40, 300, 20, 510, 1.0, 2.0, 1.6, 0.3, 0.1, 5.0, 'end_turn'),
      ('e2', ${now}, 's2', 'proj', 'anthropic', 'claude-opus-4-6', 'claude-code', 10, 5, 0, 90, 30, 135, 0.4, 0.8, 0, 0.09, 0.03, 1.32, 'end_turn');
  `)

  const summary = getDashboardSummaryRows(db, 0, -1, 0)
  assert.equal(summary.current.totalTokens, 165)
  assert.equal(summary.current.inputTokens, 110)
  assert.equal(summary.current.outputTokens, 55)
  assert.equal(summary.current.cacheTokens, 390)
  assert.ok(Math.abs(summary.current.totalCost - 4.59) < 1e-9)

  const daily = getDashboardDailyRows(db, 1)
  assert.equal(daily.length, 1)
  assert.equal(daily[0].tokens, 165)
  assert.ok(Math.abs(daily[0].cost - 4.59) < 1e-9)
  assert.equal(daily[0].cacheReadTokens, 390)
  assert.equal(daily[0].cacheWriteTokens, 50)
}

function testPlatformsSummarySortsByCostAndUsesCacheReadCost() {
  const db = new DatabaseSync(':memory:')
  const now = Date.now()
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
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      input_cost REAL DEFAULT 0,
      output_cost REAL DEFAULT 0,
      reasoning_cost REAL DEFAULT 0,
      cache_read_cost REAL DEFAULT 0,
      cache_write_cost REAL DEFAULT 0,
      total_cost REAL DEFAULT 0,
      stop_reason TEXT
    );
  `)

  db.exec(`
    INSERT INTO usage_events (
      id, timestamp_ms, session_id, channel, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost, stop_reason
    ) VALUES
      ('e1', ${now}, 's1', 'claude-code', 'claude-sonnet-4-6', 100, 50, 200, 999, 1.0, 2.0, 3.0, 50.0, 56.0, 'end_turn'),
      ('e2', ${now}, 's2', 'codex', 'gpt-5.4', 80, 40, 10, 0, 0.8, 1.2, 0.5, 0, 2.5, 'tool_use'),
      ('e3', ${now}, 's3', 'feishu', 'MiniMax-M2.7', 10, 5, 25, 1000, 5.0, 4.0, 3.0, 8.0, 20.0, 'end_turn');
  `)

  const result = getPlatformsSummary(db, '1d')
  assert.equal(result.period, '1d')
  const openclaw = result.items.find((item) => item.product === 'openclaw')
  const claudeCode = result.items.find((item) => item.product === 'claude-code')
  const codex = result.items.find((item) => item.product === 'codex')
  const hermes = result.items.find((item) => item.product === 'hermes')
  assert.ok(openclaw)
  assert.ok(claudeCode)
  assert.ok(codex)
  assert.ok(hermes)
  assert.equal(claudeCode!.current.totalTokens, 150)
  assert.equal(claudeCode!.current.cacheReadTokens, 200)
  assert.equal(claudeCode!.current.messageCount, 1)
  assert.equal(claudeCode!.current.userMessageCount, 1)
  assert.equal(codex!.current.messageCount, 1)
  assert.equal(codex!.current.userMessageCount, 0)
  assert.equal(openclaw!.current.messageCount, 1)
  assert.equal(openclaw!.current.userMessageCount, 1)
  assert.equal(hermes!.current.totalTokens, 0)
  assert.ok(Math.abs(openclaw!.current.totalCost - 12) < 1e-9)
  assert.ok(Math.abs(claudeCode!.current.totalCost - 6) < 1e-9)
  assert.ok(Math.abs(codex!.current.totalCost - 2.5) < 1e-9)
}

function testModelsListSupportsPeriodFiltering() {
  const db = new DatabaseSync(':memory:')
  const now = Date.now()
  const threeDaysAgo = now - 3 * 24 * 3600_000
  const twentyDaysAgo = now - 20 * 24 * 3600_000
  const fortyDaysAgo = now - 40 * 24 * 3600_000

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
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      input_cost REAL DEFAULT 0,
      output_cost REAL DEFAULT 0,
      reasoning_cost REAL DEFAULT 0,
      cache_read_cost REAL DEFAULT 0,
      cache_write_cost REAL DEFAULT 0,
      total_cost REAL DEFAULT 0,
      stop_reason TEXT
    );
  `)

  db.exec(`
    INSERT INTO usage_events (
      id, timestamp_ms, session_id, provider, model, channel,
      input_tokens, output_tokens, cache_read_tokens, total_tokens, total_cost
    ) VALUES
      ('m1', ${now}, 's1', 'anthropic', 'claude-opus-4-6', 'claude-code', 100, 50, 25, 175, 6.5),
      ('m2', ${threeDaysAgo}, 's2', 'openai', 'gpt-5.4', 'codex', 70, 30, 10, 110, 3.2),
      ('m3', ${twentyDaysAgo}, 's3', 'moonshot', 'kimi-k2.5', 'kimi-code', 40, 20, 5, 65, 1.1),
      ('m4', ${fortyDaysAgo}, 's4', 'google', 'gemini-2.5-pro', 'gemini-cli', 90, 10, 0, 100, 0.9);
  `)

  const oneDay = getModelsList(db, '1d')
  assert.deepEqual(oneDay.map((row) => row.model), ['claude-opus-4-6'])

  const sevenDays = getModelsList(db, '7d')
  assert.deepEqual(sevenDays.map((row) => row.model), ['claude-opus-4-6', 'gpt-5.4'])

  const thirtyDays = getModelsList(db, '30d')
  assert.deepEqual(thirtyDays.map((row) => row.model), ['claude-opus-4-6', 'gpt-5.4', 'kimi-k2.5'])

  const allTime = getModelsList(db)
  assert.deepEqual(allTime.map((row) => row.model), ['claude-opus-4-6', 'gpt-5.4', 'gemini-2.5-pro', 'kimi-k2.5'])
}

function testDashboardTopListsSplitProjectsAndConversations() {
  const db = new DatabaseSync(':memory:')
  const now = Date.now()
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
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      input_cost REAL DEFAULT 0,
      output_cost REAL DEFAULT 0,
      reasoning_cost REAL DEFAULT 0,
      cache_read_cost REAL DEFAULT 0,
      cache_write_cost REAL DEFAULT 0,
      total_cost REAL DEFAULT 0,
      source_path TEXT,
      stop_reason TEXT
    );

    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      session_key TEXT,
      agent TEXT,
      title TEXT,
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
    INSERT INTO usage_events (
      id, timestamp_ms, session_id, session_key, agent, provider, model, channel,
      input_tokens, output_tokens, cache_read_tokens, total_tokens,
      input_cost, output_cost, cache_read_cost, total_cost, source_path, stop_reason
    ) VALUES
      ('codex-1-a', ${now - 4000}, 'codex-1', NULL, 'One', 'openai', 'gpt-5.4', 'codex', 300, 100, 0, 400, 1.2, 1.8, 0, 3.0, '/tmp/codex-1.jsonl', 'end_turn'),
      ('codex-1-b', ${now - 2000}, 'codex-1', NULL, 'One', 'openai', 'gpt-5.4', 'codex', 250, 150, 0, 400, 1.1, 1.9, 0, 3.0, '/tmp/codex-1.jsonl', 'end_turn'),
      ('codex-2-a', ${now - 3000}, 'codex-2', NULL, 'One', 'openai', 'gpt-5.4-mini', 'codex', 200, 100, 0, 300, 0.8, 1.2, 0, 2.0, '/tmp/codex-2.jsonl', 'end_turn'),
      ('cc-1-a', ${now - 1000}, 'cc-1', NULL, 'knowledge-clip', 'anthropic', 'claude-sonnet-4-6', 'claude-code', 400, 200, 50, 650, 1.5, 2.5, 0.4, 4.4, '/tmp/cc-1.jsonl', 'end_turn'),
      ('oc-1-a', ${now - 500}, 'oc-1', 'agent:main:feishu:ceo:direct:ou_1', 'main', 'minimax', 'MiniMax-M2.7', 'feishu', 500, 200, 20, 720, 0.4, 0.8, 0.1, 1.3, '/tmp/oc-1.jsonl', 'end_turn');

    INSERT INTO sessions (
      session_id, session_key, agent, title, channel, first_seen_at, last_seen_at, current_model, call_count, total_tokens, total_cost, source_path
    ) VALUES
      ('codex-1', NULL, 'One', 'Fix landing page', 'codex', ${now - 4000}, ${now - 2000}, 'gpt-5.4', 2, 800, 6.0, '/tmp/codex-1.jsonl'),
      ('codex-2', NULL, 'One', 'Review onboarding flow', 'codex', ${now - 3000}, ${now - 3000}, 'gpt-5.4-mini', 1, 300, 2.0, '/tmp/codex-2.jsonl'),
      ('cc-1', NULL, 'knowledge-clip', NULL, 'claude-code', ${now - 1000}, ${now - 1000}, 'claude-sonnet-4-6', 1, 650, 4.4, '/tmp/cc-1.jsonl'),
      ('oc-1', 'agent:main:feishu:ceo:direct:ou_1', 'main', NULL, 'feishu', ${now - 500}, ${now - 500}, 'MiniMax-M2.7', 1, 720, 1.3, '/tmp/oc-1.jsonl');
  `)

  const projects = getDashboardTopProjects(db, 0)
  assert.deepEqual(projects.map((row) => ({
    project: row.project,
    channel: row.channel,
    tokens: row.tokens,
    cost: Number(row.cost.toFixed(4)),
  })), [
    { project: 'One', channel: 'codex', tokens: 1100, cost: 8 },
    { project: 'main', channel: 'feishu', tokens: 700, cost: 1.3 },
    { project: 'knowledge-clip', channel: 'claude-code', tokens: 600, cost: 4.4 },
  ])

  const conversations = getDashboardTopConversations(db, 0, { ceo: 'COS' })
  assert.deepEqual(conversations.map((row) => ({
    sessionId: row.session_id,
    title: row.title,
    channel: row.channel,
    tokens: row.tokens,
    cost: Number(row.cost.toFixed(4)),
  })), [
    { sessionId: 'codex-1', title: 'Fix landing page', channel: 'codex', tokens: 800, cost: 6 },
    { sessionId: 'oc-1', title: 'COS', channel: 'feishu', tokens: 700, cost: 1.3 },
    { sessionId: 'cc-1', title: 'knowledge-clip', channel: 'claude-code', tokens: 600, cost: 4.4 },
    { sessionId: 'codex-2', title: 'Review onboarding flow', channel: 'codex', tokens: 300, cost: 2 },
  ])
}

function testPlatformOverviewUsesActiveMetricsAndNormalizedProjects() {
  const db = new DatabaseSync(':memory:')
  const now = Date.now()
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
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      input_cost REAL DEFAULT 0,
      output_cost REAL DEFAULT 0,
      reasoning_cost REAL DEFAULT 0,
      cache_read_cost REAL DEFAULT 0,
      cache_write_cost REAL DEFAULT 0,
      total_cost REAL DEFAULT 0,
      source_path TEXT,
      stop_reason TEXT
    );

    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      session_key TEXT,
      agent TEXT,
      title TEXT,
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
    INSERT INTO sessions (
      session_id, session_key, agent, title, channel, first_seen_at, last_seen_at, current_model, call_count, total_tokens, total_cost, source_path
    ) VALUES (
      'claude-s1', 'claude-key', 'wiki', '修 wiki 页面', 'claude-code', ${now - 2000}, ${now}, 'claude-opus-4-6', 2, 9999, 99.9, '/tmp/claude-s1.jsonl'
    );

    INSERT INTO usage_events (
      id, timestamp_ms, session_id, session_key, agent, provider, model, channel,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
      input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost, stop_reason
    ) VALUES
      ('e1', ${now - 1000}, 'claude-s1', 'claude-key', 'raw', 'anthropic', 'claude-opus-4-6', 'claude-code', 100, 50, 200, 40, 390, 1.0, 2.0, 0.5, 7.0, 10.5, 'end_turn'),
      ('e2', ${now}, 'claude-s1', 'claude-key', 'raw', 'anthropic', 'claude-opus-4-6', 'claude-code', 20, 10, 60, 30, 120, 0.2, 0.4, 0.1, 3.0, 3.7, 'tool_use');
  `)

  const overview = getPlatformOverviewData(db, 'claude-code', '1d')

  assert.equal(overview.current.totalTokens, 180)
  assert.equal(overview.current.inputTokens, 120)
  assert.equal(overview.current.outputTokens, 60)
  assert.equal(overview.current.cacheReadTokens, 260)
  assert.equal(overview.current.cacheWriteTokens, 70)
  assert.ok(Math.abs(overview.current.totalCost - 4.2) < 1e-9)
  assert.equal(overview.current.callCount, 2)
  assert.equal(overview.current.messageCount, 2)
  assert.equal(overview.current.userMessageCount, 1)
  assert.equal(overview.current.sessions, 1)
  assert.equal(overview.current.projectCount, 1)

  assert.equal(overview.topProjects.length, 1)
  assert.equal((overview.topProjects[0] as { label: string }).label, 'wiki')
  assert.equal((overview.topSessions[0] as { title: string }).title, '修 wiki 页面')
  assert.equal((overview.topSessions[0] as { agent: string }).agent, 'wiki')
}

function testDashboardAndOpenClawPlatformExcludeInternalHeartbeatButKeepVisibleTraffic() {
  const db = new DatabaseSync(':memory:')
  const now = Date.now()
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
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      input_cost REAL DEFAULT 0,
      output_cost REAL DEFAULT 0,
      reasoning_cost REAL DEFAULT 0,
      cache_read_cost REAL DEFAULT 0,
      cache_write_cost REAL DEFAULT 0,
      total_cost REAL DEFAULT 0,
      source_path TEXT,
      stop_reason TEXT
    );

    CREATE TABLE message_events (
      id TEXT PRIMARY KEY,
      timestamp_ms INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      session_key TEXT,
      agent TEXT,
      provider TEXT,
      model TEXT,
      channel TEXT,
      kind TEXT NOT NULL,
      source_path TEXT
    );

    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      session_key TEXT,
      agent TEXT,
      title TEXT,
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
    INSERT INTO usage_events (
      id, timestamp_ms, session_id, session_key, agent, provider, model, channel,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
      input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost, source_path, stop_reason
    ) VALUES
      ('codex-1', ${now - 4000}, 'codex-session', NULL, 'ClawMeter', 'openai', 'gpt-5.4', 'codex', 100, 50, 10, 0, 160, 1.0, 2.0, 0.1, 0, 3.1, '/tmp/codex.jsonl', 'end_turn'),
      ('feishu-1', ${now - 3000}, 'feishu-session', 'agent:main:feishu:ceo:direct:ou_1', 'ceo', 'minimax', 'MiniMax-M2.7', 'feishu', 30, 20, 5, 0, 55, 0.3, 0.5, 0.05, 0, 0.85, '/tmp/feishu.jsonl', 'end_turn'),
      ('cron-job-1', ${now - 2000}, 'cron-job-session', 'agent:main:cron:daily-review:run:cron-job-session', 'daily-review', 'kimi-coding', 'k2p5', 'cron', 70, 10, 0, 0, 80, 0.7, 0.2, 0, 0, 0.9, '/tmp/cron-job.jsonl', 'stop'),
      ('heartbeat-1', ${now - 1000}, 'heartbeat-session', NULL, 'main', 'kimi-coding', 'k2p5', 'cron', 400, 0, 0, 0, 400, 2.4, 0, 0, 0, 2.4, '/tmp/heartbeat.jsonl', 'stop');

    INSERT INTO message_events (
      id, timestamp_ms, session_id, session_key, agent, provider, model, channel, kind, source_path
    ) VALUES
      ('codex-msg-user', ${now - 4000}, 'codex-session', NULL, 'ClawMeter', 'openai', 'gpt-5.4', 'codex', 'user', '/tmp/codex.jsonl'),
      ('codex-msg-assistant', ${now - 3900}, 'codex-session', NULL, 'ClawMeter', 'openai', 'gpt-5.4', 'codex', 'assistant', '/tmp/codex.jsonl'),
      ('feishu-msg-user', ${now - 3000}, 'feishu-session', 'agent:main:feishu:ceo:direct:ou_1', 'ceo', 'minimax', 'MiniMax-M2.7', 'feishu', 'user', '/tmp/feishu.jsonl'),
      ('cron-job-msg-user', ${now - 2000}, 'cron-job-session', 'agent:main:cron:daily-review:run:cron-job-session', 'daily-review', 'kimi-coding', 'k2p5', 'cron', 'user', '/tmp/cron-job.jsonl'),
      ('heartbeat-msg-user', ${now - 1000}, 'heartbeat-session', NULL, 'main', 'kimi-coding', 'k2p5', 'cron', 'user', '/tmp/heartbeat.jsonl');

    INSERT INTO sessions (
      session_id, session_key, agent, title, channel, first_seen_at, last_seen_at, current_model, call_count, total_tokens, total_cost, source_path
    ) VALUES
      ('codex-session', NULL, 'ClawMeter', 'Ship billing fix', 'codex', ${now - 4000}, ${now - 3900}, 'gpt-5.4', 1, 160, 3.1, '/tmp/codex.jsonl'),
      ('feishu-session', 'agent:main:feishu:ceo:direct:ou_1', 'ceo', NULL, 'feishu', ${now - 3000}, ${now - 3000}, 'MiniMax-M2.7', 1, 55, 0.85, '/tmp/feishu.jsonl'),
      ('cron-job-session', 'agent:main:cron:daily-review:run:cron-job-session', 'daily-review', NULL, 'cron', ${now - 2000}, ${now - 2000}, 'k2p5', 1, 80, 0.9, '/tmp/cron-job.jsonl'),
      ('heartbeat-session', NULL, 'main', NULL, 'cron', ${now - 1000}, ${now - 1000}, 'k2p5', 1, 400, 2.4, '/tmp/heartbeat.jsonl');
  `)

  const summary = getDashboardSummaryRows(db, 0, -1, 0)
  assert.equal(summary.current.totalTokens, 280)
  assert.equal(summary.current.inputTokens, 200)
  assert.equal(summary.current.outputTokens, 80)
  assert.equal(summary.current.cacheTokens, 15)
  assert.ok(Math.abs(summary.current.totalCost - 4.85) < 1e-9)
  assert.equal(summary.current.sessions, 3)
  assert.equal(summary.current.channels, 3)
  assert.equal(summary.current.callCount, 3)
  assert.equal(summary.current.messageCount, 4)
  assert.equal(summary.current.userMessageCount, 3)

  const projects = getDashboardTopProjects(db, 0)
  assert.deepEqual(projects.map((row) => ({
    project: row.project,
    channel: row.channel,
    tokens: row.tokens,
  })), [
    { project: 'ClawMeter', channel: 'codex', tokens: 150 },
    { project: 'daily-review', channel: 'cron', tokens: 80 },
    { project: 'ceo', channel: 'feishu', tokens: 50 },
  ])

  const conversations = getDashboardTopConversations(db, 0, { ceo: 'COS' })
  assert.deepEqual(conversations.map((row) => ({
    sessionId: row.session_id,
    title: row.title,
    channel: row.channel,
    tokens: row.tokens,
  })), [
    { sessionId: 'codex-session', title: 'Ship billing fix', channel: 'codex', tokens: 150 },
    { sessionId: 'cron-job-session', title: 'daily-review', channel: 'cron', tokens: 80 },
    { sessionId: 'feishu-session', title: 'COS', channel: 'feishu', tokens: 50 },
  ])

  const summaryCards = getPlatformsSummary(db, '1d')
  const openclawCard = summaryCards.items.find((item) => item.product === 'openclaw')
  assert.ok(openclawCard)
  assert.equal(openclawCard!.current.totalTokens, 130)
  assert.equal(openclawCard!.current.inputTokens, 100)
  assert.equal(openclawCard!.current.outputTokens, 30)
  assert.equal(openclawCard!.current.cacheReadTokens, 5)
  assert.ok(Math.abs(openclawCard!.current.totalCost - 1.75) < 1e-9)
  assert.equal(openclawCard!.current.messageCount, 2)
  assert.equal(openclawCard!.current.userMessageCount, 2)

  const overview = getPlatformOverviewData(db, 'openclaw', '1d', { ceo: 'COS' })
  assert.equal(overview.current.totalTokens, 130)
  assert.equal(overview.current.callCount, 2)
  assert.equal(overview.current.sessions, 2)
  assert.deepEqual((overview.topChannels as Array<{ label: string; tokens: number }>).map((row) => ({
    label: row.label,
    tokens: row.tokens,
  })), [
    { label: 'cron', tokens: 80 },
    { label: 'feishu', tokens: 50 },
  ])
  assert.deepEqual((overview.topSessions as Array<{ session_id: string; channel: string; tokens: number }>).map((row) => ({
    sessionId: row.session_id,
    channel: row.channel,
    tokens: row.tokens,
  })), [
    { sessionId: 'cron-job-session', channel: 'cron', tokens: 80 },
    { sessionId: 'feishu-session', channel: 'feishu', tokens: 50 },
  ])
}

function testHermesPlatformSummaryAndSessionRebuildPreserveTitles() {
  const db = new DatabaseSync(':memory:')
  const now = Date.now()
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
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      input_cost REAL DEFAULT 0,
      output_cost REAL DEFAULT 0,
      reasoning_cost REAL DEFAULT 0,
      cache_read_cost REAL DEFAULT 0,
      cache_write_cost REAL DEFAULT 0,
      total_cost REAL DEFAULT 0,
      source_path TEXT,
      stop_reason TEXT
    );

    CREATE TABLE message_events (
      id TEXT PRIMARY KEY,
      timestamp_ms INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      session_key TEXT,
      agent TEXT,
      provider TEXT,
      model TEXT,
      channel TEXT,
      kind TEXT NOT NULL,
      source_path TEXT
    );

    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      session_key TEXT,
      agent TEXT,
      title TEXT,
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
    INSERT INTO usage_events (
      id, timestamp_ms, session_id, session_key, agent, provider, model, channel,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
      input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost, source_path, stop_reason
    ) VALUES
      ('hermes-1', ${now - 5000}, 'hermes-session-1', 'hermes:feishu:hermes-session-1', '飞书日报群', 'kimi-coding', 'kimi-k2-thinking', 'hermes', 120, 60, 1500, 0, 1680, 0.9, 0.6, 0.3, 0, 1.8, '/tmp/hermes-state.db', 'session_delta'),
      ('hermes-2', ${now - 2000}, 'hermes-session-1', 'hermes:feishu:hermes-session-1', '飞书日报群', 'kimi-coding', 'kimi-k2-thinking', 'hermes', 30, 10, 400, 0, 440, 0.2, 0.1, 0.08, 0, 0.38, '/tmp/hermes-state.db', 'session_delta');

    INSERT INTO message_events (
      id, timestamp_ms, session_id, session_key, agent, provider, model, channel, kind, source_path
    ) VALUES
      ('hermes-msg-user', ${now - 5000}, 'hermes-session-1', 'hermes:feishu:hermes-session-1', '飞书日报群', 'kimi-coding', 'kimi-k2-thinking', 'hermes', 'user', '/tmp/hermes-state.db'),
      ('hermes-msg-assistant', ${now - 2000}, 'hermes-session-1', 'hermes:feishu:hermes-session-1', '飞书日报群', 'kimi-coding', 'kimi-k2-thinking', 'hermes', 'assistant', '/tmp/hermes-state.db');

    INSERT INTO sessions (
      session_id, session_key, agent, title, channel, first_seen_at, last_seen_at, current_model, call_count, total_tokens, total_cost, source_path
    ) VALUES (
      'hermes-session-1', 'hermes:feishu:hermes-session-1', '飞书日报群', '飞书日报群', 'hermes', ${now - 5000}, ${now - 2000}, 'kimi-k2-thinking', 2, 2120, 2.18, '/tmp/hermes-state.db'
    );
  `)

  const summary = getPlatformsSummary(db, '1d')
  const hermesCard = summary.items.find((item) => item.product === 'hermes')
  assert.ok(hermesCard)
  assert.equal(hermesCard!.current.totalTokens, 220)
  assert.equal(hermesCard!.current.inputTokens, 150)
  assert.equal(hermesCard!.current.outputTokens, 70)
  assert.equal(hermesCard!.current.cacheReadTokens, 1900)
  assert.ok(Math.abs(hermesCard!.current.totalCost - 2.18) < 1e-9)
  assert.equal(hermesCard!.current.messageCount, 2)
  assert.equal(hermesCard!.current.userMessageCount, 1)

  const overview = getPlatformOverviewData(db, 'hermes', '1d')
  assert.equal(overview.current.totalTokens, 220)
  assert.equal(overview.current.projectCount, 1)
  assert.equal((overview.topProjects[0] as { label: string }).label, '飞书日报群')
  assert.equal((overview.topSessions[0] as { title: string }).title, '飞书日报群')

  assert.equal(rebuildSessionsFromUsage(db), 1)

  const rebuilt = db.prepare(`
    SELECT session_key as sessionKey, agent, title, total_tokens as totalTokens, total_cost as totalCost
    FROM sessions
    WHERE session_id = 'hermes-session-1'
  `).get() as { sessionKey: string; agent: string; title: string; totalTokens: number; totalCost: number }

  assert.equal(rebuilt.sessionKey, 'hermes:feishu:hermes-session-1')
  assert.equal(rebuilt.agent, '飞书日报群')
  assert.equal(rebuilt.title, '飞书日报群')
  assert.equal(rebuilt.totalTokens, 2120)
  assert.ok(Math.abs(rebuilt.totalCost - 2.18) < 1e-9)
}

function testKimiCodeParserUsesStatusUpdateTokenUsage() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmeter-kimi-'))
  const filePath = path.join(tmpDir, 'wire.jsonl')
  fs.writeFileSync(filePath, [
    JSON.stringify({ type: 'metadata', protocol_version: '1.3' }),
    JSON.stringify({
      timestamp: 1770731202.3279119,
      message: { type: 'TurnBegin', payload: { user_input: [{ type: 'text', text: '进入Cos项目' }] } },
    }),
    JSON.stringify({
      timestamp: 1770731214.86378,
      message: {
        type: 'StatusUpdate',
        payload: {
          context_usage: 0.0563,
          token_usage: { input_other: 433, output: 179, input_cache_read: 14336, input_cache_creation: 0 },
          message_id: 'chatcmpl-sZPudJNOnfOBfPmVxTwySTij',
        },
      },
    }),
  ].join('\n'), 'utf8')

  const result = parseKimiCodeFile(filePath, 'kimi-session')
  assert.equal(result.events.length, 1)
  assert.equal(result.projectName, 'Cos')
  assert.equal(result.events[0].agent, 'Cos')
  assert.equal(result.events[0].inputTokens, 433)
  assert.equal(result.events[0].outputTokens, 179)
  assert.equal(result.events[0].cacheReadTokens, 14336)
  assert.equal(result.events[0].totalTokens, 14948)
}

function testQwenCodeParserAcceptsGenericStatusUpdateJsonl() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmeter-qwen-'))
  const filePath = path.join(tmpDir, 'events.jsonl')
  fs.writeFileSync(filePath, [
    JSON.stringify({
      timestamp: '2026-04-03T12:00:00.000Z',
      command: 'cd /Users/xinzechao/QwenProj && qwen',
    }),
    JSON.stringify({
      timestamp: '2026-04-03T12:00:05.000Z',
      message: {
        type: 'StatusUpdate',
        payload: {
          model: 'qwen-plus',
          token_usage: { input_other: 1200, output: 300, input_cache_read: 500, input_cache_creation: 100 },
          message_id: 'msg_1',
        },
      },
    }),
  ].join('\n'), 'utf8')

  const result = parseQwenCodeFile(filePath, 'qwen-session')
  assert.equal(result.events.length, 1)
  assert.equal(result.projectName, 'QwenProj')
  assert.equal(result.events[0].agent, 'QwenProj')
  assert.equal(result.events[0].model, 'qwen-plus')
  assert.equal(result.events[0].inputTokens, 1200)
  assert.equal(result.events[0].cacheReadTokens, 500)
  assert.equal(result.events[0].cacheWriteTokens, 100)
  assert.equal(result.events[0].totalTokens, 2100)
}

testCodexParserNormalizesOpenAIUsage()
testClaudeCodeParserKeepsSessionRootProjectWhenCwdEntersSubdir()
testResolveStartLineReindexesWhenParserVersionChanges()
testOfficialPriceOverrideCorrectsClaudeOpus46()
testResolvePricedModelIdMapsKnownAliases()
testResetDerivedUsageDataClearsReindexTables()
testSessionUpsertUsesAuthoritativeUsageTotals()
testRebuildSessionsDropsOrphansAndRecalculatesAllRows()
testGeminiCliParserNormalizesCachedAndThoughtTokens()
testCopilotCliParserSeparatesCacheReadAndWrite()
testOpencodeJsonParserIncludesReasoningAndCacheWrite()
testKimiCodeParserUsesStatusUpdateTokenUsage()
testQwenCodeParserAcceptsGenericStatusUpdateJsonl()
testDashboardMetricsUseActiveUsageForHomepage()
testPlatformsSummarySortsByCostAndUsesCacheReadCost()
testModelsListSupportsPeriodFiltering()
testDashboardTopListsSplitProjectsAndConversations()
testPlatformOverviewUsesActiveMetricsAndNormalizedProjects()
testDashboardAndOpenClawPlatformExcludeInternalHeartbeatButKeepVisibleTraffic()
testHermesPlatformSummaryAndSessionRebuildPreserveTitles()
console.log('ingestion regression tests passed')
