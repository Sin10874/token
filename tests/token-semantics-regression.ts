import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseClaudeCodeFile } from '../server/ingestion/claude-code-parser.ts'
import { parseCodexFile } from '../server/ingestion/codex-parser.ts'
import { parseCopilotCliFile } from '../server/ingestion/copilot-cli-parser.ts'
import { parseGeminiCliFile } from '../server/ingestion/gemini-cli-parser.ts'
import { parseHermesSession } from '../server/ingestion/hermes-parser.ts'
import { parseKimiCodeFile } from '../server/ingestion/kimi-code-parser.ts'
import { parseOpencodeFile } from '../server/ingestion/opencode-parser.ts'
import { parseSessionFile } from '../server/ingestion/parser.ts'
import { parseQwenCodeFile } from '../server/ingestion/qwen-code-parser.ts'
import { validateUsageBuckets } from '../server/ingestion/token-normalization.ts'
import { collectSyncPayload, uploadSyncPayload } from '../cli/sync.ts'
import type { ParseResult, RawUsageEvent } from '../server/ingestion/parser.ts'

// Kept separate because ingestion-regression.ts statically imports legacy API modules
// that are absent from this branch before these parser contracts can execute.
function validUsageBuckets() {
  return {
    inputTokens: 10,
    outputTokens: 20,
    reasoningTokens: 30,
    cacheReadTokens: 40,
    cacheWriteTokens: 50,
  }
}

function testValidUsageBucketsAreReturnedUnchanged() {
  const usage = validUsageBuckets()
  const result = validateUsageBuckets(usage)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value, usage)
  assert.deepEqual(result.value, usage)
}

function testInvalidUsageBucketsAreRejectedByExactName() {
  const invalidCases = [
    ['inputTokens', -1],
    ['outputTokens', Number.NaN],
    ['reasoningTokens', Number.POSITIVE_INFINITY],
    ['cacheReadTokens', -1],
    ['cacheWriteTokens', Number.NEGATIVE_INFINITY],
  ] as const

  for (const [bucket, value] of invalidCases) {
    const usage = { ...validUsageBuckets(), [bucket]: value }
    const result = validateUsageBuckets(usage)

    assert.equal(result.ok, false, `${bucket} should be rejected`)
    if (result.ok) continue
    assert.match(result.warning, new RegExp(`\\b${bucket}\\b`))
  }
}

