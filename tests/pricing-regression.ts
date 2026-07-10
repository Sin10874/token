import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  CATALOG_HASH,
  CATALOG_SNAPSHOT,
  CATALOG_VERSION,
  getDefaultSeedRows,
  MODEL_ALIASES,
  PRICE_VERSIONS,
  computeCatalogHash,
  resolveModelPrice,
  validateCatalog,
} from '../cli/pricing/catalog.ts'
import { estimateCost } from '../cli/pricing/estimate.ts'
import type { CatalogSnapshot, PriceVersion, PricingEvent } from '../cli/pricing/types.ts'
import { applyEstimatedCosts } from '../cli/prices.ts'
import type { RawUsageEvent } from '../server/ingestion/parser.ts'

function testCatalogResolution() {
  assert.equal(PRICE_VERSIONS, CATALOG_SNAPSHOT.rows)
  assert.equal(MODEL_ALIASES, CATALOG_SNAPSHOT.aliases)

  assert.equal(resolveModelPrice('gpt-5.6-sol'), 'gpt-5.6-sol')
  assert.equal(resolveModelPrice('gpt-5.6-terra'), 'gpt-5.6-terra')
  assert.equal(resolveModelPrice('gpt-5.6-luna'), 'gpt-5.6-luna')
  assert.equal(resolveModelPrice('gpt-5.6'), 'gpt-5.6-sol')
  assert.equal(resolveModelPrice('gpt-5.6-sol-20260709'), 'gpt-5.6-sol')
  assert.equal(resolveModelPrice('gpt-5.6-20260709'), 'gpt-5.6-sol')

  assert.equal(resolveModelPrice('fable-5'), 'claude-fable-5')
  assert.equal(resolveModelPrice('anthropic/claude-fable-5'), 'claude-fable-5')
  assert.equal(resolveModelPrice('claude-fable-5-thinking'), 'claude-fable-5')

  assert.equal(resolveModelPrice('k2p7'), 'kimi-k2.7')
  assert.equal(resolveModelPrice('k2p6'), 'kimi-k2.6')
  assert.equal(resolveModelPrice('k2p5'), 'kimi-k2.5')
  assert.equal(resolveModelPrice('kimi-for-coding'), 'kimi-k2.5')
  assert.equal(resolveModelPrice('kimi-code/kimi-for-coding'), 'kimi-k2.5')
  assert.equal(resolveModelPrice('M-3'), 'MiniMax-M3')
  assert.equal(resolveModelPrice('M-2.7'), 'MiniMax-M2.7')

  assert.equal(resolveModelPrice('gpt-5.6-sol-20261340'), null)
  assert.equal(resolveModelPrice('gpt-5.6-sol-2026070'), null)
  assert.equal(resolveModelPrice('gpt-5.6-sol-202607099'), null)
  assert.equal(resolveModelPrice('vendor-gpt-5.6-sol'), null)

  assert.equal(CATALOG_VERSION, '2026-07-10')
  assert.match(CATALOG_HASH, /^[a-f0-9]{64}$/)

  const rowOrder = CATALOG_SNAPSHOT.rows.map(row => `${row.modelId}\u0000${row.validFrom}`)
  assert.deepEqual(rowOrder, [...rowOrder].sort())
  const aliasOrder = Object.keys(CATALOG_SNAPSHOT.aliases)
  assert.deepEqual(aliasOrder, [...aliasOrder].sort())

  assert.deepEqual(CATALOG_SNAPSHOT.aliases, {
    'M-2.7': 'MiniMax-M2.7',
    'M-3': 'MiniMax-M3',
    'anthropic/claude-fable-5': 'claude-fable-5',
    'claude-fable-5-thinking': 'claude-fable-5',
    'fable-5': 'claude-fable-5',
    'gpt-5.6': 'gpt-5.6-sol',
    'k2p5': 'kimi-k2.5',
    'k2p6': 'kimi-k2.6',
    'k2p7': 'kimi-k2.7',
    'kimi-code/kimi-for-coding': 'kimi-k2.5',
    'kimi-for-coding': 'kimi-k2.5',
  })

  const officialRows = CATALOG_SNAPSHOT.rows.filter(row => !row.sourceUrl.startsWith('legacy:'))
  assert.deepEqual(officialRows, [
    {
      modelId: 'claude-fable-5',
      provider: 'anthropic',
      catalogVersion: '2026-07-10',
      validFrom: '2026-06-09T00:00:00Z',
      standard: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      sourceCheckedAt: '2026-07-10',
      sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    },
    {
      modelId: 'gpt-5.6-luna',
      provider: 'openai',
      catalogVersion: '2026-07-10',
      validFrom: '2026-06-26T00:00:00Z',
      standard: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
      longContext: { input: 2, output: 9, cacheRead: 0.2, cacheWrite: 2.5 },
      longContextThreshold: 272_000,
      sourceCheckedAt: '2026-07-10',
      sourceUrl: 'https://developers.openai.com/api/docs/pricing',
    },
    {
      modelId: 'gpt-5.6-sol',
      provider: 'openai',
      catalogVersion: '2026-07-10',
      validFrom: '2026-06-26T00:00:00Z',
      standard: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      longContext: { input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 },
      longContextThreshold: 272_000,
      sourceCheckedAt: '2026-07-10',
      sourceUrl: 'https://developers.openai.com/api/docs/pricing',
    },
    {
      modelId: 'gpt-5.6-terra',
      provider: 'openai',
      catalogVersion: '2026-07-10',
      validFrom: '2026-06-26T00:00:00Z',
      standard: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
      longContext: { input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 6.25 },
      longContextThreshold: 272_000,
      sourceCheckedAt: '2026-07-10',
      sourceUrl: 'https://developers.openai.com/api/docs/pricing',
    },
  ])
}

