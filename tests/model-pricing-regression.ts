import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  OFFICIAL_MODEL_PRICE_VERSIONS,
  OFFICIAL_MODEL_CATALOG_EVIDENCE,
  applyEstimatedCosts,
  buildModelPriceResolver,
  priceUsageEvent,
  type PriceableUsageEvent,
} from '../cli/prices.ts'

const sqliteMigrationPath = path.join(
  process.cwd(),
  'server/db/migrations/202608020001_model_price_versions.sql',
)
const sqliteRollbackPath = path.join(
  process.cwd(),
  'server/db/migrations/202608020001_model_price_versions.rollback.sql',
)
const supabaseMigrationPath = path.join(
  process.cwd(),
  'scripts/supabase-v15-versioned-model-prices.sql',
)
const cliSyncPath = path.join(process.cwd(), 'cli/sync.ts')
const serverIngestionPath = path.join(process.cwd(), 'server/ingestion/index.ts')

function event(overrides: Partial<PriceableUsageEvent> = {}): PriceableUsageEvent {
  return {
    timestampMs: Date.parse('2026-08-02T00:00:00.000Z'),
    provider: 'anthropic',
    model: 'claude-opus-5',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    reasoningTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
    totalTokens: 5_000_000,
    inputCost: 0,
    outputCost: 0,
    reasoningCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    totalCost: 0,
    ...overrides,
  }
}

function assertCosts(actual: number[], expected: readonly number[]) {
  assert.equal(actual.length, expected.length)
  actual.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) < 1e-10, `${value} != ${expected[index]}`)
  })
}

assert.deepEqual(OFFICIAL_MODEL_CATALOG_EVIDENCE, {
  claudeModels: 'https://platform.claude.com/docs/en/about-claude/models/overview',
  claudePricing: 'https://platform.claude.com/docs/en/about-claude/pricing',
  claudeReleases: 'https://platform.claude.com/docs/en/release-notes/overview',
  deepseekPricing: 'https://api-docs.deepseek.com/quick_start/pricing',
  deepseekReleases: 'https://api-docs.deepseek.com/updates/',
  mimoPricing: 'https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go',
  mimoReleases: 'https://mimo.mi.com/docs/zh-CN/news/latest/v2.5-price-update',
  glmPricing: 'https://bigmodel.cn/pricing',
  glmReleases: 'https://docs.bigmodel.cn/cn/update/new-releases',
  minimaxPricing: 'https://platform.minimaxi.com/docs/guides/pricing-paygo',
  minimaxReleases: 'https://minimaxi.com/models/text/m3',
  kimiK3Pricing: 'https://platform.kimi.ai/docs/pricing/chat-k3.md',
  kimiK27CodePricing: 'https://platform.kimi.ai/docs/pricing/chat-k27-code.md',
  kimiChatPricing: 'https://platform.kimi.ai/docs/pricing/chat',
  moonshotReleases: 'https://www.moonshot.ai/',
  checkedAt: '2026-08-02',
})

assert.deepEqual(
  OFFICIAL_MODEL_PRICE_VERSIONS.map((row) => [
    row.modelId,
    row.validFromMs,
    row.validToMs,
    row.inputPrice,
    row.outputPrice,
    row.cacheReadPrice,
    row.cacheWritePrice,
    row.cacheSemantics,
    row.contextWindow,
    row.sourceUrl,
    row.sourceCheckedAt,
  ]),
  [
    ['deepseek-v4-flash', 1776988800000, null, 0.14, 0.28, 0.0028, null, 'hit_miss', 1_000_000, 'https://api-docs.deepseek.com/quick_start/pricing', '2026-08-02'],
    ['deepseek-v4-pro', 1776988800000, null, 0.435, 0.87, 0.003625, null, 'hit_miss', 1_000_000, 'https://api-docs.deepseek.com/quick_start/pricing', '2026-08-02'],
    ['mimo-v2.5', 1779811200000, null, 0.14, 0.28, 0.0028, null, 'hit_miss', 1_000_000, 'https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go', '2026-08-02'],
    ['mimo-v2.5-pro', 1779811200000, null, 0.435, 0.87, 0.0036, null, 'hit_miss', 1_000_000, 'https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go', '2026-08-02'],
    ['claude-opus-5', 1784851200000, null, 5, 25, 0.5, 6.25, 'anthropic', 1_000_000, 'https://platform.claude.com/docs/en/about-claude/pricing', '2026-08-02'],
    ['claude-sonnet-5', 1782777600000, 1788220800000, 2, 10, 0.2, 2.5, 'anthropic', 1_000_000, 'https://platform.claude.com/docs/en/about-claude/pricing', '2026-08-02'],
    ['claude-sonnet-5', 1788220800000, null, 3, 15, 0.3, 3.75, 'anthropic', 1_000_000, 'https://platform.claude.com/docs/en/about-claude/pricing', '2026-08-02'],
    ['kimi-k2.7-code', 1781222400000, null, 0.95, 4, 0.19, null, 'hit_miss', 262_144, 'https://platform.kimi.ai/docs/pricing/chat-k27-code.md', '2026-08-02'],
    ['kimi-k3', 1784160000000, null, 3, 15, 0.3, null, 'hit_miss', 1_048_576, 'https://platform.kimi.ai/docs/pricing/chat-k3.md', '2026-08-02'],
  ],
)

