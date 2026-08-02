import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  buildModelPriceResolver,
  priceUsageEvent,
  type PriceableUsageEvent,
} from '../server/pricing/model-pricing.ts'

const migrationPath = path.join(
  process.cwd(),
  'server/db/migrations/202608020001_model_price_versions.sql',
)
const rollbackPath = path.join(
  process.cwd(),
  'server/db/migrations/202608020001_model_price_versions.rollback.sql',
)

function testCliAndServerShareThePricedIngestionPath() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))
  const ingestionSource = fs.readFileSync(path.join(process.cwd(), 'server/ingestion/index.ts'), 'utf8')
  const apiSource = fs.readFileSync(path.join(process.cwd(), 'server/api/routes.ts'), 'utf8')
  const serverSource = fs.readFileSync(path.join(process.cwd(), 'server/index.ts'), 'utf8')

  assert.equal(packageJson.scripts.ingest, 'tsx server/ingestion/index.ts')
  assert.equal(ingestionSource.match(/priceUsageEvent\(event, resolvePrice\)/g)?.length, 3)
  assert.match(apiSource, /import \{ runIngestion \} from '\.\.\/ingestion\/index\.js'/)
  assert.match(serverSource, /import \{ runIngestion \} from '\.\/ingestion\/index\.js'/)
}

function createCatalogDb() {
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
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      input_cost REAL DEFAULT 0,
      output_cost REAL DEFAULT 0,
      cache_read_cost REAL DEFAULT 0,
      cache_write_cost REAL DEFAULT 0,
      total_cost REAL DEFAULT 0
    );

    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      total_cost REAL DEFAULT 0
    );

    INSERT INTO usage_events (
      id, timestamp_ms, session_id, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
      total_cost
    ) VALUES
      ('opus-before', 1784851199999, 's1', 'claude-opus-5', 1000000, 1000000, 1000000, 1000000, 4000000, 0),
      ('opus-at', 1784851200000, 's1', 'claude-opus-5', 1000000, 1000000, 1000000, 1000000, 4000000, 0),
      ('sonnet-intro', 1788220799999, 's1', 'claude-sonnet-5', 1000000, 1000000, 1000000, 1000000, 4000000, 0),
      ('sonnet-standard', 1788220800000, 's1', 'claude-sonnet-5', 1000000, 1000000, 1000000, 1000000, 4000000, 0),
      ('kimi-priced', 1784160000000, 's1', 'kimi-k3', 1000000, 1000000, 1000000, 0, 3000000, 0),
      ('kimi-write', 1784160000000, 's1', 'kimi-k3', 1000000, 1000000, 1000000, 1, 3000001, 0),
      ('reported', 1784851200000, 's1', 'claude-opus-5', 1000000, 1000000, 1000000, 1000000, 4000000, 7);

    INSERT INTO sessions (session_id, total_cost) VALUES ('s1', 999);
  `)

  const sql = fs.readFileSync(migrationPath, 'utf8')
  db.exec(sql)
  db.exec(sql)
  return db
}

function event(overrides: Partial<PriceableUsageEvent>): PriceableUsageEvent {
  return {
    timestampMs: Date.parse('2026-08-02T00:00:00Z'),
    provider: 'anthropic',
    model: 'claude-opus-5',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    totalCost: 0,
    ...overrides,
  }
}

const db = createCatalogDb()
const versionRows = db.prepare('SELECT * FROM model_price_versions ORDER BY model_id, valid_from_ms').all()
const flatRows = db.prepare('SELECT * FROM model_prices ORDER BY model_id').all()
const resolvePrice = buildModelPriceResolver(flatRows, versionRows)

assert.deepEqual(
  (db.prepare(`
    SELECT id, total_cost as totalCost
    FROM usage_events
    ORDER BY id
  `).all() as Array<{ id: string; totalCost: number }>).map((row) => ({ ...row })),
  [
    { id: 'kimi-priced', totalCost: 18.3 },
    { id: 'kimi-write', totalCost: 0 },
    { id: 'opus-at', totalCost: 36.75 },
    { id: 'opus-before', totalCost: 0 },
    { id: 'reported', totalCost: 7 },
    { id: 'sonnet-intro', totalCost: 14.7 },
    { id: 'sonnet-standard', totalCost: 22.05 },
  ],
  'database backfill must use event-time versions and preserve unpriced/reported rows',
)
assert.ok(Math.abs((db.prepare(`
  SELECT total_cost as totalCost FROM sessions WHERE session_id = 's1'
