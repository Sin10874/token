import { DatabaseSync } from 'node:sqlite'
import path from 'path'
import fs from 'fs'
import os from 'os'

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
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    input_cost REAL DEFAULT 0,
    output_cost REAL DEFAULT 0,
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

  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    session_key TEXT,
    agent TEXT,
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

  CREATE TABLE IF NOT EXISTS ingestion_state (
    source_path TEXT PRIMARY KEY,
    last_processed_lines INTEGER DEFAULT 0,
    last_scan_at INTEGER,
    event_count INTEGER DEFAULT 0
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

// Seed default model prices if empty
const priceCountRow = db.prepare('SELECT COUNT(*) as c FROM model_prices').get() as { c: number }
if (priceCountRow.c === 0) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO model_prices (model_id, provider, input_price, output_price, cache_read_price, cache_write_price, per_tokens, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1000000, 'default', ?)
  `)
  const now = Date.now()
  const defaultPrices = [
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
    ['gpt-5.4', 'openai', 0, 0, 0, 0],
    ['gpt-4o', 'openai', 2.5, 10, 0, 0],
    ['kimi-k2.5', 'moonshot', 0.6, 3, 0.1, 0],
    ['glm-5-turbo', 'zhipu', 1.2, 4, 0.24, 0],
    ['glm-4.7', 'zhipu', 0.6, 2.2, 0.11, 0],
    ['glm-4.5-air', 'zhipu', 0.2, 1.1, 0.03, 0],
    ['MiniMax-M2.7', 'minimax', 0.3, 1.2, 0.03, 0.12],
  ]
  for (const [modelId, provider, inp, out, cr, cw] of defaultPrices) {
    insert.run(modelId, provider, inp, out, cr, cw, now)
  }
}

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
          const inp = model.cost.input || 0
          const out = model.cost.output || 0
          const cr = model.cost.cacheRead || 0
          const cw = model.cost.cacheWrite || 0
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