const opus = event()
assert.equal(applyEstimatedCosts(opus), 'priced')
assert.deepEqual(
  [opus.inputCost, opus.outputCost, opus.reasoningCost, opus.cacheReadCost, opus.cacheWriteCost, opus.totalCost],
  [5, 25, 25, 0.5, 6.25, 61.75],
)

const opusBeforeRelease = event({ timestampMs: 1784851199999 })
assert.equal(applyEstimatedCosts(opusBeforeRelease), 'unpriced')
assert.equal(opusBeforeRelease.totalCost, 0)

const sonnetIntro = event({ model: 'claude-sonnet-5', timestampMs: 1788220799999 })
assert.equal(applyEstimatedCosts(sonnetIntro), 'priced')
assert.equal(sonnetIntro.totalCost, 24.7)

const sonnetStandard = event({ model: 'claude-sonnet-5', timestampMs: 1788220800000 })
assert.equal(applyEstimatedCosts(sonnetStandard), 'priced')
assert.equal(sonnetStandard.totalCost, 37.05)

const sonnetBeforeRelease = event({ model: 'claude-sonnet-5', timestampMs: 1782777599999 })
assert.equal(applyEstimatedCosts(sonnetBeforeRelease), 'unpriced')

for (const [model, expected] of [
  ['kimi-k2.7-code', [0.95, 4, 4, 0.19, 0, 9.14]],
  ['kimi-k3', [3, 15, 15, 0.3, 0, 33.3]],
] as const) {
  const kimi = event({ provider: 'moonshot', model, cacheWriteTokens: 0, totalTokens: 4_000_000 })
  assert.equal(applyEstimatedCosts(kimi), 'priced')
  assertCosts(
    [kimi.inputCost, kimi.outputCost, kimi.reasoningCost, kimi.cacheReadCost, kimi.cacheWriteCost, kimi.totalCost],
    expected,
  )

  const ambiguous = event({ provider: 'moonshot', model, cacheWriteTokens: 1 })
  assert.equal(applyEstimatedCosts(ambiguous), 'unpriced')
  assert.deepEqual(
    [ambiguous.inputCost, ambiguous.outputCost, ambiguous.reasoningCost, ambiguous.cacheReadCost, ambiguous.cacheWriteCost, ambiguous.totalCost],
    [0, 0, 0, 0, 0, 0],
  )
}

for (const [model, expected] of [
  ['deepseek-v4-flash', [0.14, 0.28, 0.28, 0.0028, 0, 0.7028]],
  ['deepseek-v4-pro', [0.435, 0.87, 0.87, 0.003625, 0, 2.178625]],
  ['mimo-v2.5', [0.14, 0.28, 0.28, 0.0028, 0, 0.7028]],
  ['mimo-v2.5-pro', [0.435, 0.87, 0.87, 0.0036, 0, 2.1786]],
] as const) {
  const priced = event({ provider: model.startsWith('deepseek') ? 'deepseek' : 'xiaomi', model, cacheWriteTokens: 0, totalTokens: 4_000_000 })
  assert.equal(applyEstimatedCosts(priced), 'priced')
  assertCosts(
    [priced.inputCost, priced.outputCost, priced.reasoningCost, priced.cacheReadCost, priced.cacheWriteCost, priced.totalCost],
    expected,
  )

  const ambiguous = event({
    provider: model.startsWith('deepseek') ? 'deepseek' : 'xiaomi',
    model,
    cacheWriteTokens: 1,
    totalTokens: 4_000_001,
  })
  assert.equal(applyEstimatedCosts(ambiguous), 'unpriced')
  assert.deepEqual(
    [ambiguous.inputCost, ambiguous.outputCost, ambiguous.reasoningCost, ambiguous.cacheReadCost, ambiguous.cacheWriteCost, ambiguous.totalCost],
    [0, 0, 0, 0, 0, 0],
  )
}