function attemptMutation(mutate: () => void): void {
  try {
    mutate()
  } catch (error) {
    assert.ok(error instanceof TypeError)
  }
}

function testDefaultCatalogIsDeeplyImmutable() {
  assert.equal(Object.isFrozen(PRICE_VERSIONS), true)
  assert.equal(Object.isFrozen(MODEL_ALIASES), true)
  assert.equal(Object.isFrozen(CATALOG_SNAPSHOT), true)
  for (const row of PRICE_VERSIONS) {
    assert.equal(Object.isFrozen(row), true)
    assert.equal(Object.isFrozen(row.standard), true)
    if (row.longContext) assert.equal(Object.isFrozen(row.longContext), true)
  }

  const sol = PRICE_VERSIONS.find(row => row.modelId === 'gpt-5.6-sol')!
  const originalInputRate = sol.standard.input
  const originalAlias = MODEL_ALIASES['gpt-5.6']
  const originalRowCount = PRICE_VERSIONS.length
  const originalHash = CATALOG_SNAPSHOT.hash
  const originalCost = estimateCost(pricedEvent()).totalCost

  attemptMutation(() => { sol.standard.input = 999 })
  attemptMutation(() => { sol.provider = 'mutated-provider' })
  attemptMutation(() => { MODEL_ALIASES['gpt-5.6'] = 'gpt-5.6-luna' })
  attemptMutation(() => { PRICE_VERSIONS.push({ ...sol, modelId: 'mutated-model' }) })
  attemptMutation(() => { CATALOG_SNAPSHOT.hash = '0'.repeat(64) })
  attemptMutation(() => { CATALOG_SNAPSHOT.rows = [] })

  assert.equal(sol.standard.input, originalInputRate)
  assert.equal(sol.provider, 'openai')
  assert.equal(MODEL_ALIASES['gpt-5.6'], originalAlias)
  assert.equal(PRICE_VERSIONS.length, originalRowCount)
  assert.equal(CATALOG_SNAPSHOT.hash, originalHash)
  assert.equal(CATALOG_SNAPSHOT.rows, PRICE_VERSIONS)
  assert.equal(estimateCost(pricedEvent()).totalCost, originalCost)
}

function testLegacyCatalogRemainsInSharedCatalog() {
  const actualLegacyRows = CATALOG_SNAPSHOT.rows.filter(row => row.sourceUrl === 'legacy:tokend-cli-2.4.0')

  assert.equal(actualLegacyRows.length, 39)
  assert.equal(new Set(actualLegacyRows.map(row => row.modelId)).size, 39)
  assert.deepEqual(actualLegacyRows.find(row => row.modelId === 'gpt-5.4'), {
    modelId: 'gpt-5.4',
    provider: 'openai',
    catalogVersion: '2026-07-10',
    validFrom: '2026-06-12T00:00:00Z',
    standard: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
    sourceCheckedAt: '2026-06-12',
    sourceUrl: 'legacy:tokend-cli-2.4.0',
  })

  const wrapperSource = fs.readFileSync(path.resolve(process.cwd(), 'cli/prices.ts'), 'utf8')
  assert.doesNotMatch(wrapperSource, /DEFAULT_MODEL_PRICES|MODEL_PRICE_ALIASES|interface ModelPrice/)
  assert.match(wrapperSource, /estimateCost/)
}

function catalogRow(overrides: Partial<PriceVersion> = {}): PriceVersion {
  return {
    modelId: 'test-model',
    provider: 'test-provider',
    catalogVersion: 'test-version',
    validFrom: '2026-01-01T00:00:00Z',
    standard: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
    sourceCheckedAt: '2026-01-02',
    sourceUrl: 'https://example.com/pricing',
    ...overrides,
  }
}

