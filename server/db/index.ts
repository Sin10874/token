import { DatabaseSync } from 'node:sqlite'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { resolveOfficialPriceOverride } from './model-price-overrides.js'
import { OFFICIAL_MODEL_PRICE_VERSIONS } from '../../cli/prices.js'

const DATA_DIR = path.join(process.cwd(), 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

// Auto-migrate from old name
const OLD_DB = path.join(DATA_DIR, 'clawmeter.db')
const DB_PATH = path.join(DATA_DIR, 'tokend.db')
if (fs.existsSync(OLD_DB) && !fs.existsSync(DB_PATH)) {
  fs.renameSync(OLD_DB, DB_PATH)
  // Also migrate WAL/SHM if present
  for (const suffix of ['-wal', '-shm']) {
    const old = OLD_DB + suffix
    if (fs.existsSync(old)) fs.renameSync(old, DB_PATH + suffix)
  }
}
export const db = new DatabaseSync(DB_PATH)

db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')
db.exec('PRAGMA synchronous = NORMAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    timestamp_ms INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    session_key TEXT,
    agent TEXT,
    provider TEXT,
    model TEXT,
    channel TEXT DEFAULT 'unknown',
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

  CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_events(timestamp_ms);
  CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_events(session_id);
  CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_events(model);
  CREATE INDEX IF NOT EXISTS idx_usage_channel ON usage_events(channel);

  CREATE TABLE IF NOT EXISTS message_events (
    id TEXT PRIMARY KEY,
    timestamp_ms INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    session_key TEXT,
    agent TEXT,
    provider TEXT,
    model TEXT,
    channel TEXT DEFAULT 'unknown',
    kind TEXT NOT NULL,
    source_path TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_message_timestamp ON message_events(timestamp_ms);
  CREATE INDEX IF NOT EXISTS idx_message_session ON message_events(session_id);
  CREATE INDEX IF NOT EXISTS idx_message_channel ON message_events(channel);
  CREATE INDEX IF NOT EXISTS idx_message_kind ON message_events(kind);

  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    session_key TEXT,
    agent TEXT,
    title TEXT,
    channel TEXT DEFAULT 'unknown',
    first_seen_at INTEGER,
    last_seen_at INTEGER,
    current_model TEXT,
    call_count INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    total_cost REAL DEFAULT 0,
    source_path TEXT
  );

  CREATE TABLE IF NOT EXISTS model_prices (
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

  CREATE TABLE IF NOT EXISTS model_price_versions (
    model_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    valid_from_ms INTEGER NOT NULL,
    valid_to_ms INTEGER,
    input_price REAL NOT NULL,
    output_price REAL NOT NULL,
    cache_read_price REAL NOT NULL,
    cache_write_price REAL,
    currency TEXT NOT NULL DEFAULT 'USD',
    per_tokens INTEGER NOT NULL DEFAULT 1000000,
    cache_semantics TEXT NOT NULL CHECK (cache_semantics IN ('anthropic', 'hit_miss', 'generic')),
    context_window INTEGER,
    source_url TEXT NOT NULL,
    source_checked_at TEXT NOT NULL,
    PRIMARY KEY (model_id, valid_from_ms),
    CHECK (valid_to_ms IS NULL OR valid_to_ms > valid_from_ms)
  );

  CREATE INDEX IF NOT EXISTS idx_model_price_versions_lookup
    ON model_price_versions(model_id, valid_from_ms, valid_to_ms);

  CREATE TABLE IF NOT EXISTS ingestion_state (
    source_path TEXT PRIMARY KEY,
    last_processed_lines INTEGER DEFAULT 0,
    last_scan_at INTEGER,
    event_count INTEGER DEFAULT 0,
    parser_version INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS source_warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_path TEXT,
    warning TEXT,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS claude_code_config (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`)

function ensureColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

ensureColumn('usage_events', 'reasoning_tokens', 'INTEGER DEFAULT 0')
ensureColumn('usage_events', 'reasoning_cost', 'REAL DEFAULT 0')
ensureColumn('ingestion_state', 'parser_version', 'INTEGER DEFAULT 1')
ensureColumn('sessions', 'title', 'TEXT')

const DEFAULT_MODEL_PRICES = [
  ['claude-fable-5', 'anthropic', 10, 50, 1, 12.5],
  ['claude-opus-4-8', 'anthropic', 5, 25, 0.5, 6.25],
  ['claude-opus-4-7', 'anthropic', 5, 25, 0.5, 6.25],
  ['claude-opus-4-6', 'anthropic', 5, 25, 0.5, 6.25],
  ['claude-opus-4-5', 'anthropic', 5, 25, 0.5, 6.25],
  ['claude-opus-4-1', 'anthropic', 15, 75, 1.5, 18.75],
  ['claude-opus-4', 'anthropic', 15, 75, 1.5, 18.75],
  ['claude-sonnet-4-6', 'anthropic', 3, 15, 0.3, 3.75],
  ['claude-sonnet-4-5', 'anthropic', 3, 15, 0.3, 3.75],
  ['claude-sonnet-4', 'anthropic', 3, 15, 0.3, 3.75],
  ['claude-sonnet-3-7', 'anthropic', 3, 15, 0.3, 3.75],
  ['claude-haiku-4-5', 'anthropic', 1, 5, 0.1, 1.25],
  ['claude-haiku-4-5-20251001', 'anthropic', 1, 5, 0.1, 1.25],
  ['claude-haiku-3-5', 'anthropic', 0.8, 4, 0.08, 1],
  ['claude-haiku-3', 'anthropic', 0.25, 1.25, 0.03, 0.3],
  ['gpt-5.5', 'openai', 5, 30, 0.5, 0],
  ['gpt-5.4', 'openai', 2.5, 15, 0.25, 0],
  ['gpt-5-codex', 'openai', 1.25, 10, 0.125, 0],
  ['gpt-5.3-codex', 'openai', 1.75, 14, 0.175, 0],
  ['gpt-5.3-codex-spark', 'openai', 1.75, 14, 0.175, 0],
  ['codex-auto-review', 'openai', 0, 0, 0, 0],
  ['gpt-4o', 'openai', 2.5, 10, 1.25, 0],
  ['gemini-3-pro-preview', 'google', 2, 12, 0.2, 0],
  ['gemini-2.5-pro', 'google', 1.25, 10, 0.31, 0],
  ['kimi-k2.7', 'moonshot', 0.95, 4, 0.19, 0],
  ['k2p7', 'moonshot', 0.95, 4, 0.19, 0],
  ['kimi-k2.6', 'moonshot', 0.95, 4, 0.16, 0],
  ['k2p6', 'moonshot', 0.95, 4, 0.16, 0],
  ['kimi-k2.5', 'moonshot', 0.6, 3, 0.1, 0],
  ['k2p5', 'moonshot', 0.6, 3, 0.1, 0],
  ['kimi-code/kimi-for-coding', 'moonshot', 0.6, 3, 0.1, 0],
  ['kimi-k2-thinking', 'moonshot', 0.6, 2.5, 0.15, 0],
  ['deepseek-v4-flash', 'deepseek', 0.14, 0.28, 0.0028, 0],
  ['deepseek-v4-pro', 'deepseek', 0.435, 0.87, 0.003625, 0],
  ['mimo-v2.5', 'xiaomi', 0.14, 0.28, 0.0028, 0],
  ['mimo-v2.5-pro', 'xiaomi', 0.435, 0.87, 0.0036, 0],
  ['grok-code', 'xai', 0.2, 1.5, 0.02, 0],
  ['glm-4.7-free', 'zhipu', 0, 0, 0, 0],
  ['minimax-m2.1-free', 'minimax', 0, 0, 0, 0],
  ['glm-5.2', 'zhipu', 1.4, 4.4, 0.26, 0],
  ['glm-5.1', 'zhipu', 1.4, 4.4, 0.26, 0],
  ['glm-5', 'zhipu', 1, 3.2, 0.2, 0],
  ['glm-5-turbo', 'zhipu', 1.2, 4, 0.24, 0],
  ['glm-4.7', 'zhipu', 0.6, 2.2, 0.11, 0],
  ['glm-4.7-flashx', 'zhipu', 0.07, 0.4, 0.01, 0],
  ['glm-4.5-air', 'zhipu', 0.2, 1.1, 0.03, 0],
  // MiniMax M3 缓存写未公布，按 M2.7 同款 1.25x input 估算
  ['MiniMax-M3', 'minimax', 0.3, 1.2, 0.06, 0.375],
  ['MiniMax-M2.7', 'minimax', 0.3, 1.2, 0.06, 0.375],
  ['MiniMax-M2.7-highspeed', 'minimax', 0.6, 2.4, 0.06, 0.375],
  ['MiniMax-M2.5', 'minimax', 0.3, 1.2, 0.03, 0.375],
  ['MiniMax-M2.5-highspeed', 'minimax', 0.6, 2.4, 0.03, 0.375],
] as const

function upsertDefaultModelPrices() {
  const upsert = db.prepare(`
    INSERT INTO model_prices (model_id, provider, input_price, output_price, cache_read_price, cache_write_price, per_tokens, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1000000, 'default', ?)
    ON CONFLICT(model_id) DO UPDATE SET
      provider = excluded.provider,
      input_price = excluded.input_price,
      output_price = excluded.output_price,
      cache_read_price = excluded.cache_read_price,
      cache_write_price = excluded.cache_write_price,
      per_tokens = excluded.per_tokens,
      source = excluded.source,
      updated_at = excluded.updated_at
    WHERE source != 'manual'
  `)
  const now = Date.now()
  for (const [modelId, provider, inp, out, cr, cw] of DEFAULT_MODEL_PRICES) {
    upsert.run(modelId, provider, inp, out, cr, cw, now)
  }
}

upsertDefaultModelPrices()

function upsertVersionedModelPrices() {
  const upsertVersion = db.prepare(`
    INSERT INTO model_price_versions (
      model_id, provider, valid_from_ms, valid_to_ms,
      input_price, output_price, cache_read_price, cache_write_price,
      per_tokens, cache_semantics, context_window, source_url, source_checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(model_id, valid_from_ms) DO UPDATE SET
      provider = excluded.provider,
      valid_to_ms = excluded.valid_to_ms,
      input_price = excluded.input_price,
      output_price = excluded.output_price,
      cache_read_price = excluded.cache_read_price,
      cache_write_price = excluded.cache_write_price,
      per_tokens = excluded.per_tokens,
      cache_semantics = excluded.cache_semantics,
      context_window = excluded.context_window,
      source_url = excluded.source_url,
      source_checked_at = excluded.source_checked_at
  `)
  const upsertCurrent = db.prepare(`
    INSERT INTO model_prices (
      model_id, provider, input_price, output_price,
      cache_read_price, cache_write_price, per_tokens, source, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'default-versioned', ?)
    ON CONFLICT(model_id) DO UPDATE SET
      provider = excluded.provider,
      input_price = excluded.input_price,
      output_price = excluded.output_price,
      cache_read_price = excluded.cache_read_price,
      cache_write_price = excluded.cache_write_price,
      per_tokens = excluded.per_tokens,
      source = excluded.source,
      updated_at = excluded.updated_at
    WHERE source != 'manual'
  `)

  const now = Date.now()
  for (const row of OFFICIAL_MODEL_PRICE_VERSIONS) {
    upsertVersion.run(
      row.modelId, row.provider, row.validFromMs, row.validToMs,
      row.inputPrice, row.outputPrice, row.cacheReadPrice, row.cacheWritePrice,
      row.perTokens, row.cacheSemantics, row.contextWindow, row.sourceUrl, row.sourceCheckedAt,
    )
  }

  const modelIds = new Set(OFFICIAL_MODEL_PRICE_VERSIONS.map((row) => row.modelId))
  for (const modelId of modelIds) {
    const active = OFFICIAL_MODEL_PRICE_VERSIONS.find((row) => (
      row.modelId === modelId
      && now >= row.validFromMs
      && (row.validToMs == null || now < row.validToMs)
    ))
    if (!active) continue
    upsertCurrent.run(
      active.modelId, active.provider, active.inputPrice, active.outputPrice,
      active.cacheReadPrice, active.cacheWritePrice || 0, active.perTokens, now,
    )
  }
}

upsertVersionedModelPrices()

// Seed default Claude Code config if empty
const ccConfigCount = (db.prepare('SELECT COUNT(*) as c FROM claude_code_config').get() as { c: number }).c
if (ccConfigCount === 0) {
  const insertConfig = db.prepare('INSERT OR IGNORE INTO claude_code_config (key, value) VALUES (?, ?)')
  // Default monthly quota: $100 for Max plan (Pro is ~$20, Max5x is ~$100, Max20x is ~$200)
  insertConfig.run('monthly_quota_usd', '100')
  // Billing cycle day (1-28), day of month when quota resets
  insertConfig.run('billing_cycle_day', '1')
  // Plan name
  insertConfig.run('plan_name', 'Max 5x')
}

// Try to load model prices from openclaw.json
function loadOpenClawPrices() {
  const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json')
  if (!fs.existsSync(configPath)) return
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const providers = config?.models?.providers || {}
    const upsert = db.prepare(`
      INSERT INTO model_prices (model_id, provider, input_price, output_price, cache_read_price, cache_write_price, per_tokens, source, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1000000, 'openclaw.json', ?)
      ON CONFLICT(model_id) DO UPDATE SET
        input_price = excluded.input_price,
        output_price = excluded.output_price,
        cache_read_price = excluded.cache_read_price,
        cache_write_price = excluded.cache_write_price,
        source = excluded.source,
        updated_at = excluded.updated_at
      WHERE source != 'manual'
    `)
    const now = Date.now()
    for (const [providerName, providerData] of Object.entries(providers)) {
      const models = (providerData as any)?.models || []
      for (const model of models) {
        if (model.cost) {
          const prices = resolveOfficialPriceOverride(model.id, {
            input_price: model.cost.input || 0,
            output_price: model.cost.output || 0,
            cache_read_price: model.cost.cacheRead || 0,
            cache_write_price: model.cost.cacheWrite || 0,
          })
          const inp = prices.input_price
          const out = prices.output_price
          const cr = prices.cache_read_price
          const cw = prices.cache_write_price
          // Skip all-zero pricing — don't overwrite seed data with zeros
          if (inp === 0 && out === 0 && cr === 0 && cw === 0) continue
          upsert.run(model.id, providerName, inp, out, cr, cw, now)
        }
      }
    }
  } catch (e) {
    // Non-fatal
  }
}

loadOpenClawPrices()

export default db