for (const [alias, canonical] of [
  ['GLM-5.2', 'glm-5.2'],
  ['Pro/zai-org/GLM-5', 'glm-5'],
  ['zhanlu/glm-4.7', 'glm-4.7'],
  ['minimax-m2.5', 'MiniMax-M2.5'],
  ['minimax-m2.7-highspeed', 'MiniMax-M2.7-highspeed'],
] as const) {
  const aliased = event({ provider: alias.includes('GLM') ? 'zhipu' : 'minimax', model: alias, cacheWriteTokens: 0, totalTokens: 4_000_000 })
  const resolved = event({ provider: alias.includes('GLM') ? 'zhipu' : 'minimax', model: canonical, cacheWriteTokens: 0, totalTokens: 4_000_000 })
  assert.equal(applyEstimatedCosts(aliased), 'priced', alias)
  assert.equal(applyEstimatedCosts(resolved), 'priced', canonical)
  assert.equal(aliased.totalCost, resolved.totalCost)
}

for (const model of [
  'anthropic/claude-opus-5',
  'vendor-claude-opus-5',
  'deepseek/deepseek-v4-flash',
  'moonshot/kimi-k3',
  'kimi-k3-highspeed',
  'kimi-k2.7-code-highspeed',
  'claude-mythos-5',
]) {
  const unknown = event({ model })
  assert.equal(applyEstimatedCosts(unknown), 'unpriced', `${model} must not fuzzy-match`)
  assert.equal(unknown.totalCost, 0)
}

const reported = event({
  inputCost: 1,
  outputCost: 2,
  reasoningCost: 3,
  cacheReadCost: 4,
  cacheWriteCost: 5,
  totalCost: 15,
})
assert.equal(applyEstimatedCosts(reported), 'reported')
assert.deepEqual(
  [reported.inputCost, reported.outputCost, reported.reasoningCost, reported.cacheReadCost, reported.cacheWriteCost, reported.totalCost],
  [1, 2, 3, 4, 5, 15],
)

const db = new DatabaseSync(':memory:')
db.exec(`
  CREATE TABLE model_prices (
    model_id TEXT PRIMARY KEY,
    provider TEXT,
    input_price REAL DEFAULT 0,
    output_price REAL DEFAULT 0,
    cache_read_price REAL DEFAULT 0,
    cache_write_price REAL DEFAULT 0,
    currency TEXT DEFAULT 'USD',
    per_tokens INTEGER DEFAULT 1000000,
    source TEXT DEFAULT 'manual',
    updated_at INTEGER
  );
  CREATE TABLE usage_events (
    id TEXT PRIMARY KEY,
    timestamp_ms INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    model TEXT NOT NULL,
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
    total_cost REAL DEFAULT 0
  );
  CREATE TABLE sessions (session_id TEXT PRIMARY KEY, total_cost REAL DEFAULT 0);
  INSERT INTO usage_events (
    id, timestamp_ms, session_id, model,
    input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, total_tokens, total_cost
  ) VALUES
    ('before', 1784851199999, 's1', 'claude-opus-5', 1000000, 1000000, 1000000, 1000000, 1000000, 5000000, 0),
    ('opus', 1784851200000, 's1', 'claude-opus-5', 1000000, 1000000, 1000000, 1000000, 1000000, 5000000, 0),
    ('sonnet-intro', 1788220799999, 's1', 'claude-sonnet-5', 1000000, 1000000, 1000000, 1000000, 1000000, 5000000, 0),
    ('sonnet-standard', 1788220800000, 's1', 'claude-sonnet-5', 1000000, 1000000, 1000000, 1000000, 1000000, 5000000, 0),
    ('kimi', 1784160000000, 's1', 'kimi-k3', 1000000, 1000000, 1000000, 1000000, 0, 4000000, 0),
    ('kimi-write', 1784160000000, 's1', 'kimi-k3', 1000000, 1000000, 1000000, 1000000, 1, 4000001, 0),
    ('reported', 1784851200000, 's1', 'claude-opus-5', 1000000, 1000000, 1000000, 1000000, 1000000, 5000000, 7);
  INSERT INTO sessions (session_id, total_cost) VALUES ('s1', 999);
`)

const sqliteMigration = fs.readFileSync(sqliteMigrationPath, 'utf8')
db.exec(sqliteMigration)
db.exec(sqliteMigration)

const flatRows = db.prepare('SELECT * FROM model_prices').all() as any[]
const versionRows = db.prepare('SELECT * FROM model_price_versions').all() as any[]
const resolveDbPrice = buildModelPriceResolver(flatRows, versionRows)

const serverEvent = event({ model: 'claude-sonnet-5', timestampMs: 1788220800000 })
assert.equal(priceUsageEvent(serverEvent, resolveDbPrice), 'priced')
assert.equal(serverEvent.totalCost, sonnetStandard.totalCost)