function testCatalogValidation() {
  assert.equal(typeof validateCatalog, 'function', 'validateCatalog should be exported')

  assert.doesNotThrow(() => validateCatalog([
    catalogRow({ validTo: '2026-02-01T00:00:00Z' }),
    catalogRow({ validFrom: '2026-02-01T00:00:00Z' }),
  ], {}))

  assert.throws(() => validateCatalog([
    catalogRow(),
    catalogRow(),
  ], {}), /duplicate/i)

  assert.throws(() => validateCatalog([
    catalogRow({ validTo: '2026-03-01T00:00:00Z' }),
    catalogRow({ validFrom: '2026-02-01T00:00:00Z' }),
  ], {}), /overlap/i)

  assert.throws(() => validateCatalog([
    catalogRow({ standard: { input: -1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } }),
  ], {}), /rate/i)
  assert.throws(() => validateCatalog([
    catalogRow({
      longContext: { input: 1, output: Number.POSITIVE_INFINITY, cacheRead: 0.1, cacheWrite: 1.25 },
      longContextThreshold: 272_000,
    }),
  ], {}), /rate/i)
  assert.throws(() => validateCatalog([
    catalogRow({ sourceCheckedAt: '' }),
  ], {}), /sourceCheckedAt/i)
  assert.throws(() => validateCatalog([
    catalogRow({ sourceUrl: '' }),
  ], {}), /sourceUrl/i)
  assert.throws(() => validateCatalog([
    catalogRow({ validFrom: 'not-a-time' }),
  ], {}), /validFrom/i)
  assert.throws(() => validateCatalog([
    catalogRow({ validTo: 'not-a-time' }),
  ], {}), /validTo/i)
  assert.throws(() => validateCatalog([
    catalogRow({ validTo: '2026-01-01T00:00:00Z' }),
  ], {}), /interval/i)
  assert.throws(() => validateCatalog([
    catalogRow({
      longContext: { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 },
      longContextThreshold: -1,
    }),
  ], {}), /threshold/i)
  assert.throws(() => validateCatalog([
    catalogRow({ standard: { input: 1, output: 2, cacheRead: 0.1 } as PriceVersion['standard'] }),
  ], {}), /rate/i)

  assert.throws(() => validateCatalog([catalogRow()], {
    a: 'b',
    b: 'a',
  }), /cycle/i)
  assert.throws(() => validateCatalog([catalogRow()], {
    'test-model': 'other-model',
  }), /collision/i)
  assert.throws(() => validateCatalog([catalogRow()], {
    alias: 'missing-model',
  }), /target/i)

  for (const [field, value] of [
    ['modelId', '   '],
    ['provider', '\t'],
    ['catalogVersion', '\n'],
  ] as const) {
    assert.throws(
      () => validateCatalog([catalogRow({ [field]: value })], {}),
      new RegExp(field, 'i'),
    )
  }

  assert.throws(() => validateCatalog([
    catalogRow({ sourceCheckedAt: '2026-02-30' }),
  ], {}), /sourceCheckedAt/i)
  assert.throws(() => validateCatalog([
    catalogRow({ sourceCheckedAt: '2026-2-03' }),
  ], {}), /sourceCheckedAt/i)
  assert.doesNotThrow(() => validateCatalog([
    catalogRow({ sourceCheckedAt: '2024-02-29' }),
  ], {}))

  for (const sourceUrl of [
    'ftp://example.com/pricing',
    'not-a-url',
    'legacy:',
  ]) {
    assert.throws(
      () => validateCatalog([catalogRow({ sourceUrl })], {}),
      /sourceUrl/i,
    )
  }
  assert.doesNotThrow(() => validateCatalog([
    catalogRow({ sourceUrl: 'http://example.com/pricing' }),
  ], {}))
  assert.doesNotThrow(() => validateCatalog([
    catalogRow({ sourceUrl: 'legacy:test-catalog-v1' }),
  ], {}))

  for (const validFrom of [
    '2026-02-30T00:00:00Z',
    '2026-01-01T00:00:00+00:00',
    '2026-01-01',
  ]) {
    assert.throws(
      () => validateCatalog([catalogRow({ validFrom })], {}),
      /validFrom/i,
    )
  }
  assert.throws(() => validateCatalog([
    catalogRow({ validTo: '2026-02-30T00:00:00Z' }),
  ], {}), /validTo/i)
  assert.doesNotThrow(() => validateCatalog([
    catalogRow({
      validFrom: '2026-01-01T00:00:00.123Z',
      validTo: '2026-02-01T00:00:00.456Z',
    }),
  ], {}))

  const longRates = { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 }
  assert.throws(() => validateCatalog([
    catalogRow({ longContext: longRates }),
  ], {}), /threshold|longContext/i)
  assert.throws(() => validateCatalog([
    catalogRow({ longContextThreshold: 272_000 }),
  ], {}), /threshold|longContext/i)
  assert.throws(() => validateCatalog([
    catalogRow({ longContext: longRates, longContextThreshold: 0 }),
  ], {}), /threshold/i)
  assert.throws(() => validateCatalog([
    catalogRow({ longContext: longRates, longContextThreshold: 1.5 }),
  ], {}), /threshold/i)
  assert.throws(() => validateCatalog([
    catalogRow({
      longContext: null as unknown as PriceVersion['longContext'],
      longContextThreshold: 1,
    }),
  ], {}), /rate|longContext/i)
  assert.doesNotThrow(() => validateCatalog([
    catalogRow({ longContext: longRates, longContextThreshold: 1 }),
  ], {}))
}

