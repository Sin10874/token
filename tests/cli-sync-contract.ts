import assert from 'node:assert/strict'
import type { RawUsageEvent } from '../server/ingestion/parser.ts'
import {
  isMissingRpcError,
  stripEvent,
  uploadEventBatch,
  uploadSyncPayload,
} from '../cli/sync.ts'

const EVENT_KEYS = [
  'id',
  'timestampMs',
  'sessionId',
  'sessionKey',
  'agent',
  'provider',
  'model',
  'channel',
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalTokens',
  'inputCost',
  'outputCost',
  'reasoningCost',
  'cacheReadCost',
  'cacheWriteCost',
  'totalCost',
  'stopReason',
  'project',
  'pricingStatus',
  'pricingTier',
  'priceVersion',
  'matchedModelId',
  'tokenSemantics',
  'unallocatedCost',
  'breakdownStatus',
] as const

type FixtureEvent = RawUsageEvent & Record<string, unknown>

function rawUsageEvent(overrides: Partial<FixtureEvent> = {}): FixtureEvent {
  return {
    id: 'sync-contract-event',
    timestampMs: Date.parse('2026-07-10T00:00:00Z'),
    sessionId: 'sync-contract-session',
    sessionKey: null,
    agent: 'codex',
    provider: 'openai',
    model: 'gpt-5.6-sol',
    channel: 'cli',
    inputTokens: 11,
    outputTokens: 7,
    reasoningTokens: 3,
    cacheReadTokens: 5,
    cacheWriteTokens: 2,
    totalTokens: 28,
    inputCost: 0.11,
    outputCost: 0.07,
    reasoningCost: 0.03,
    cacheReadCost: 0.05,
    cacheWriteCost: 0.02,
    totalCost: 0.28,
    stopReason: 'end_turn',
    sourcePath: '/private/secret/session.jsonl',
    pricingStatus: 'estimated',
    pricingTier: 'standard',
    priceVersion: '2026-07-10/gpt-5.6-sol',
    matchedModelId: 'gpt-5.6-sol',
    tokenSemantics: 'disjoint',
    unallocatedCost: 0,
    breakdownStatus: 'reconciled',
    prompt: 'do not upload',
    content: 'do not upload',
    messages: [{ role: 'user', content: 'do not upload' }],
    raw: { request: 'do not upload' },
    secret: 'do not upload',
    unknown: 'do not upload',
    ...overrides,
  }
}

function unpricedEvent(): FixtureEvent {
  return rawUsageEvent({
    id: 'unpriced-event',
    model: 'vendor/no-such-model-for-sync-test',
    inputCost: 9,
    outputCost: 8,
    reasoningCost: 7,
    cacheReadCost: 6,
    cacheWriteCost: 5,
    totalCost: 35,
    pricingStatus: 'unpriced',
    pricingTier: 'standard',
    priceVersion: 'stale-price-version',
    matchedModelId: 'stale-model-id',
    unallocatedCost: 4,
  })
}

function testStripEventUsesExactAllowlist() {
  const project = 'p'.repeat(300)
  const serialized = stripEvent(rawUsageEvent(), project)

  assert.deepEqual(Object.keys(serialized), EVENT_KEYS)
  assert.deepEqual(serialized, {
    id: 'sync-contract-event',
    timestampMs: Date.parse('2026-07-10T00:00:00Z'),
    sessionId: 'sync-contract-session',
    sessionKey: null,
    agent: 'codex',
    provider: 'openai',
    model: 'gpt-5.6-sol',
    channel: 'cli',
    inputTokens: 11,
    outputTokens: 7,
    reasoningTokens: 3,
    cacheReadTokens: 5,
    cacheWriteTokens: 2,
    totalTokens: 28,
    inputCost: 0.11,
    outputCost: 0.07,
    reasoningCost: 0.03,
    cacheReadCost: 0.05,
    cacheWriteCost: 0.02,
    totalCost: 0.28,
    stopReason: 'end_turn',
    project: 'p'.repeat(256),
    pricingStatus: 'estimated',
    pricingTier: 'standard',
    priceVersion: '2026-07-10/gpt-5.6-sol',
    matchedModelId: 'gpt-5.6-sol',
    tokenSemantics: 'disjoint',
    unallocatedCost: 0,
    breakdownStatus: 'reconciled',
  })

  for (const forbidden of ['sourcePath', 'prompt', 'content', 'messages', 'raw', 'secret', 'unknown']) {
    assert.equal(Object.prototype.hasOwnProperty.call(serialized, forbidden), false, forbidden)
  }
  assert.equal(JSON.parse(JSON.stringify(serialized)).sessionKey, null)
  assert.equal(JSON.parse(JSON.stringify(serialized)).unallocatedCost, 0)
}