function parseCodexUsage(lastUsage: Record<string, number>) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokend-codex-semantics-'))
  const filePath = path.join(tmpDir, 'session.jsonl')
  const lines = [
    {
      timestamp: '2026-04-02T03:31:49.000Z',
      type: 'session_meta',
      payload: { cwd: '/Users/xinzechao/project-a' },
    },
    {
      timestamp: '2026-04-02T03:32:00.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-5.4', cwd: '/Users/xinzechao/project-a' },
    },
    {
      timestamp: '2026-04-02T03:32:30.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    },
    {
      timestamp: '2026-04-02T03:33:00.815Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: lastUsage,
          last_token_usage: lastUsage,
        },
      },
    },
  ]
  fs.writeFileSync(filePath, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`, 'utf8')
  return parseCodexFile(filePath, 'codex-session', 'Thread', '/Users/xinzechao/project-a')
}

function testCodexConvertsInclusiveCountersExactlyOnce() {
  const result = parseCodexUsage({
    input_tokens: 25351,
    cached_input_tokens: 13184,
    output_tokens: 282,
    reasoning_output_tokens: 90,
    total_tokens: 25633,
  })

  assert.equal(result.events.length, 1)
  assert.deepEqual({
    inputTokens: result.events[0].inputTokens,
    outputTokens: result.events[0].outputTokens,
    reasoningTokens: result.events[0].reasoningTokens,
    cacheReadTokens: result.events[0].cacheReadTokens,
    cacheWriteTokens: result.events[0].cacheWriteTokens,
    totalTokens: result.events[0].totalTokens,
    tokenSemantics: result.events[0].tokenSemantics,
  }, {
    inputTokens: 12167,
    outputTokens: 192,
    reasoningTokens: 90,
    cacheReadTokens: 13184,
    cacheWriteTokens: 0,
    totalTokens: 25633,
    tokenSemantics: 'disjoint',
  })
}

function testCodexRejectsCachedTokensAboveRawInputOnce() {
  const result = parseCodexUsage({
    input_tokens: 10,
    cached_input_tokens: 20,
    output_tokens: 5,
    reasoning_output_tokens: 0,
    total_tokens: 15,
  })

  assert.equal(result.events.length, 0)
  assert.equal(result.messages.length, 1)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /\binputTokens\b/)
}

function parseClaudeUsage(usage: Record<string, number>) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokend-claude-semantics-'))
  const filePath = path.join(tmpDir, 'session.jsonl')
  fs.writeFileSync(filePath, JSON.stringify({
    sessionId: 'cc-session',
    cwd: '/Users/xinzechao/One',
    timestamp: '2026-04-06T01:00:00.000Z',
    type: 'assistant',
    uuid: 'msg-1',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'hello' }],
      usage,
    },
  }), 'utf8')
  return parseClaudeCodeFile(filePath, 'cc-session', '-Users-xinzechao-One')
}

function testClaudeKeepsIndependentCacheColumns() {
  const result = parseClaudeUsage({
    input_tokens: 120,
    output_tokens: 80,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 20,
  })

  assert.equal(result.events.length, 1)
  assert.deepEqual({
    inputTokens: result.events[0].inputTokens,
    outputTokens: result.events[0].outputTokens,
    reasoningTokens: result.events[0].reasoningTokens,
    cacheReadTokens: result.events[0].cacheReadTokens,
    cacheWriteTokens: result.events[0].cacheWriteTokens,
    totalTokens: result.events[0].totalTokens,
    tokenSemantics: result.events[0].tokenSemantics,
  }, {
    inputTokens: 120,
    outputTokens: 80,
    reasoningTokens: 0,
    cacheReadTokens: 20,
    cacheWriteTokens: 10,
    totalTokens: 230,
    tokenSemantics: 'disjoint',
  })
}

function testClaudeRejectsNegativeCacheWriteOnce() {
  const result = parseClaudeUsage({
    input_tokens: 120,
    output_tokens: 80,
    cache_creation_input_tokens: -10,
    cache_read_input_tokens: 20,
  })

  assert.equal(result.events.length, 0)
  assert.equal(result.messages.length, 1)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /\bcacheWriteTokens\b/)
}

function tempFile(prefix: string, fileName: string, content: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const filePath = path.join(tmpDir, fileName)
  fs.writeFileSync(filePath, content, 'utf8')
  return filePath
}

function unknownSemanticsFixtures() {
  const openclawPath = tempFile('tokend-openclaw-semantics-', 'session.jsonl', JSON.stringify({
    id: 'assistant-1',
    timestamp: '2026-04-02T03:33:00.000Z',
    type: 'message',
    message: {
      role: 'assistant',
      model: 'gpt-5.4',
      provider: 'openai',
      content: [{ type: 'text', text: 'hello' }],
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18 },
    },
  }))

  const geminiPath = tempFile('tokend-gemini-semantics-', 'session.json', JSON.stringify({
    sessionId: 'gemini-session',
    messages: [{
      id: 'a1',
      timestamp: '2025-12-09T06:16:47.432Z',
      type: 'gemini',
      model: 'gemini-2.5-pro',
      tokens: { input: 8112, output: 16, cached: 6347, thoughts: 60, total: 8188 },
    }],
  }))

  const copilotPath = tempFile('tokend-copilot-semantics-', 'events.jsonl', [
    JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'session.start',
      data: { context: { cwd: '/Users/xinzechao/copilot-app' } },
    }),
    JSON.stringify({
      timestamp: '2026-01-01T00:00:10.000Z',
      type: 'session.shutdown',
      data: { modelMetrics: { 'gpt-4.1': { usage: { inputTokens: 1000, outputTokens: 400 } } } },
    }),
  ].join('\n'))

  const opencodeJsonPath = tempFile('tokend-opencode-json-semantics-', 'msg_1.json', JSON.stringify({
    id: 'msg_1',
    sessionID: 'ses_json',
    role: 'assistant',
    time: { created: 1768715098162 },
    modelID: 'gpt-5.4',
    providerID: 'openai',
    path: { root: '/Users/xinzechao/opencode-json' },
    tokens: { input: 88, output: 181, reasoning: 3, cache: { read: 517, write: 1 } },
  }))

  const opencodeSqliteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokend-opencode-sqlite-semantics-'))
  const opencodeSqlitePath = path.join(opencodeSqliteDir, 'opencode.db')
  const opencodeDb = new DatabaseSync(opencodeSqlitePath)
  opencodeDb.exec('CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)')
  opencodeDb.prepare('INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)').run(
    'msg_sqlite',
    'ses_sqlite',
    JSON.stringify({
      role: 'assistant',
      time: { created: 1768715098162 },
      modelID: 'gpt-5.4',
      providerID: 'openai',
      path: { root: '/Users/xinzechao/opencode-sqlite' },
      tokens: { input: 5, output: 6, reasoning: 1, cache: { read: 2, write: 3 } },
    }),
  )
  opencodeDb.close()

  const kimiPath = tempFile('tokend-kimi-semantics-', 'wire.jsonl', [
    JSON.stringify({
      timestamp: 1770731202.3279119,
      message: { type: 'TurnBegin', payload: { user_input: [{ type: 'text', text: '进入Cos项目' }] } },
    }),
    JSON.stringify({
      timestamp: 1770731214.86378,
      message: {
        type: 'StatusUpdate',
        payload: {
          token_usage: { input_other: 433, output: 179, input_cache_read: 14336, input_cache_creation: 0 },
          message_id: 'kimi-message',
        },
      },
    }),
  ].join('\n'))

  const qwenPath = tempFile('tokend-qwen-semantics-', 'events.jsonl', JSON.stringify({
    timestamp: '2026-04-03T12:00:05.000Z',
    message: {
      type: 'StatusUpdate',
      payload: {
        provider: 'openai',
        model: 'qwen-plus',
        token_usage: { input_other: 1200, output: 300, input_cache_read: 500, input_cache_creation: 100 },
        message_id: 'qwen-message',
      },
    },
  }))

  const hermes = parseHermesSession({
    sessionId: 'hermes-session',
    source: 'feishu',
    model: 'gpt-5.4',
    billingProvider: 'openai',
    billingBaseUrl: null,
    startedAtMs: 1,
    endedAtMs: 2,
    updatedAtMs: 2,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    reasoningTokens: 3,
    estimatedCostUsd: 0,
    title: 'Hermes fixture',
    sessionKey: 'hermes:feishu:hermes-session',
    sourcePath: '/tmp/hermes-state.db',
  }, [])

  return [
    ['OpenClaw generic', parseSessionFile(openclawPath, 'openclaw-session', undefined, 'agent', 'webchat')],
    ['Gemini CLI', parseGeminiCliFile(geminiPath, 'gemini-session')],
    ['Copilot CLI', parseCopilotCliFile(copilotPath, 'copilot-session')],
    ['OpenCode JSON', parseOpencodeFile({ filePath: opencodeJsonPath, sessionId: 'ses_json', kind: 'json' })],
    ['OpenCode SQLite', parseOpencodeFile({ filePath: opencodeSqlitePath, sessionId: 'ses_sqlite', kind: 'sqlite' })],
    ['Kimi Code', parseKimiCodeFile(kimiPath, 'kimi-session')],
    ['Qwen Code', parseQwenCodeFile(qwenPath, 'qwen-session')],
    ['Hermes', hermes],
  ] as const
}

function testUnprovenParsersUseUnknownTokenSemantics() {
  for (const [name, result] of unknownSemanticsFixtures()) {
    assert.equal(result.events.length, 1, `${name} should emit one fixture event`)
    assert.equal(result.events[0].tokenSemantics, 'unknown', `${name} should not infer disjoint semantics`)
  }
}

function usageEvent(overrides: Partial<RawUsageEvent> = {}): RawUsageEvent {
  return {
    id: 'usage-event-1',
    timestampMs: Date.parse('2026-07-10T00:00:00Z'),
    sessionId: 'sync-session',
    sessionKey: null,
    agent: 'sync-project',
    provider: 'openai',
    model: 'gpt-5.4',
    channel: 'openclaw',
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 1,
    tokenSemantics: 'unknown',
    totalTokens: 21,
    inputCost: 0,
    outputCost: 0,
    reasoningCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    totalCost: 0,
    sourcePath: '/tmp/invalid-usage.jsonl',
    stopReason: 'end_turn',
    ...overrides,
  }
}

function testCollectRejectsInfinityButRetainsProgress() {
  const result: ParseResult = {
    events: [usageEvent({ inputTokens: Number.POSITIVE_INFINITY })],
    messages: [{
      id: 'message-1',
      timestampMs: Date.parse('2026-07-10T00:00:00Z'),
      sessionId: 'sync-session',
      sessionKey: null,
      agent: 'sync-project',
      provider: 'openai',
      model: 'gpt-5.4',
      channel: 'openclaw',
      kind: 'assistant',
      sourcePath: '/tmp/invalid-usage.jsonl',
    }],
    warnings: [],
    linesRead: 9,
  }

  const collected = collectSyncPayload(result, '/tmp/invalid-usage.jsonl', 'openclaw')

  assert.equal(collected.uploadEvents.length, 0)
  assert.equal(collected.uploadMessages.length, 1)
  assert.equal(collected.syncStates.length, 1)
  assert.equal(collected.syncStates[0].lastProcessedLines, 9)
  assert.equal(collected.warnings.length, 1)
  assert.match(collected.warnings[0], /\busage-event-1\b/)
  assert.match(collected.warnings[0], /\binputTokens\b/)
}

interface IncrementalFixture {
  name: string
  messageLine: string
  usageLine: string
  parse: (filePath: string, startLine: number) => ParseResult
}

function incrementalFixtures(): IncrementalFixture[] {
  const genericMessage = JSON.stringify({
    id: 'generic-user',
    timestamp: '2026-07-10T00:00:00.000Z',
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  })
  const genericUsage = JSON.stringify({
    id: 'generic-assistant',
    timestamp: '2026-07-10T00:00:01.000Z',
    type: 'message',
    message: {
      role: 'assistant',
      model: 'gpt-5.4',
      provider: 'openai',
      usage: { input: 10, output: 5, totalTokens: 15 },
    },
  })
  const claudeMessage = JSON.stringify({
    sessionId: 'claude-incremental',
    timestamp: '2026-07-10T00:00:00.000Z',
    type: 'user',
    uuid: 'claude-user',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  })
  const claudeUsage = JSON.stringify({
    sessionId: 'claude-incremental',
    timestamp: '2026-07-10T00:00:01.000Z',
    type: 'assistant',
    uuid: 'claude-assistant',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-6',
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 },
    },
  })
  const codexMessage = JSON.stringify({
    timestamp: '2026-07-10T00:00:00.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
  })
  const codexUsageRecord = {
    input_tokens: 10,
    cached_input_tokens: 2,
    output_tokens: 5,
    reasoning_output_tokens: 1,
    total_tokens: 15,
  }
  const codexUsage = JSON.stringify({
    timestamp: '2026-07-10T00:00:01.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: codexUsageRecord, last_token_usage: codexUsageRecord },
    },
  })

  return [
    {
      name: 'OpenClaw',
      messageLine: genericMessage,
      usageLine: genericUsage,
      parse: (filePath, startLine) => parseSessionFile(
        filePath,
        'generic-incremental',
        undefined,
        'agent',
        'webchat',
        startLine,
      ),
    },
    {
      name: 'Claude Code',
      messageLine: claudeMessage,
      usageLine: claudeUsage,
      parse: (filePath, startLine) => parseClaudeCodeFile(
        filePath,
        'claude-incremental',
        '-Users-xinzechao-project',
        startLine,
      ),
    },
    {
      name: 'Codex',
      messageLine: codexMessage,
      usageLine: codexUsage,
      parse: (filePath, startLine) => parseCodexFile(
        filePath,
        'codex-incremental',
        null,
        '/Users/xinzechao/project',
        startLine,
      ),
    },
  ]
}

function testTrailingNewlineCursorAllowsNextCompleteUsageLine() {
  for (const fixture of incrementalFixtures()) {
    const filePath = tempFile(
      `tokend-${fixture.name.toLowerCase().replace(/ /g, '-')}-cursor-`,
      'session.jsonl',
      `${fixture.messageLine}\n`,
    )
    const first = fixture.parse(filePath, 0)
    assert.equal(first.linesRead, 1, `${fixture.name} should not count the trailing empty segment`)

    fs.appendFileSync(filePath, `${fixture.usageLine}\n`, 'utf8')
    const second = fixture.parse(filePath, first.linesRead)
    assert.equal(second.events.length, 1, `${fixture.name} should collect the appended usage line`)
  }
}

function testCompleteInvalidUsageAdvancesCursorOnce() {
  const invalidLine = JSON.stringify({
    id: 'invalid-assistant',
    timestamp: '2026-07-10T00:00:01.000Z',
    type: 'message',
    message: {
      role: 'assistant',
      model: 'gpt-5.4',
      provider: 'openai',
      usage: { input: -1, output: 5, totalTokens: 4 },
    },
  })
  const filePath = tempFile('tokend-complete-invalid-cursor-', 'session.jsonl', `${invalidLine}\n`)
  const first = parseSessionFile(filePath, 'invalid-session', undefined, 'agent', 'webchat')
  const firstCollected = collectSyncPayload(first, filePath, 'openclaw')

  assert.equal(first.linesRead, 1)
  assert.equal(firstCollected.uploadEvents.length, 0)
  assert.equal(firstCollected.warnings.length, 1)

  const second = parseSessionFile(
    filePath,
    'invalid-session',
    undefined,
    'agent',
    'webchat',
    first.linesRead,
  )
  const secondCollected = collectSyncPayload(second, filePath, 'openclaw')
  assert.equal(second.events.length, 0)
  assert.equal(secondCollected.warnings.length, 0)
}

function testPartialJsonCursorWaitsForCompletion() {
  for (const fixture of incrementalFixtures()) {
    const splitAt = Math.floor(fixture.usageLine.length / 2)
    const filePath = tempFile(
      `tokend-${fixture.name.toLowerCase().replace(/ /g, '-')}-partial-`,
      'session.jsonl',
      `${fixture.messageLine}\n${fixture.usageLine.slice(0, splitAt)}`,
    )
    const first = fixture.parse(filePath, 0)
    assert.equal(first.messages.length, 1, `${fixture.name} should retain the complete message`)
    assert.equal(first.events.length, 0, `${fixture.name} should not emit the partial usage`)
    assert.equal(first.linesRead, 1, `${fixture.name} should leave the partial line uncommitted`)

    fs.appendFileSync(filePath, `${fixture.usageLine.slice(splitAt)}\n`, 'utf8')
    const second = fixture.parse(filePath, first.linesRead)
    assert.equal(second.events.length, 1, `${fixture.name} should collect usage after completion`)
  }
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

function testCodexIncrementalIdsMatchFullParse() {
  const firstUsage = {
    input_tokens: 10,
    cached_input_tokens: 2,
    output_tokens: 5,
    reasoning_output_tokens: 1,
    total_tokens: 15,
  }
  const secondLastUsage = {
    input_tokens: 10,
    cached_input_tokens: 2,
    output_tokens: 5,
    reasoning_output_tokens: 1,
    total_tokens: 15,
  }
  const secondTotalUsage = {
    input_tokens: 20,
    cached_input_tokens: 4,
    output_tokens: 10,
    reasoning_output_tokens: 2,
    total_tokens: 30,
  }
  const firstLine = codexTokenLine('2026-07-10T00:00:01.000Z', firstUsage, firstUsage)
  const secondLine = codexTokenLine('2026-07-10T00:00:02.000Z', secondTotalUsage, secondLastUsage)
  const filePath = tempFile('tokend-codex-id-cursor-', 'session.jsonl', `${firstLine}\n`)

  const first = parseCodexFile(filePath, 'codex-id-session', null, '/Users/xinzechao/project')
  assert.equal(first.events.length, 1)

  fs.appendFileSync(filePath, `${secondLine}\n`, 'utf8')
  const second = parseCodexFile(
    filePath,
    'codex-id-session',
    null,
    '/Users/xinzechao/project',
    first.linesRead,
  )
  assert.equal(second.events.length, 1)
  assert.notEqual(second.events[0].id, first.events[0].id)

  const full = parseCodexFile(filePath, 'codex-id-session', null, '/Users/xinzechao/project')
  assert.deepEqual(
    [first.events[0].id, second.events[0].id],
    full.events.map(event => event.id),
  )
}

function testIncrementalParserVersionsInvalidateLegacyCursors() {
  const emptyResult: ParseResult = {
    events: [],
    messages: [],
    warnings: [],
    linesRead: 0,
  }
  const expectedVersions = [
    ['openclaw', 2],
    ['claudeCode', 2],
    ['codex', 3],
  ] as const

  for (const [parserKey, expectedVersion] of expectedVersions) {
    const collected = collectSyncPayload(emptyResult, `/tmp/${parserKey}.jsonl`, parserKey)
    assert.equal(collected.syncStates[0].parserVersion, expectedVersion)
  }
}

async function testMessageUploadsCompleteBeforeCursorCommit() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const events = [{ id: 'event-1' }]
  const messages = [{ id: 'message-1' }]
  const syncStates = [{ sourcePathHash: 'hash-1', lastProcessedLines: 7, parserVersion: 2 }]

  const eventsInserted = await uploadSyncPayload({
    token: 'token-1',
    events,
    messages,
    syncStates,
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      return name === 'tokend_upload_events_v2'
        ? { data: { inserted: calls.length === 1 ? 1 : 0 }, error: null }
        : { data: { ok: true }, error: null }
    },
  })

  assert.equal(eventsInserted, 1)
  assert.deepEqual(calls.map(call => call.name), [
    'tokend_upload_events_v2',
    'tokend_upload_messages',
    'tokend_upload_events_v2',
  ])
  assert.deepEqual(calls[0].args, {
    p_token: 'token-1',
    p_events: events,
    p_sync_states: [],
  })
  assert.deepEqual(calls[1].args, {
    p_token: 'token-1',
    p_messages: messages,
  })
  assert.deepEqual(calls[2].args, {
    p_token: 'token-1',
    p_events: [],
    p_sync_states: syncStates,
  })
}

async function testMessageRpcErrorLeavesCursorUncommittedAndRetryable() {
  const events = [{ id: 'event-retry' }]
  const messages = [{ id: 'message-retry' }]
  const syncStates = [{ sourcePathHash: 'hash-retry', lastProcessedLines: 8, parserVersion: 2 }]
  const failedCalls: Array<{ name: string; args: Record<string, unknown> }> = []

  await assert.rejects(
    uploadSyncPayload({
      token: 'token-retry',
      events,
      messages,
      syncStates,
      rpc: async (name: string, args: Record<string, unknown>) => {
        failedCalls.push({ name, args })
        if (name === 'tokend_upload_messages') {
          return { data: null, error: { message: 'message write failed' } }
        }
        return { data: { inserted: 1 }, error: null }
      },
    }),
    /message.*write failed/i,
  )

  assert.deepEqual(failedCalls.map(call => call.name), [
    'tokend_upload_events_v2',
    'tokend_upload_messages',
  ])
  assert.equal(
    failedCalls.some(call => Array.isArray(call.args.p_sync_states) && call.args.p_sync_states.length > 0),
    false,
  )

  const retryCalls: Array<{ name: string; args: Record<string, unknown> }> = []
  await uploadSyncPayload({
    token: 'token-retry',
    events,
    messages,
    syncStates,
    rpc: async (name: string, args: Record<string, unknown>) => {
      retryCalls.push({ name, args })
      return { data: { inserted: name === 'tokend_upload_events_v2' ? 1 : 0 }, error: null }
    },
  })
  assert.deepEqual(retryCalls.map(call => call.name), [
    'tokend_upload_events_v2',
    'tokend_upload_messages',
    'tokend_upload_events_v2',
  ])
  assert.deepEqual(retryCalls[2].args.p_sync_states, syncStates)
}

async function testMessageDataErrorLeavesCursorUncommitted() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []

  await assert.rejects(
    uploadSyncPayload({
      token: 'data-error-token',
      events: [{ id: 'data-error-event' }],
      messages: [{ id: 'data-error-message' }],
      syncStates: [{ sourcePathHash: 'data-error', lastProcessedLines: 9, parserVersion: 2 }],
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args })
        if (name === 'tokend_upload_messages') {
          return { data: { ok: false, error: 'invalid_token' }, error: null }
        }
        return { data: { ok: true, inserted: 1 }, error: null }
      },
    }),
    /message.*invalid_token/i,
  )

  assert.deepEqual(calls.map(call => call.name), [
    'tokend_upload_events_v2',
    'tokend_upload_messages',
  ])
}

async function testMessageOnlyPayloadStillCommitsCursorLast() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const syncStates = [{ sourcePathHash: 'message-only', lastProcessedLines: 3, parserVersion: 2 }]

  await uploadSyncPayload({
    token: 'message-only-token',
    events: [],
    messages: [{ id: 'message-only' }],
    syncStates,
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      return { data: { inserted: 0 }, error: null }
    },
  })

  assert.deepEqual(calls.map(call => call.name), [
    'tokend_upload_events_v2',
    'tokend_upload_messages',
    'tokend_upload_events_v2',
  ])
  assert.deepEqual(calls[0].args.p_events, [])
  assert.deepEqual(calls[0].args.p_sync_states, [])
  assert.deepEqual(calls[2].args.p_sync_states, syncStates)
}

async function testMessageNetworkThrowLeavesCursorUncommitted() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []

  await assert.rejects(
    uploadSyncPayload({
      token: 'network-token',
      events: [{ id: 'network-event' }],
      messages: [{ id: 'network-message' }],
      syncStates: [{ sourcePathHash: 'network', lastProcessedLines: 4, parserVersion: 2 }],
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args })
        if (name === 'tokend_upload_messages') throw new Error('network down')
        return { data: { inserted: 1 }, error: null }
      },
    }),
    /network down/i,
  )

  assert.deepEqual(calls.map(call => call.name), [
    'tokend_upload_events_v2',
    'tokend_upload_messages',
  ])
  assert.equal(
    calls.some(call => Array.isArray(call.args.p_sync_states) && call.args.p_sync_states.length > 0),
    false,
  )
}

async function testNoMessagePayloadKeepsEventsAndCursorAtomic() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const events = [{ id: 'atomic-event' }]
  const syncStates = [{ sourcePathHash: 'atomic', lastProcessedLines: 5, parserVersion: 2 }]

  await uploadSyncPayload({
    token: 'atomic-token',
    events,
    messages: [],
    syncStates,
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      return { data: { inserted: 1 }, error: null }
    },
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'tokend_upload_events_v2')
  assert.deepEqual(calls[0].args.p_events, events)
  assert.deepEqual(calls[0].args.p_sync_states, syncStates)
}

async function main() {
  testValidUsageBucketsAreReturnedUnchanged()
  testInvalidUsageBucketsAreRejectedByExactName()
  testCodexConvertsInclusiveCountersExactlyOnce()
  testCodexRejectsCachedTokensAboveRawInputOnce()
  testClaudeKeepsIndependentCacheColumns()
  testClaudeRejectsNegativeCacheWriteOnce()
  testUnprovenParsersUseUnknownTokenSemantics()
  testCollectRejectsInfinityButRetainsProgress()
  testTrailingNewlineCursorAllowsNextCompleteUsageLine()
  testCompleteInvalidUsageAdvancesCursorOnce()
  testPartialJsonCursorWaitsForCompletion()
  testCodexIncrementalIdsMatchFullParse()
  testIncrementalParserVersionsInvalidateLegacyCursors()
  await testMessageUploadsCompleteBeforeCursorCommit()
  await testMessageRpcErrorLeavesCursorUncommittedAndRetryable()
  await testMessageDataErrorLeavesCursorUncommitted()
  await testMessageOnlyPayloadStillCommitsCursorLast()
  await testMessageNetworkThrowLeavesCursorUncommitted()
  await testNoMessagePayloadKeepsEventsAndCursorAtomic()
  console.log('token semantics regression tests passed')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