function testCatalogHashIsStableAcrossObjectKeyOrder() {
  const standard = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 }
  const first = catalogRow({ standard })
  const reordered = {
    sourceUrl: first.sourceUrl,
    sourceCheckedAt: first.sourceCheckedAt,
    standard: {
      cacheWrite: standard.cacheWrite,
      cacheRead: standard.cacheRead,
      output: standard.output,
      input: standard.input,
    },
    validFrom: first.validFrom,
    catalogVersion: first.catalogVersion,
    provider: first.provider,
    modelId: first.modelId,
  } as PriceVersion

  const firstHash = computeCatalogHash({
    version: 'hash-test',
    rows: [first],
    aliases: { zed: 'test-model', alpha: 'test-model' },
  })
  const reorderedHash = computeCatalogHash({
    aliases: { alpha: 'test-model', zed: 'test-model' },
    rows: [reordered],
    version: 'hash-test',
  })

  assert.equal(firstHash, reorderedHash)
  assert.match(firstHash, /^[a-f0-9]{64}$/)

  const reversedRowsHash = computeCatalogHash({
    version: 'hash-test',
    rows: [catalogRow({ modelId: 'z-model' }), first].reverse(),
    aliases: {},
  })
  const sortedRowsHash = computeCatalogHash({
    version: 'hash-test',
    rows: [first, catalogRow({ modelId: 'z-model' })],
    aliases: {},
  })
  assert.equal(reversedRowsHash, sortedRowsHash)

  const changedRateHash = computeCatalogHash({
    version: 'hash-test',
    rows: [catalogRow({ standard: { ...standard, input: 1.01 } })],
    aliases: { zed: 'test-model', alpha: 'test-model' },
  })
  assert.notEqual(changedRateHash, firstHash)
}

function pricedEvent(overrides: Partial<PricingEvent> = {}): PricingEvent {
  return {
    model: 'gpt-5.6-sol',
    timestampMs: Date.parse('2026-07-09T00:00:00Z'),
    inputTokens: 100_000,
    outputTokens: 20_000,
    reasoningTokens: 5_000,
    cacheReadTokens: 50_000,
    cacheWriteTokens: 10_000,
    inputCost: 0,
    outputCost: 0,
    reasoningCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    totalCost: 0,
    tokenSemantics: 'disjoint',
    ...overrides,
  }
}

function rawUsageEvent(overrides: Partial<RawUsageEvent> = {}): RawUsageEvent {
  return {
    id: 'pricing-wrapper-event',
    timestampMs: Date.parse('2026-07-09T12:00:00Z'),
    sessionId: 'pricing-wrapper-session',
    sessionKey: null,
    agent: 'pricing-regression',
    provider: 'openai',
    model: 'gpt-5.6-sol',
    channel: 'test',
    inputTokens: 100_000,
    outputTokens: 20_000,
    reasoningTokens: 5_000,
    cacheReadTokens: 50_000,
    cacheWriteTokens: 10_000,
    tokenSemantics: 'disjoint',
    totalTokens: 185_000,
    inputCost: 0,
    outputCost: 0,
    reasoningCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    totalCost: 0,
    sourcePath: '/tmp/pricing-wrapper.jsonl',
    stopReason: 'end_turn',
    ...overrides,
  }
}