`).get() as { totalCost: number }).totalCost - 98.8) < 1e-12)

assert.equal(versionRows.length, 5, 'migration must stay idempotent')
assert.deepEqual(
  versionRows.map((row: any) => [
    row.model_id,
    row.valid_from_ms,
    row.valid_to_ms,
    row.input_price,
    row.output_price,
    row.cache_read_price,
    row.cache_write_price,
    row.cache_semantics,
    row.context_window,
    row.source_url,
    row.source_checked_at,
  ]),
  [
    ['claude-opus-5', 1784851200000, null, 5, 25, 0.5, 6.25, 'anthropic', 1_000_000, 'https://platform.claude.com/docs/en/about-claude/pricing', '2026-08-02'],
    ['claude-sonnet-5', 1782777600000, 1788220800000, 2, 10, 0.2, 2.5, 'anthropic', 1_000_000, 'https://platform.claude.com/docs/en/about-claude/pricing', '2026-08-02'],
    ['claude-sonnet-5', 1788220800000, null, 3, 15, 0.3, 3.75, 'anthropic', 1_000_000, 'https://platform.claude.com/docs/en/about-claude/pricing', '2026-08-02'],
    ['kimi-k2.7-code', 1781222400000, null, 0.95, 4, 0.19, null, 'hit_miss', 262_144, 'https://platform.kimi.ai/docs/pricing/chat', '2026-08-02'],
    ['kimi-k3', 1784160000000, null, 3, 15, 0.3, null, 'hit_miss', 1_048_576, 'https://platform.kimi.ai/docs/pricing/chat-k3.md', '2026-08-02'],
  ],
)

for (const modelId of ['claude-opus-5', 'claude-sonnet-5', 'kimi-k2.7-code', 'kimi-k3']) {
  assert.equal(flatRows.filter((row: any) => row.model_id === modelId).length, 1)
}

const opus = event({})
assert.equal(priceUsageEvent(opus, resolvePrice), 'priced')
assert.deepEqual(
  [opus.inputCost, opus.outputCost, opus.cacheReadCost, opus.cacheWriteCost, opus.totalCost],
  [5, 25, 0.5, 6.25, 36.75],
)

const beforeOpus = event({ timestampMs: Date.parse('2026-07-23T23:59:59.999Z') })
assert.equal(priceUsageEvent(beforeOpus, resolvePrice), 'unpriced')
assert.equal(beforeOpus.totalCost, 0, 'historical events must not receive future prices')

const sonnetIntro = event({
  model: 'claude-sonnet-5',
  timestampMs: Date.parse('2026-08-31T23:59:59.999Z'),
})
assert.equal(priceUsageEvent(sonnetIntro, resolvePrice), 'priced')
assert.equal(sonnetIntro.totalCost, 14.7)

const sonnetStandard = event({
  model: 'claude-sonnet-5',
  timestampMs: Date.parse('2026-09-01T00:00:00.000Z'),
})
assert.equal(priceUsageEvent(sonnetStandard, resolvePrice), 'priced')
assert.equal(sonnetStandard.totalCost, 22.05)

const beforeSonnet = event({
  model: 'claude-sonnet-5',
  timestampMs: Date.parse('2026-06-29T23:59:59.999Z'),
})
assert.equal(priceUsageEvent(beforeSonnet, resolvePrice), 'unpriced')

const kimiK3 = event({
  provider: 'moonshot',
  model: 'kimi-k3',
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 0,
})
assert.equal(priceUsageEvent(kimiK3, resolvePrice), 'priced')
assert.deepEqual(
  [kimiK3.inputCost, kimiK3.outputCost, kimiK3.cacheReadCost, kimiK3.cacheWriteCost, kimiK3.totalCost],
  [3, 15, 0.3, 0, 18.3],
)

const kimiCacheWrite = event({
  provider: 'moonshot',
  model: 'kimi-k3',
  cacheWriteTokens: 1,
})
assert.equal(priceUsageEvent(kimiCacheWrite, resolvePrice), 'unpriced')
assert.equal(kimiCacheWrite.totalCost, 0, 'Kimi cache writes have no proven price mapping')

const kimiK27 = event({
  provider: 'moonshot',
  model: 'kimi-k2.7-code',
  cacheWriteTokens: 0,
})
assert.equal(priceUsageEvent(kimiK27, resolvePrice), 'priced')
assert.ok(Math.abs(kimiK27.totalCost - 5.14) < 1e-12)

for (const model of [
  'anthropic/claude-opus-5',
  'vendor-claude-opus-5',
  'moonshot/kimi-k3',
  'kimi-k3-highspeed',
  'claude-mythos-5',
]) {
  const unknown = event({ model })
  assert.equal(priceUsageEvent(unknown, resolvePrice), 'unpriced', `${model} must not fuzzy-match`)
  assert.equal(unknown.totalCost, 0)
}

const reported = event({
  inputCost: 1,
  outputCost: 2,
  cacheReadCost: 3,
  cacheWriteCost: 4,
  totalCost: 10,
})
assert.equal(priceUsageEvent(reported, resolvePrice), 'reported')
assert.deepEqual(
  [reported.inputCost, reported.outputCost, reported.cacheReadCost, reported.cacheWriteCost, reported.totalCost],
  [1, 2, 3, 4, 10],
)

db.prepare(`
  UPDATE model_prices
  SET input_price = 99, source = 'manual'
  WHERE model_id = 'claude-opus-5'