function testStripEventNormalizesUnpricedProvenance() {
  const serialized = stripEvent(unpricedEvent())

  assert.equal(serialized.pricingStatus, 'unpriced')
  assert.equal(serialized.pricingTier, null)
  assert.equal(serialized.priceVersion, null)
  assert.equal(serialized.matchedModelId, null)
  assert.equal(serialized.inputCost, 0)
  assert.equal(serialized.outputCost, 0)
  assert.equal(serialized.reasoningCost, 0)
  assert.equal(serialized.cacheReadCost, 0)
  assert.equal(serialized.cacheWriteCost, 0)
  assert.equal(serialized.totalCost, 0)
  assert.equal(serialized.unallocatedCost, 0)
  assert.equal(serialized.project, null)

  const roundTripped = JSON.parse(JSON.stringify(serialized)) as Record<string, unknown>
  for (const field of [
    'pricingTier',
    'priceVersion',
    'matchedModelId',
    'inputCost',
    'outputCost',
    'reasoningCost',
    'cacheReadCost',
    'cacheWriteCost',
    'totalCost',
    'unallocatedCost',
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(roundTripped, field), true, field)
  }
}

function testMissingRpcErrorMatchesOnlyPgrst202() {
  assert.equal(isMissingRpcError({ code: 'PGRST202', message: 'missing function' }), true)
  assert.equal(isMissingRpcError({ code: '42501', message: 'forbidden' }), false)
  assert.equal(isMissingRpcError({ code: '22023', message: 'invalid argument' }), false)
  assert.equal(isMissingRpcError(new Error('network down')), false)
  assert.equal(isMissingRpcError(null), false)
}