function testApplyEstimatedCostsCompatibilityWrapper() {
  const estimated = rawUsageEvent()
  const returned = applyEstimatedCosts(estimated)

  assert.equal(estimated.inputCost, 0.5)
  assert.equal(estimated.outputCost, 0.6)
  assert.equal(estimated.reasoningCost, 0.15)
  assert.equal(estimated.cacheReadCost, 0.025)
  assert.equal(estimated.cacheWriteCost, 0.0625)
  assert.equal(estimated.totalCost, 1.3375)
  assert.equal(estimated.unallocatedCost, 0)
  assert.equal(estimated.pricingStatus, 'estimated')
  assert.equal(estimated.pricingTier, 'standard')
  assert.equal(estimated.matchedModelId, 'gpt-5.6-sol')
  assert.ok(estimated.priceVersion)
  assert.equal(estimated.breakdownStatus, 'reconciled')
  assert.equal(Object.prototype.hasOwnProperty.call(estimated, 'catalogHash'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(estimated, 'warnings'), false)
  assert.equal(returned, estimated)

  const inferredReported = rawUsageEvent({
    model: 'unknown-model',
    inputCost: 0.1,
    outputCost: 0.2,
    reasoningCost: 0.3,
    cacheReadCost: 0.4,
    cacheWriteCost: 0.5,
    totalCost: 2,
  })
  const reportedCosts = {
    inputCost: inferredReported.inputCost,
    outputCost: inferredReported.outputCost,
    reasoningCost: inferredReported.reasoningCost,
    cacheReadCost: inferredReported.cacheReadCost,
    cacheWriteCost: inferredReported.cacheWriteCost,
    totalCost: inferredReported.totalCost,
  }

  assert.equal(applyEstimatedCosts(inferredReported), inferredReported)
  assert.deepEqual({
    inputCost: inferredReported.inputCost,
    outputCost: inferredReported.outputCost,
    reasoningCost: inferredReported.reasoningCost,
    cacheReadCost: inferredReported.cacheReadCost,
    cacheWriteCost: inferredReported.cacheWriteCost,
    totalCost: inferredReported.totalCost,
  }, reportedCosts)
  assert.equal(inferredReported.pricingStatus, 'reported')
  assert.equal(inferredReported.unallocatedCost, 0.5)
  assert.equal(inferredReported.breakdownStatus, 'unallocated')

  const explicitlyReported = rawUsageEvent({
    pricingStatus: 'reported',
    inputCost: 0.6,
    outputCost: 0.7,
    reasoningCost: 0.8,
    cacheReadCost: 0.9,
    cacheWriteCost: 1,
    totalCost: 4,
  })
  const explicitCosts = {
    inputCost: explicitlyReported.inputCost,
    outputCost: explicitlyReported.outputCost,
    reasoningCost: explicitlyReported.reasoningCost,
    cacheReadCost: explicitlyReported.cacheReadCost,
    cacheWriteCost: explicitlyReported.cacheWriteCost,
    totalCost: explicitlyReported.totalCost,
  }

  applyEstimatedCosts(explicitlyReported)
  assert.deepEqual({
    inputCost: explicitlyReported.inputCost,
    outputCost: explicitlyReported.outputCost,
    reasoningCost: explicitlyReported.reasoningCost,
    cacheReadCost: explicitlyReported.cacheReadCost,
    cacheWriteCost: explicitlyReported.cacheWriteCost,
    totalCost: explicitlyReported.totalCost,
  }, explicitCosts)
  assert.equal(explicitlyReported.pricingStatus, 'reported')
}

function testDefaultSeedRowsComeFromEffectiveCatalogVersions() {
  const rows = getDefaultSeedRows()
  assert.equal(Object.isFrozen(rows), true)
  const modelIds = rows.map(row => row[0])
  assert.deepEqual(modelIds, [...modelIds].sort())
  assert.equal(new Set(modelIds).size, modelIds.length)
  assert.equal(rows.length, new Set(PRICE_VERSIONS.map(row => row.modelId)).size)
  assert.equal(modelIds.includes('gpt-5.6'), false)
  assert.equal(modelIds.includes('k2p5'), false)

  const rowsByModel = new Map(rows.map(row => [row[0], row]))
  assert.deepEqual(rowsByModel.get('claude-fable-5'), [
    'claude-fable-5', 'anthropic', 10, 50, 1, 12.5,
  ])
  assert.deepEqual(rowsByModel.get('gpt-5.6-sol'), [
    'gpt-5.6-sol', 'openai', 5, 30, 0.5, 6.25,
  ])
  assert.deepEqual(rowsByModel.get('gpt-5.6-terra'), [
    'gpt-5.6-terra', 'openai', 2.5, 15, 0.25, 3.125,
  ])
  assert.deepEqual(rowsByModel.get('gpt-5.6-luna'), [
    'gpt-5.6-luna', 'openai', 1, 6, 0.1, 1.25,
  ])

  assert.throws(
    () => getDefaultSeedRows(Date.parse('2026-06-08T23:59:59.999Z')),
    /effective.*price|price.*effective/i,
  )

  const solCatalogRow = PRICE_VERSIONS.find(row => row.modelId === 'gpt-5.6-sol')!
  const solSeedRow = rowsByModel.get('gpt-5.6-sol')!
  const mutableSolSeedRow = solSeedRow as unknown as number[]
  const catalogInputRate = solCatalogRow.standard.input
  attemptMutation(() => {
    mutableSolSeedRow[2] = 999
  })
  assert.equal(solCatalogRow.standard.input, catalogInputRate)
  assert.deepEqual(getDefaultSeedRows(), rows)
}

function testSqliteInitializationUsesSharedCatalogSeeds() {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'server/db/index.ts'), 'utf8')

  assert.match(
    source,
    /import\s+\{\s*getDefaultSeedRows\s*\}\s+from\s+['"]\.\.\/\.\.\/cli\/pricing\/catalog(?:\.js|\.ts)['"]/,
  )
  assert.doesNotMatch(source, /DEFAULT_MODEL_PRICES/)
  assert.match(source, /of\s+getDefaultSeedRows\(\)/)
}