assert.deepEqual(
  (db.prepare('SELECT id, total_cost AS totalCost FROM usage_events ORDER BY id').all() as any[]).map((row) => ({ ...row })),
  [
    { id: 'before', totalCost: 0 },
    { id: 'kimi', totalCost: 33.3 },
    { id: 'kimi-write', totalCost: 0 },
    { id: 'opus', totalCost: 61.75 },
    { id: 'reported', totalCost: 7 },
    { id: 'sonnet-intro', totalCost: 24.7 },
    { id: 'sonnet-standard', totalCost: 37.05 },
  ],
)

db.prepare("UPDATE model_prices SET input_price = 99, source = 'manual' WHERE model_id = 'claude-opus-5'").run()
db.exec(sqliteMigration)
assert.deepEqual(
  { ...db.prepare("SELECT input_price AS inputPrice, source FROM model_prices WHERE model_id = 'claude-opus-5'").get() as any },
  { inputPrice: 99, source: 'manual' },
)
const manualRows = db.prepare('SELECT * FROM model_prices').all() as any[]
const manualResolver = buildModelPriceResolver(manualRows, versionRows)
const manualBeforeRelease = event({ timestampMs: 1784851199999 })
assert.equal(priceUsageEvent(manualBeforeRelease, manualResolver), 'unpriced')
const manualAfterRelease = event({ timestampMs: 1784851200000, cacheWriteTokens: 0, totalTokens: 4_000_000 })
assert.equal(priceUsageEvent(manualAfterRelease, manualResolver), 'priced')
assert.equal(manualAfterRelease.inputCost, 99)

db.exec(fs.readFileSync(sqliteRollbackPath, 'utf8'))
assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='model_price_versions'").get() as any).count, 0)
assert.deepEqual(
  (db.prepare('SELECT id, total_cost AS totalCost FROM usage_events ORDER BY id').all() as any[]).map((row) => ({ ...row })),
  [
    { id: 'before', totalCost: 0 },
    { id: 'kimi', totalCost: 0 },
    { id: 'kimi-write', totalCost: 0 },
    { id: 'opus', totalCost: 0 },
    { id: 'reported', totalCost: 7 },
    { id: 'sonnet-intro', totalCost: 0 },
    { id: 'sonnet-standard', totalCost: 0 },
  ],
)
db.close()

const supabaseMigration = fs.readFileSync(supabaseMigrationPath, 'utf8')
for (const modelId of [
  'claude-opus-5',
  'claude-sonnet-5',
  'kimi-k2.7-code',
  'kimi-k3',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'mimo-v2.5',
  'mimo-v2.5-pro',
  'MiniMax-M2.7-highspeed',
  'MiniMax-M2.5',
  'MiniMax-M2.5-highspeed',
]) {
  assert.match(supabaseMigration, new RegExp(`'${modelId.replace('.', '\\.')}'`))
}
assert.match(supabaseMigration, /timestamp_ms\s*>?=\s*price\.valid_from_ms/i)
assert.match(supabaseMigration, /timestamp_ms\s*<\s*price\.valid_to_ms/i)
assert.match(supabaseMigration, /cache_semantics\s*=\s*'hit_miss'/i)
assert.match(supabaseMigration, /cache_write_tokens\s*<>\s*0/i)
assert.match(supabaseMigration, /totalCost'\)::REAL, 0\) = 0/i)
assert.match(supabaseMigration, /LEFT\(d\.x->>'project', 256\)/)
assert.match(supabaseMigration, /COALESCE\(alias_map\.canonical_model, d\.x->>'model'\) AS model_id/i)
assert.match(supabaseMigration, /LEFT\(d\.model_id, 512\)/)
assert.match(supabaseMigration, /ON CONFLICT \(id, member_code\) DO UPDATE/i)
assert.match(supabaseMigration, /reasoningTokens'\)::INTEGER, 0\) \* d\.output_price/i)
assert.match(supabaseMigration, /known\.model_id = n\.model_id/i)
assert.match(supabaseMigration, /version\.model_id = n\.model_id/i)
assert.match(supabaseMigration, /price\.model_id = COALESCE\(alias_map\.canonical_model, event\.model\)/i)

const cliSync = fs.readFileSync(cliSyncPath, 'utf8')
assert.ok(cliSync.indexOf('applyEstimatedCosts(event)') < cliSync.indexOf('allEvents.push(stripEvent(event, project))'))
assert.ok(cliSync.indexOf("supabase.rpc('tokend_upload_events'") > cliSync.indexOf('applyEstimatedCosts(event)'))

const serverIngestion = fs.readFileSync(serverIngestionPath, 'utf8')
assert.match(serverIngestion, /buildModelPriceResolver\(priceRows, versionRows\)/)
assert.match(serverIngestion, /priceUsageEvent\(event, resolvePrice\)/)

console.log('model pricing regression tests passed (42 cases)')
