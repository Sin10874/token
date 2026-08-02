import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  CATALOG_VERSION,
  PRICE_VERSIONS,
  resolveModelPrice,
} from '../cli/pricing/catalog.ts'
import { estimateCost } from '../cli/pricing/estimate.ts'
import type { PricingEvent } from '../cli/pricing/types.ts'
import {
  applyLocalCosts,
  type LocalPriceLookup,
} from '../server/ingestion/local-cost-estimator.ts'
import { withEffectiveDefaultPrices } from '../server/db/effective-model-price-rows.ts'
import type { RawUsageEvent } from '../server/ingestion/parser.ts'

const ANTHROPIC_PRICING = 'https://platform.claude.com/docs/en/about-claude/pricing'
const KIMI_K3_PRICING = 'https://platform.kimi.ai/docs/pricing/chat-k3.md'
const KIMI_K27_PRICING = 'https://platform.kimi.ai/docs/pricing/chat-k27-code.md'

function event(overrides: Partial<PricingEvent> = {}): PricingEvent {
  return {
    model: 'claude-opus-5',
    timestampMs: Date.parse('2026-08-02T00:00:00Z'),
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    reasoningTokens: 0,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
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

function rawEvent(overrides: Partial<RawUsageEvent> = {}): RawUsageEvent {
  return {
    id: 'model-refresh-event',
    timestampMs: Date.parse('2026-08-02T00:00:00Z'),
    sessionId: 'model-refresh-session',
    sessionKey: null,
    agent: 'model-refresh-regression',
    provider: 'anthropic',
    model: 'claude-opus-5',
    channel: 'test',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    reasoningTokens: 0,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
    tokenSemantics: 'disjoint',
    totalTokens: 4_000_000,
    inputCost: 0,
    outputCost: 0,
    reasoningCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    totalCost: 0,
    sourcePath: '/tmp/model-refresh-regression.jsonl',
    stopReason: 'end_turn',
    ...overrides,
  }
}

function testOfficialRowsAndStrictResolution(): void {
  assert.equal(CATALOG_VERSION, '2026-08-02')
  assert.equal(resolveModelPrice('claude-opus-5'), 'claude-opus-5')
  assert.equal(resolveModelPrice('claude-sonnet-5'), 'claude-sonnet-5')
  assert.equal(resolveModelPrice('kimi-k2.7-code'), 'kimi-k2.7-code')
  assert.equal(resolveModelPrice('kimi-k3'), 'kimi-k3')

  for (const unsupported of [
    'vendor-claude-opus-5',
    'anthropic/claude-opus-5',
    'my-claude-sonnet-5',
    'moonshot/kimi-k3',
    'vendor-kimi-k3',
  ]) {
    assert.equal(resolveModelPrice(unsupported), null, `${unsupported} must not fuzzy-match`)
  }

  assert.deepEqual(
    PRICE_VERSIONS.filter(row => row.modelId === 'claude-opus-5'),
    [{
      modelId: 'claude-opus-5',
      provider: 'anthropic',
      catalogVersion: '2026-08-02',
      validFrom: '2026-07-24T00:00:00Z',
      standard: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      sourceCheckedAt: '2026-08-02',
      sourceUrl: ANTHROPIC_PRICING,
    }],
  )
  assert.deepEqual(
    PRICE_VERSIONS.filter(row => row.modelId === 'claude-sonnet-5'),
    [
      {
        modelId: 'claude-sonnet-5',
        provider: 'anthropic',
        catalogVersion: '2026-08-02',
        validFrom: '2026-06-30T00:00:00Z',
        validTo: '2026-09-01T00:00:00Z',
        standard: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
        sourceCheckedAt: '2026-08-02',
        sourceUrl: ANTHROPIC_PRICING,
      },
      {
        modelId: 'claude-sonnet-5',
        provider: 'anthropic',
        catalogVersion: '2026-08-02',
        validFrom: '2026-09-01T00:00:00Z',
        standard: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        sourceCheckedAt: '2026-08-02',
        sourceUrl: ANTHROPIC_PRICING,
      },
    ],
  )
  assert.deepEqual(
    PRICE_VERSIONS.filter(row => row.modelId === 'kimi-k2.7-code'),
    [{
      modelId: 'kimi-k2.7-code',
      provider: 'moonshot',
      catalogVersion: '2026-08-02',
      validFrom: '2026-06-12T00:00:00Z',
      standard: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
      sourceCheckedAt: '2026-08-02',
      sourceUrl: KIMI_K27_PRICING,
    }],
  )
  assert.deepEqual(
    PRICE_VERSIONS.filter(row => row.modelId === 'kimi-k3'),
    [{
      modelId: 'kimi-k3',
      provider: 'moonshot',
      catalogVersion: '2026-08-02',
      validFrom: '2026-07-16T00:00:00Z',
      standard: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      sourceCheckedAt: '2026-08-02',
      sourceUrl: KIMI_K3_PRICING,
    }],
  )
}

function testEffectiveDateBoundaries(): void {
  assert.equal(estimateCost(event({
    timestampMs: Date.parse('2026-07-23T23:59:59.999Z'),
  })).status, 'unpriced')
  assert.equal(estimateCost(event({
    timestampMs: Date.parse('2026-07-24T00:00:00Z'),
  })).totalCost, 36.75)

  const intro = estimateCost(event({
    model: 'claude-sonnet-5',
    timestampMs: Date.parse('2026-08-31T23:59:59.999Z'),
  }))
  assert.equal(intro.totalCost, 14.7)
  assert.match(intro.priceVersion || '', /2026-06-30T00:00:00Z$/)

  const standard = estimateCost(event({
    model: 'claude-sonnet-5',
    timestampMs: Date.parse('2026-09-01T00:00:00Z'),
  }))
  assert.equal(standard.totalCost, 22.05)
  assert.match(standard.priceVersion || '', /2026-09-01T00:00:00Z$/)

  assert.equal(estimateCost(event({
    model: 'claude-sonnet-5',
    timestampMs: Date.parse('2026-06-29T23:59:59.999Z'),
  })).status, 'unpriced')
}

function testKimiK3FailsClosedUnlessBucketsAreProven(): void {
  const unknown = estimateCost(event({
    model: 'kimi-k3',
    tokenSemantics: 'unknown',
    cacheWriteTokens: 0,
    totalCost: 0,
  }))
  assert.equal(unknown.status, 'unpriced')
  assert.equal(unknown.totalCost, 0)
  assert.ok(unknown.warnings.some(warning => /cache.?miss|semantics/i.test(warning)))

  const ambiguousCacheWrite = estimateCost(event({
    model: 'kimi-k3',
    tokenSemantics: 'disjoint',
    cacheWriteTokens: 1,
    totalCost: 0,
  }))
  assert.equal(ambiguousCacheWrite.status, 'unpriced')
  assert.equal(ambiguousCacheWrite.totalCost, 0)
  assert.ok(ambiguousCacheWrite.warnings.some(warning => /cache.?write/i.test(warning)))

  const proven = estimateCost(event({
    model: 'kimi-k3',
    tokenSemantics: 'disjoint',
    cacheWriteTokens: 0,
    totalCost: 0,
  }))
  assert.equal(proven.status, 'estimated')
  assert.equal(proven.inputCost, 3)
  assert.equal(proven.outputCost, 15)
  assert.equal(proven.cacheReadCost, 0.3)
  assert.equal(proven.cacheWriteCost, 0)
  assert.equal(proven.totalCost, 18.3)

  const reported = estimateCost(event({
    model: 'kimi-k3',
    tokenSemantics: 'unknown',
    pricingStatus: 'reported',
    inputCost: 1.1,
    outputCost: 2.2,
    cacheReadCost: 0.3,
    cacheWriteCost: 0.4,
    totalCost: 4,
  }))
  assert.equal(reported.status, 'reported')
  assert.equal(reported.totalCost, 4)
  assert.equal(reported.cacheWriteCost, 0.4)
}

function testKimiK27CodeAlsoRequiresProvenCacheMissBuckets(): void {
  const unknown = estimateCost(event({
    model: 'kimi-k2.7-code',
    tokenSemantics: 'unknown',
    cacheWriteTokens: 0,
  }))
  assert.equal(unknown.status, 'unpriced')
  assert.equal(unknown.totalCost, 0)

  const proven = estimateCost(event({
    model: 'kimi-k2.7-code',
    tokenSemantics: 'disjoint',
    cacheWriteTokens: 0,
  }))
  assert.equal(proven.status, 'estimated')
  assert.ok(Math.abs(proven.totalCost - 5.14) < 1e-12)
}

function testLocalIngestionUsesEffectiveCatalogAndPreservesOverrides(): void {
  const staleSonnetDefault = {
    model_id: 'claude-sonnet-5',
    input_price: 2,
    output_price: 10,
    cache_read_price: 0.2,
    cache_write_price: 2.5,
    per_tokens: 1_000_000,
    source: 'default',
  }
  const findDefault: LocalPriceLookup = () => staleSonnetDefault
  const postIntro = rawEvent({
    model: 'claude-sonnet-5',
    timestampMs: Date.parse('2026-09-01T00:00:00Z'),
  })
  applyLocalCosts(postIntro, findDefault)
  assert.equal(postIntro.totalCost, 22.05, 'default SQLite snapshot must not override effective catalog')

  const unprovenK3 = rawEvent({
    provider: 'moonshot',
    model: 'kimi-k3',
    tokenSemantics: 'unknown',
    cacheWriteTokens: 0,
    totalTokens: 3_000_000,
  })
  applyLocalCosts(unprovenK3, () => ({
    ...staleSonnetDefault,
    model_id: 'kimi-k3',
    input_price: 3,
    output_price: 15,
    cache_read_price: 0.3,
    cache_write_price: 0,
  }))
  assert.equal(unprovenK3.pricingStatus, 'unpriced')
  assert.equal(unprovenK3.totalCost, 0)

  const manualUnprovenK3 = rawEvent({
    provider: 'moonshot',
    model: 'kimi-k3',
    tokenSemantics: 'unknown',
    cacheWriteTokens: 0,
    totalTokens: 3_000_000,
  })
  applyLocalCosts(manualUnprovenK3, () => ({
    ...staleSonnetDefault,
    model_id: 'kimi-k3',
    input_price: 3,
    output_price: 15,
    cache_read_price: 0.3,
    cache_write_price: 0,
    source: 'manual',
  }))
  assert.equal(manualUnprovenK3.pricingStatus, 'unpriced')
  assert.equal(manualUnprovenK3.totalCost, 0)

  const reportedK3 = rawEvent({
    provider: 'moonshot',
    model: 'kimi-k3',
    tokenSemantics: 'unknown',
    cacheWriteTokens: 0,
    totalTokens: 3_000_000,
    pricingStatus: 'reported',
    inputCost: 1,
    outputCost: 2,
    cacheReadCost: 0.2,
    totalCost: 3.2,
  })
  applyLocalCosts(reportedK3, () => null)
  assert.equal(reportedK3.pricingStatus, 'reported')
  assert.equal(reportedK3.totalCost, 3.2)

  const manual = rawEvent({ model: 'private-model', cacheReadTokens: 0, cacheWriteTokens: 0 })
  applyLocalCosts(manual, () => ({
    ...staleSonnetDefault,
    model_id: 'private-model',
    input_price: 1,
    output_price: 2,
    cache_read_price: 0.1,
    cache_write_price: 0,
    source: 'manual',
  }))
  assert.equal(manual.totalCost, 3)
}

function testReleaseIntegrationIncludesTheRefreshMigration(): void {
  const rollout = fs.readFileSync(
    path.resolve(process.cwd(), 'scripts/tokend-production-rollout.mjs'),
    'utf8',
  )
  const scale = fs.readFileSync(
    path.resolve(process.cwd(), 'scripts/test-pricing-scale.sh'),
    'utf8',
  )

  assert.equal((rollout.match(/'202608020001'/g) ?? []).length, 1)
  assert.match(rollout, /RECOVERY_MIN_VERSION = '202608030001'/)
  assert.equal(
    (scale.match(/supabase\/migrations\/202608020001_model_catalog_refresh\.sql/g) ?? []).length,
    1,
  )
}

function testSettingsApiUsesTheEffectiveIntervalWithoutOverwritingManualRows(): void {
  const intro = {
    model_id: 'claude-sonnet-5',
    provider: 'anthropic',
    input_price: 2,
    output_price: 10,
    cache_read_price: 0.2,
    cache_write_price: 2.5,
    currency: 'USD',
    per_tokens: 1_000_000,
    source: 'default',
    updated_at: 1,
  }
  const manual = {
    ...intro,
    model_id: 'manual-sonnet',
    input_price: 99,
    source: 'manual',
  }
  const rows = withEffectiveDefaultPrices(
    [intro, manual],
    Date.parse('2026-09-01T00:00:00Z'),
  )

  assert.deepEqual(
    [rows[0].input_price, rows[0].output_price, rows[0].cache_read_price, rows[0].cache_write_price],
    [3, 15, 0.3, 3.75],
  )
  assert.deepEqual(rows[1], manual)

  const routes = fs.readFileSync(
    path.resolve(process.cwd(), 'server/api/routes.ts'),
    'utf8',
  )
  const localDb = fs.readFileSync(
    path.resolve(process.cwd(), 'server/db/index.ts'),
    'utf8',
  )
  assert.match(routes, /res\.json\(withEffectiveDefaultPrices\(rows\)\)/)
  assert.match(localDb, /getDefaultSeedRows\(Date\.now\(\)\)/)
}

function main(): void {
  testOfficialRowsAndStrictResolution()
  testEffectiveDateBoundaries()
  testKimiK3FailsClosedUnlessBucketsAreProven()
  testKimiK27CodeAlsoRequiresProvenCacheMissBuckets()
  testLocalIngestionUsesEffectiveCatalogAndPreservesOverrides()
  testReleaseIntegrationIncludesTheRefreshMigration()
  testSettingsApiUsesTheEffectiveIntervalWithoutOverwritingManualRows()
  console.log('model refresh regression tests passed')
}

main()