function testStandardEstimationAndEffectiveDates() {
  const sol = estimateCost(pricedEvent())
  assert.equal(sol.matchedModelId, 'gpt-5.6-sol')
  assert.equal(sol.status, 'estimated')
  assert.equal(sol.tier, 'standard')
  assert.equal(sol.priceVersion, '2026-07-10/gpt-5.6-sol/2026-06-26T00:00:00Z')
  assert.equal(sol.catalogHash, CATALOG_HASH)
  assert.equal(sol.inputCost, 0.5)
  assert.equal(sol.outputCost, 0.6)
  assert.equal(sol.reasoningCost, 0.15)
  assert.equal(sol.cacheReadCost, 0.025)
  assert.equal(sol.cacheWriteCost, 0.0625)
  assert.equal(sol.unallocatedCost, 0)
  assert.equal(sol.totalCost, 1.3375)
  assert.equal(sol.breakdownStatus, 'reconciled')

  // A 1M disjoint prompt is long-context; 2.5 is asserted as the standard catalog rate.
  const terraRow = CATALOG_SNAPSHOT.rows.find(row => row.modelId === 'gpt-5.6-terra')
  const lunaRow = CATALOG_SNAPSHOT.rows.find(row => row.modelId === 'gpt-5.6-luna')
  assert.equal(terraRow?.standard.input, 2.5)
  assert.equal(lunaRow?.standard.output, 6)

  const fable = estimateCost(pricedEvent({
    model: 'fable-5',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    reasoningTokens: 0,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
  }))
  assert.equal(fable.matchedModelId, 'claude-fable-5')
  assert.equal(fable.totalCost, 73.5)
  assert.equal(fable.tier, 'standard')

  const fableBeforeLaunch = estimateCost(pricedEvent({
    model: 'claude-fable-5',
    timestampMs: Date.parse('2026-06-08T23:59:59.999Z'),
  }))
  assert.equal(fableBeforeLaunch.status, 'unpriced')
  assert.equal(fableBeforeLaunch.priceVersion, null)

  const legacyBeforeSnapshot = estimateCost(pricedEvent({
    model: 'gpt-5.4',
    timestampMs: Date.parse('2026-06-11T23:59:59.999Z'),
  }))
  assert.equal(legacyBeforeSnapshot.status, 'unpriced')

  const legacyAtSnapshot = estimateCost(pricedEvent({
    model: 'gpt-5.4',
    timestampMs: Date.parse('2026-06-12T00:00:00Z'),
    inputTokens: 1_000_000,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }))
  assert.equal(legacyAtSnapshot.status, 'legacy')
  assert.equal(legacyAtSnapshot.totalCost, 2.5)

  const unknown = estimateCost(pricedEvent({ model: 'vendor-gpt-5.6-sol' }))
  assert.equal(unknown.status, 'unpriced')
  assert.equal(unknown.matchedModelId, null)

  const missingTimestamp = estimateCost(pricedEvent({ timestampMs: undefined }))
  assert.equal(missingTimestamp.status, 'unpriced')
  assert.ok(missingTimestamp.warnings.some(warning => /timestamp/i.test(warning)))

  const nanTimestamp = estimateCost(pricedEvent({ timestampMs: Number.NaN }))
  assert.equal(nanTimestamp.status, 'unpriced')
  assert.ok(nanTimestamp.warnings.some(warning => /timestamp/i.test(warning)))
}

function testLongContextTierSelection() {
  const exactThreshold = estimateCost(pricedEvent({
    inputTokens: 100_000,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 100_000,
    cacheWriteTokens: 72_000,
  }))
  assert.equal(exactThreshold.tier, 'standard')

  const aboveThreshold = estimateCost(pricedEvent({
    inputTokens: 100_000,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 100_000,
    cacheWriteTokens: 72_001,
  }))
  assert.equal(aboveThreshold.tier, 'long_context')

  const sol = estimateCost(pricedEvent({
    inputTokens: 273_000,
    outputTokens: 10_000,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }))
  assert.equal(sol.tier, 'long_context')
  assert.equal(sol.inputCost, 2.73)
  assert.equal(sol.outputCost, 0.45)
  assert.equal(sol.totalCost, 3.18)

  const solCacheBuckets = estimateCost(pricedEvent({
    inputTokens: 0,
    outputTokens: 10_000,
    reasoningTokens: 0,
    cacheReadTokens: 273_000,
    cacheWriteTokens: 273_000,
  }))
  assert.equal(solCacheBuckets.tier, 'long_context')
  assert.equal(solCacheBuckets.outputCost, 0.45)
  assert.equal(solCacheBuckets.cacheReadCost, 0.273)
  assert.equal(solCacheBuckets.cacheWriteCost, 3.4125)

  const terra = estimateCost(pricedEvent({
    model: 'gpt-5.6-terra',
    inputTokens: 273_000,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }))
  assert.equal(terra.tier, 'long_context')
  assert.equal(terra.totalCost, 1.365)

  const luna = estimateCost(pricedEvent({
    model: 'gpt-5.6-luna',
    inputTokens: 273_000,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }))
  assert.equal(luna.tier, 'long_context')
  assert.equal(luna.totalCost, 0.546)

  const unknownSemantics = estimateCost(pricedEvent({
    inputTokens: 273_000,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokenSemantics: 'unknown',
  }))
  assert.equal(unknownSemantics.tier, 'standard')
  assert.equal(unknownSemantics.totalCost, 1.365)
  assert.ok(unknownSemantics.warnings.some(warning => /semantics|long-context/i.test(warning)))

  const fable = estimateCost(pricedEvent({
    model: 'claude-fable-5',
    inputTokens: 900_000,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }))
  assert.equal(fable.tier, 'standard')
  assert.equal(fable.totalCost, 9)
}