`).run()
db.exec(fs.readFileSync(migrationPath, 'utf8'))
assert.deepEqual(
  { ...db.prepare(`
    SELECT input_price as inputPrice, source
    FROM model_prices
    WHERE model_id = 'claude-opus-5'
  `).get() as Record<string, unknown> },
  { inputPrice: 99, source: 'manual' },
  'idempotent catalog refresh must not overwrite a manual price override',
)

db.exec(fs.readFileSync(rollbackPath, 'utf8'))
assert.equal(
  (db.prepare(`
    SELECT COUNT(*) as count
    FROM sqlite_master
    WHERE type = 'table' AND name = 'model_price_versions'
  `).get() as { count: number }).count,
  0,
)
assert.deepEqual(
  { ...db.prepare(`
    SELECT input_price as inputPrice, source
    FROM model_prices
    WHERE model_id = 'claude-opus-5'
  `).get() as Record<string, unknown> },
  { inputPrice: 99, source: 'manual' },
  'rollback must preserve an explicit manual row',
)
assert.deepEqual(
  (db.prepare(`
    SELECT id, total_cost as totalCost
    FROM usage_events
    ORDER BY id
  `).all() as Array<{ id: string; totalCost: number }>).map((row) => ({ ...row })),
  [
    { id: 'kimi-priced', totalCost: 0 },
    { id: 'kimi-write', totalCost: 0 },
    { id: 'opus-at', totalCost: 0 },
    { id: 'opus-before', totalCost: 0 },
    { id: 'reported', totalCost: 7 },
    { id: 'sonnet-intro', totalCost: 0 },
    { id: 'sonnet-standard', totalCost: 0 },
  ],
  'rollback must restore only migration-backfilled usage costs',
)
assert.equal(
  (db.prepare(`SELECT total_cost as totalCost FROM sessions WHERE session_id = 's1'`).get() as { totalCost: number }).totalCost,
  7,
)

testCliAndServerShareThePricedIngestionPath()
db.close()
console.log('model pricing regression tests passed (27 cases)')