async function testDirectV2UploadReturnsServerCount() {
  const params = {
    p_token: 'direct-v2-token',
    p_events: [stripEvent(rawUsageEvent()), stripEvent(rawUsageEvent({ id: 'event-2' }))],
    p_sync_states: [],
  }
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []

  const result = await uploadEventBatch(async (name, args) => {
    calls.push({ name, args })
    return { data: { ok: true, inserted: 2 }, error: null }
  }, params)

  assert.deepEqual(result, { ok: true, inserted: 2 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'tokend_upload_events_v2')
  assert.strictEqual(calls[0].args, params)
}

async function testPgrst202FallsBackWithIdenticalSanitizedParams() {
  const params = {
    p_token: 'fallback-token',
    p_events: [stripEvent(rawUsageEvent()), stripEvent(rawUsageEvent({ id: 'event-2' }))],
    p_sync_states: [],
  }
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []

  const result = await uploadEventBatch(async (name, args) => {
    calls.push({ name, args })
    if (name === 'tokend_upload_events_v2') {
      return {
        data: null,
        error: { code: 'PGRST202', message: 'function not found', cause: 'schema cache' },
      }
    }
    return { data: { ok: true, inserted: 2 }, error: null }
  }, params)

  assert.deepEqual(result, { ok: true, inserted: 2 })
  assert.deepEqual(calls.map(call => call.name), [
    'tokend_upload_events_v2',
    'tokend_upload_events',
  ])
  assert.strictEqual(calls[0].args, params)
  assert.strictEqual(calls[1].args, params)
  assert.deepEqual(calls[0].args, calls[1].args)
  for (const event of params.p_events) {
    assert.equal(Object.prototype.hasOwnProperty.call(event, 'secret'), false)
  }
}

async function testNonMissingRpcErrorsNeverFallback() {
  for (const code of ['42501', '22023']) {
    const calls: string[] = []
    const cause = new Error(`${code} cause`)
    const rpcError = { code, message: `${code} rejected`, cause }

    await assert.rejects(
      uploadEventBatch(async (name) => {
        calls.push(name)
        return { data: null, error: rpcError }
      }, {
        p_token: `${code}-token`,
        p_events: [],
        p_sync_states: [],
      }),
      (actual: unknown) => {
        assert.strictEqual(actual, rpcError)
        assert.equal((actual as typeof rpcError).code, code)
        assert.equal((actual as typeof rpcError).message, `${code} rejected`)
        assert.strictEqual((actual as typeof rpcError).cause, cause)
        return true
      },
    )

    assert.deepEqual(calls, ['tokend_upload_events_v2'])
  }
}

async function testNetworkErrorsNeverFallback() {
  const calls: string[] = []
  const cause = new Error('socket closed')
  const networkError = Object.assign(new Error('network down'), { code: 'ECONNRESET', cause })

  await assert.rejects(
    uploadEventBatch(async (name) => {
      calls.push(name)
      throw networkError
    }, {
      p_token: 'network-token',
      p_events: [],
      p_sync_states: [],
    }),
    (actual: unknown) => {
      assert.strictEqual(actual, networkError)
      assert.equal((actual as typeof networkError).code, 'ECONNRESET')
      assert.equal((actual as typeof networkError).message, 'network down')
      assert.strictEqual((actual as typeof networkError).cause, cause)
      return true
    },
  )

  assert.deepEqual(calls, ['tokend_upload_events_v2'])
}

async function testBusinessFailureRejects() {
  const calls: string[] = []

  await assert.rejects(
    uploadEventBatch(async (name) => {
      calls.push(name)
      return { data: { ok: false, error: 'invalid_token' }, error: null }
    }, {
      p_token: 'business-failure-token',
      p_events: [],
      p_sync_states: [],
    }),
    /invalid_token/i,
  )

  assert.deepEqual(calls, ['tokend_upload_events_v2'])
}

async function testProductionLoopKeepsUnpricedAndAccumulatesInserted() {
  const unpriced = stripEvent(unpricedEvent())
  const priced = stripEvent(rawUsageEvent({ id: 'priced-event' }))
  const syncStates = [{ sourcePathHash: 'hash', lastProcessedLines: 2, parserVersion: 3 }]
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []

  const inserted = await uploadSyncPayload({
    token: 'batch-token',
    events: [unpriced, priced],
    messages: [],
    syncStates,
    batchSize: 1,
    rpc: async (name, args) => {
      calls.push({ name, args })
      const events = args.p_events as Record<string, unknown>[]
      return { data: { ok: true, inserted: events.length }, error: null }
    },
  })

  assert.equal(inserted, 2)
  assert.deepEqual(calls.map(call => call.name), [
    'tokend_upload_events_v2',
    'tokend_upload_events_v2',
  ])
  assert.strictEqual((calls[0].args.p_events as unknown[])[0], unpriced)
  assert.equal(((calls[0].args.p_events as Record<string, unknown>[])[0]).pricingStatus, 'unpriced')
  assert.deepEqual(calls[0].args.p_sync_states, [])
  assert.deepEqual(calls[1].args.p_sync_states, syncStates)
}

async function testFallbackPreservesMessageThenStateOrdering() {
  const events = [stripEvent(rawUsageEvent())]
  const messages = [{ id: 'message-1' }]
  const syncStates = [{ sourcePathHash: 'ordering', lastProcessedLines: 9, parserVersion: 3 }]
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []

  const inserted = await uploadSyncPayload({
    token: 'ordering-token',
    events,
    messages,
    syncStates,
    rpc: async (name, args) => {
      calls.push({ name, args })
      if (name === 'tokend_upload_events_v2') {
        return { data: null, error: { code: 'PGRST202', message: 'missing v2' } }
      }
      if (name === 'tokend_upload_events') {
        return {
          data: { ok: true, inserted: (args.p_events as unknown[]).length },
          error: null,
        }
      }
      return { data: { ok: true }, error: null }
    },
  })

  assert.equal(inserted, 1)
  assert.deepEqual(calls.map(call => call.name), [
    'tokend_upload_events_v2',
    'tokend_upload_events',
    'tokend_upload_messages',
    'tokend_upload_events_v2',
    'tokend_upload_events',
  ])
  assert.deepEqual(calls[0].args.p_sync_states, [])
  assert.deepEqual(calls[1].args.p_sync_states, [])
  assert.deepEqual(calls[3].args.p_events, [])
  assert.deepEqual(calls[3].args.p_sync_states, syncStates)
  assert.strictEqual(calls[3].args, calls[4].args)
}

async function testMessageBusinessFailureLeavesStateUncommitted() {
  const syncStates = [{ sourcePathHash: 'message-failure', lastProcessedLines: 5, parserVersion: 3 }]
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []

  await assert.rejects(
    uploadSyncPayload({
      token: 'message-failure-token',
      events: [stripEvent(rawUsageEvent())],
      messages: [{ id: 'message-failure' }],
      syncStates,
      rpc: async (name, args) => {
        calls.push({ name, args })
        if (name === 'tokend_upload_messages') {
          return { data: { ok: false, error: 'message_invalid' }, error: null }
        }
        return { data: { ok: true, inserted: 1 }, error: null }
      },
    }),
    /message.*message_invalid/i,
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

async function main() {
  testStripEventUsesExactAllowlist()
  testStripEventNormalizesUnpricedProvenance()
  testMissingRpcErrorMatchesOnlyPgrst202()
  await testDirectV2UploadReturnsServerCount()
  await testPgrst202FallsBackWithIdenticalSanitizedParams()
  await testNonMissingRpcErrorsNeverFallback()
  await testNetworkErrorsNeverFallback()
  await testBusinessFailureRejects()
  await testProductionLoopKeepsUnpricedAndAccumulatesInserted()
  await testFallbackPreservesMessageThenStateOrdering()
  await testMessageBusinessFailureLeavesStateUncommitted()
  console.log('cli sync contract tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