function testReportedCostsTakePrecedenceAndReconcile() {
  const exactlyReconciled = estimateCost(pricedEvent({
    inputCost: 1,
    outputCost: 2,
    reasoningCost: 1,
    cacheReadCost: 1,
    cacheWriteCost: 2,
    totalCost: 7,
    pricingStatus: 'reported',
  }))
  assert.equal(exactlyReconciled.breakdownStatus, 'reconciled')
  assert.equal(exactlyReconciled.unallocatedCost, 0)

  const minimallyUnallocated = estimateCost(pricedEvent({
    inputCost: 1 - Number.EPSILON,
    outputCost: 0,
    reasoningCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    totalCost: 1,
    pricingStatus: 'reported',
  }))
  assert.equal(minimallyUnallocated.breakdownStatus, 'unallocated')
  assert.equal(minimallyUnallocated.unallocatedCost, Number.EPSILON)

  const minimallyInvalid = estimateCost(pricedEvent({
    inputCost: 1,
    outputCost: 0,
    reasoningCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    totalCost: 1 - Number.EPSILON,
    pricingStatus: 'reported',
  }))
  assert.equal(minimallyInvalid.breakdownStatus, 'invalid')
  assert.ok(minimallyInvalid.warnings.includes('reported_cost_components_exceed_total'))

  const explicitlyReported = estimateCost(pricedEvent({
    model: 'unknown-model',
    timestampMs: undefined,
    inputCost: 1,
    outputCost: 2,
    reasoningCost: 1,
    cacheReadCost: 1,
    cacheWriteCost: 2,
    totalCost: 9,
    pricingStatus: 'reported',
  }))
  assert.equal(explicitlyReported.status, 'reported')
  assert.equal(explicitlyReported.matchedModelId, null)
  assert.equal(explicitlyReported.inputCost, 1)
  assert.equal(explicitlyReported.outputCost, 2)
  assert.equal(explicitlyReported.reasoningCost, 1)
  assert.equal(explicitlyReported.cacheReadCost, 1)
  assert.equal(explicitlyReported.cacheWriteCost, 2)
  assert.equal(explicitlyReported.totalCost, 9)
  assert.equal(explicitlyReported.unallocatedCost, 2)
  assert.equal(explicitlyReported.breakdownStatus, 'unallocated')

  const inferredReported = estimateCost(pricedEvent({
    model: 'also-unknown',
    timestampMs: undefined,
    inputCost: 1,
    outputCost: 2,
    reasoningCost: 1,
    cacheReadCost: 1,
    cacheWriteCost: 2,
    totalCost: 9,
  }))
  assert.equal(inferredReported.status, 'reported')
  assert.equal(inferredReported.totalCost, 9)
  assert.equal(inferredReported.unallocatedCost, 2)

  const invalidBreakdown = estimateCost(pricedEvent({
    inputCost: 2,
    outputCost: 2,
    reasoningCost: 2,
    cacheReadCost: 2,
    cacheWriteCost: 2,
    totalCost: 9,
    pricingStatus: 'reported',
  }))
  assert.equal(invalidBreakdown.status, 'reported')
  assert.equal(invalidBreakdown.totalCost, 9)
  assert.equal(invalidBreakdown.unallocatedCost, 0)
  assert.equal(invalidBreakdown.breakdownStatus, 'invalid')
  assert.ok(invalidBreakdown.warnings.includes('reported_cost_components_exceed_total'))

  const overflowedBreakdown = estimateCost(pricedEvent({
    inputCost: Number.MAX_VALUE,
    outputCost: Number.MAX_VALUE,
    reasoningCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    totalCost: Number.MAX_VALUE,
    pricingStatus: 'reported',
  }))
  assert.equal(overflowedBreakdown.breakdownStatus, 'invalid')
  assert.ok(overflowedBreakdown.warnings.includes('reported_cost_components_exceed_total'))

  const lastComponentOverflow = estimateCost(pricedEvent({
    inputCost: Number.MAX_VALUE,
    outputCost: 0,
    reasoningCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 1e293,
    totalCost: Number.MAX_VALUE,
    pricingStatus: 'reported',
  }))
  assert.equal(lastComponentOverflow.breakdownStatus, 'invalid')
  assert.ok(lastComponentOverflow.warnings.includes('reported_cost_components_exceed_total'))

  const contradictoryExplicitStatus = estimateCost(pricedEvent({
    inputCost: 1,
    outputCost: 2,
    reasoningCost: 1,
    cacheReadCost: 1,
    cacheWriteCost: 2,
    totalCost: 9,
    pricingStatus: 'unpriced',
  }))
  assert.notEqual(contradictoryExplicitStatus.status, 'reported')
}

function testEventAmountValidation() {
  const amountFields = [
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'inputCost',
    'outputCost',
    'reasoningCost',
    'cacheReadCost',
    'cacheWriteCost',
    'totalCost',
  ] as const

  for (const field of amountFields) {
    assert.throws(
      () => estimateCost(pricedEvent({ [field]: Number.NaN })),
      new RegExp(field, 'i'),
    )
    assert.throws(
      () => estimateCost(pricedEvent({ [field]: -1 })),
      new RegExp(field, 'i'),
    )
  }

  assert.throws(
    () => estimateCost(pricedEvent({ totalCost: Number.POSITIVE_INFINITY })),
    /totalCost/i,
  )
  assert.throws(
    () => estimateCost(pricedEvent({
      inputTokens: Number.MAX_VALUE,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })),
    /finite.*cost|cost.*finite/i,
  )
}

function snapshotWith(rows: PriceVersion[], aliases: Record<string, string> = {}): CatalogSnapshot {
  const version = 'injected-version'
  return {
    version,
    rows,
    aliases,
    hash: computeCatalogHash({ version, rows, aliases }),
  }
}

function expectCatalogHashMismatch(operation: () => unknown): void {
  assert.throws(operation, error => {
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'CatalogHashMismatchError')
    assert.match(error.message, /catalog.*hash.*mismatch/i)
    return true
  })
}

function testInjectedSnapshotsAreBoundToCanonicalHash() {
  const zeroRow = catalogRow({
    modelId: 'bound-zero-model',
    standard: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  })
  const validSnapshot = snapshotWith([zeroRow], { 'zero-alias': 'bound-zero-model' })
  const event = pricedEvent({
    model: 'zero-alias',
    timestampMs: Date.parse('2026-01-15T00:00:00Z'),
  })

  assert.equal(resolveModelPrice('zero-alias', validSnapshot), 'bound-zero-model')
  assert.equal(estimateCost(event, validSnapshot).status, 'zero_rate')

  const changedRateWithOldHash: CatalogSnapshot = {
    ...validSnapshot,
    rows: [{
      ...zeroRow,
      standard: { ...zeroRow.standard, input: 1 },
    }],
  }
  expectCatalogHashMismatch(() => estimateCost(event, changedRateWithOldHash))

  const changedVersionWithOldHash: CatalogSnapshot = {
    ...validSnapshot,
    version: 'changed-version',
  }
  expectCatalogHashMismatch(() => estimateCost(event, changedVersionWithOldHash))

  const changedAliasWithOldHash: CatalogSnapshot = {
    ...validSnapshot,
    aliases: { 'zero-alias': 'missing-model' },
  }
  expectCatalogHashMismatch(() => resolveModelPrice('zero-alias', changedAliasWithOldHash))
}

function testInjectedSnapshotsAndExclusiveValidTo() {
  const zeroRow = catalogRow({
    modelId: 'zero-model',
    standard: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  })
  const zeroSnapshot = snapshotWith([zeroRow])
  const zero = estimateCost(pricedEvent({
    model: 'zero-model',
    timestampMs: Date.parse('2026-01-15T00:00:00Z'),
  }), zeroSnapshot)
  assert.equal(zero.status, 'zero_rate')
  assert.equal(zero.totalCost, 0)
  assert.equal(zero.catalogHash, zeroSnapshot.hash)

  const boundedRow = catalogRow({
    modelId: 'bounded-model',
    validFrom: '2026-01-01T00:00:00Z',
    validTo: '2026-02-01T00:00:00Z',
  })
  const boundedSnapshot = snapshotWith([boundedRow])
  const beforeEnd = estimateCost(pricedEvent({
    model: 'bounded-model',
    timestampMs: Date.parse('2026-01-31T23:59:59.999Z'),
  }), boundedSnapshot)
  assert.equal(beforeEnd.status, 'estimated')

  const exactlyAtEnd = estimateCost(pricedEvent({
    model: 'bounded-model',
    timestampMs: Date.parse('2026-02-01T00:00:00Z'),
  }), boundedSnapshot)
  assert.equal(exactlyAtEnd.status, 'unpriced')
}

async function main() {
  testCatalogResolution()
  testDefaultCatalogIsDeeplyImmutable()
  testLegacyCatalogRemainsInSharedCatalog()
  testCatalogValidation()
  testCatalogHashIsStableAcrossObjectKeyOrder()
  testApplyEstimatedCostsCompatibilityWrapper()
  testDefaultSeedRowsComeFromEffectiveCatalogVersions()
  testSqliteInitializationUsesSharedCatalogSeeds()
  testStandardEstimationAndEffectiveDates()
  testLongContextTierSelection()
  testReportedCostsTakePrecedenceAndReconcile()
  testEventAmountValidation()
  testInjectedSnapshotsAreBoundToCanonicalHash()
  testInjectedSnapshotsAndExclusiveValidTo()
  console.log('pricing regression tests passed')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
