import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  CATALOG_HASH,
  CATALOG_VERSION,
  MODEL_ALIASES,
  PRICE_VERSIONS,
  validateCatalog,
} from '../cli/pricing/catalog.ts'
import type { PriceVersion } from '../cli/pricing/types.ts'
import {
  renderCatalogSql,
  replaceGeneratedCatalogBlock,
} from '../scripts/generate-supabase-pricing.mjs'

const BEGIN_MARKER = '-- BEGIN GENERATED PRICING CATALOG'
const END_MARKER = '-- END GENERATED PRICING CATALOG'

function parseSqlValues(source: string): Array<string | number | null> {
  const values: Array<string | number | null> = []
  let token = ''
  let quoted = false

  const push = () => {
    const trimmed = token.trim()
    if (/^NULL$/i.test(trimmed)) values.push(null)
    else if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      values.push(trimmed.slice(1, -1).replace(/''/g, "'"))
    } else {
      const numeric = Number(trimmed)
      assert.ok(Number.isFinite(numeric), `expected SQL literal, received ${trimmed}`)
      values.push(numeric)
    }
    token = ''
  }

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === "'") {
      token += character
      if (quoted && source[index + 1] === "'") {
        token += source[index + 1]
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === ',' && !quoted) {
      push()
    } else {
      token += character
    }
  }
  push()
  return values
}

function parseGeneratedModels(sql: string): PriceVersion[] {
  const statement = /INSERT INTO pg_temp\.tokend_expected_pricing_models\s*\([^)]+\)\s*VALUES\s*\(([\s\S]*?)\);/g
  return [...sql.matchAll(statement)].map(match => {
    const [
      catalogVersion,
      modelId,
      provider,
      validFrom,
      validTo,
      standardInput,
      standardOutput,
      standardCacheRead,
      standardCacheWrite,
      longInput,
      longOutput,
      longCacheRead,
      longCacheWrite,
      longContextThreshold,
      sourceCheckedAt,
      sourceUrl,
    ] = parseSqlValues(match[1])
    const row: PriceVersion = {
      catalogVersion: String(catalogVersion),
      modelId: String(modelId),
      provider: String(provider),
      validFrom: String(validFrom),
      standard: {
        input: Number(standardInput),
        output: Number(standardOutput),
        cacheRead: Number(standardCacheRead),
        cacheWrite: Number(standardCacheWrite),
      },
      sourceCheckedAt: String(sourceCheckedAt),
      sourceUrl: String(sourceUrl),
    }
    if (validTo !== null) row.validTo = String(validTo)
    if (longInput !== null) {
      assert.notEqual(longOutput, null)
      assert.notEqual(longCacheRead, null)
      assert.notEqual(longCacheWrite, null)
      assert.notEqual(longContextThreshold, null)
      row.longContext = {
        input: Number(longInput),
        output: Number(longOutput),
        cacheRead: Number(longCacheRead),
        cacheWrite: Number(longCacheWrite),
      }
      row.longContextThreshold = Number(longContextThreshold)
    } else {
      assert.deepEqual(
        [longOutput, longCacheRead, longCacheWrite, longContextThreshold],
        [null, null, null, null],
      )
    }
    return row
  })
}

function parseGeneratedAliases(sql: string): Record<string, string> {
  const statement = /INSERT INTO pg_temp\.tokend_expected_pricing_aliases\s*\([^)]+\)\s*VALUES\s*\(([\s\S]*?)\);/g
  const entries = [...sql.matchAll(statement)].map(match => {
    const [version, alias, modelId] = parseSqlValues(match[1])
    assert.equal(version, CATALOG_VERSION)
    return [String(alias), String(modelId)] as const
  })
  return Object.fromEntries(entries)
}

function testGeneratorIsDeterministic(): void {
  assert.equal(renderCatalogSql(), renderCatalogSql())
}

function testGeneratedRowsRoundTripToTypescriptCatalog(): void {
  const sql = renderCatalogSql()
  const models = parseGeneratedModels(sql)
  const aliases = parseGeneratedAliases(sql)

  assert.equal(models.length, PRICE_VERSIONS.length)
  assert.equal(Object.keys(aliases).length, Object.keys(MODEL_ALIASES).length)
  assert.deepEqual(models, PRICE_VERSIONS)
  assert.deepEqual(aliases, MODEL_ALIASES)
  assert.deepEqual(
    models.map(row => `${row.modelId}\u0000${row.validFrom}`),
    [...models]
      .sort((left, right) => {
        const leftKey = `${left.modelId}\u0000${left.validFrom}`
        const rightKey = `${right.modelId}\u0000${right.validFrom}`
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
      })
      .map(row => `${row.modelId}\u0000${row.validFrom}`),
  )
  assert.deepEqual(Object.keys(aliases), Object.keys(aliases).sort())
  assert.match(sql, new RegExp(`'${CATALOG_VERSION}'`))
  assert.match(sql, new RegExp(`'${CATALOG_HASH}'`))
  const latestSourceCheck = PRICE_VERSIONS
    .map(row => row.sourceCheckedAt)
    .sort()
    .at(-1)
  assert.match(
    sql,
    new RegExp(`tokend_install_pricing_catalog\\('${CATALOG_VERSION}', '${CATALOG_HASH}', '${latestSourceCheck}'\\)`),
  )
  assert.doesNotMatch(sql, /\/Users\/|\/home\/|SUPABASE_(?:KEY|TOKEN)|NPM_TOKEN|member[_ -]?secret/i)
  validateCatalog(models, aliases)
}

function testSharedCatalogValidatorRejectsUnsafeInput(): void {
  const row = PRICE_VERSIONS[0]
  assert.throws(() => validateCatalog([row, row], {}), /duplicate/i)
  assert.throws(() => validateCatalog([
    { ...row, validTo: '2026-08-01T00:00:00Z' },
    { ...row, validFrom: '2026-07-01T00:00:00Z' },
  ], {}), /overlap/i)
  assert.throws(() => validateCatalog([
    { ...row, standard: { ...row.standard, input: -1 } },
  ], {}), /rate/i)
}

function testMarkerReplacementIsSurgical(): void {
  const original = `header\r\n${BEGIN_MARKER}\r\nold generated bytes\r\n${END_MARKER}\r\nfooter\r\n`
  const replaced = replaceGeneratedCatalogBlock(original)
  const prefix = original.slice(0, original.indexOf(BEGIN_MARKER) + BEGIN_MARKER.length)
  const suffix = original.slice(original.indexOf(END_MARKER))

  assert.ok(replaced.startsWith(prefix))
  assert.ok(replaced.endsWith(suffix))
  assert.match(replaced, /\r\nINSERT INTO pg_temp\.tokend_expected_pricing_models/)
  assert.doesNotMatch(replaced, /old generated bytes/)

  for (const invalid of [
    'no markers',
    `${BEGIN_MARKER}\nmissing end`,
    `${END_MARKER}\n${BEGIN_MARKER}`,
    `${BEGIN_MARKER}\n${BEGIN_MARKER}\n${END_MARKER}`,
    `${BEGIN_MARKER}\n${END_MARKER}\n${END_MARKER}`,
  ]) {
    assert.throws(() => replaceGeneratedCatalogBlock(invalid), /marker/i)
  }
}

const NEW_TABLES = [
  'tokend_pricing_catalogs',
  'tokend_pricing_canonical_models',
  'tokend_pricing_models',
  'tokend_pricing_aliases',
  'tokend_event_cost_revisions',
  'tokend_pricing_state',
  'tokend_pricing_backfill_runs',
  'tokend_pricing_backfill_targets',
  'tokend_pricing_shadow_sessions',
  'tokend_pricing_audit',
] as const

function readMigration(): string {
  return fs.readFileSync(
    path.resolve(process.cwd(), 'supabase/migrations/202607100001_pricing_core.sql'),
    'utf8',
  )
}

function tableDefinition(sql: string, table: string): string {
  const match = sql.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i'),
  )
  assert.ok(match, `missing CREATE TABLE IF NOT EXISTS for ${table}`)
  return match[1]
}

function testMigrationEmbedsExactlyGeneratedCatalog(): void {
  const migration = readMigration()
  const begin = migration.indexOf(BEGIN_MARKER)
  const end = migration.indexOf(END_MARKER)
  assert.ok(begin >= 0 && end > begin)
  assert.equal(migration.indexOf(BEGIN_MARKER, begin + 1), -1)
  assert.equal(migration.indexOf(END_MARKER, end + 1), -1)
  assert.equal(
    migration.slice(begin + BEGIN_MARKER.length, end),
    `\n${renderCatalogSql().trimEnd()}\n`,
  )
  assert.equal(replaceGeneratedCatalogBlock(migration), migration)
  assert.deepEqual(parseGeneratedModels(migration), PRICE_VERSIONS)
  assert.deepEqual(parseGeneratedAliases(migration), MODEL_ALIASES)
}

function testMigrationIsAdditiveAndDefinesRequiredKeys(): void {
  const migration = readMigration()
  for (const table of NEW_TABLES) tableDefinition(migration, table)

  const primaryKeys: Record<(typeof NEW_TABLES)[number], string[]> = {
    tokend_pricing_catalogs: ['version'],
    tokend_pricing_canonical_models: ['version', 'model_id'],
    tokend_pricing_models: ['version', 'model_id', 'valid_from'],
    tokend_pricing_aliases: ['version', 'alias'],
    tokend_event_cost_revisions: ['version', 'member_code', 'event_id'],
    tokend_pricing_state: ['singleton'],
    tokend_pricing_backfill_runs: ['run_id'],
    tokend_pricing_backfill_targets: ['run_id', 'member_code', 'event_id'],
    tokend_pricing_shadow_sessions: ['run_id', 'member_code', 'session_id'],
    tokend_pricing_audit: ['audit_id'],
  }
  for (const [table, columns] of Object.entries(primaryKeys)) {
    const pattern = columns.join('\\s*,\\s*')
    assert.match(
      migration,
      new RegExp(`ALTER TABLE public\\.${table}[\\s\\S]{0,240}PRIMARY KEY \\(${pattern}\\)`, 'i'),
    )
  }
  assert.match(
    migration,
    /ALTER TABLE public\.tokend_pricing_catalogs[\s\S]{0,240}UNIQUE \(hash\)/i,
  )

  for (const column of [
    'pricing_status',
    'pricing_tier',
    'price_version',
    'matched_model_id',
    'token_semantics',
    'unallocated_cost',
    'breakdown_status',
  ]) {
    assert.match(
      migration,
      new RegExp(`ALTER TABLE public\\.tokend_usage_events\\s+ADD COLUMN IF NOT EXISTS ${column}\\b`, 'i'),
    )
  }

  assert.doesNotMatch(
    migration,
    /\b(?:DROP|TRUNCATE)\s+(?:TABLE\s+)?(?:public\.)?tokend_(?:members|usage_events|sessions|sync_state|model_prices)\b/i,
  )
  assert.doesNotMatch(
    migration,
    /ALTER TABLE public\.tokend_(?:members|usage_events|sessions|sync_state|model_prices)[^;]*\b(?:DROP|RENAME|ALTER COLUMN|PRIMARY KEY)\b/i,
  )
  assert.doesNotMatch(migration, /ON CONFLICT[\s\S]{0,120}DO UPDATE/i)
}

function testMigrationUsesExactMoneyTypesAndAuditShape(): void {
  const migration = readMigration()
  const definitions = NEW_TABLES.map(table => tableDefinition(migration, table)).join('\n')
  const moneyColumns = [...definitions.matchAll(
    /^\s*([a-z_]*(?:cost|rate))\s+(NUMERIC\s*\([^)]*\)|[^,\n]+)/gim,
  )]
  assert.ok(moneyColumns.length >= 22, 'expected all rate and cost columns to be discoverable')
  for (const [, column, type] of moneyColumns) {
    assert.match(type, /^NUMERIC\s*\(20\s*,\s*10\)/i, `${column} must use NUMERIC(20,10)`)
  }
  assert.doesNotMatch(definitions, /\b(?:REAL|MONEY|DOUBLE PRECISION)\b/i)
  assert.match(
    migration,
    /ADD COLUMN IF NOT EXISTS unallocated_cost\s+NUMERIC\s*\(20\s*,\s*10\)/i,
  )

  const revision = tableDefinition(migration, 'tokend_event_cost_revisions')
  for (const column of [
    'backfill_run_id', 'input_cost', 'output_cost', 'reasoning_cost', 'cache_read_cost',
    'cache_write_cost', 'unallocated_cost', 'total_cost', 'pricing_status', 'pricing_tier',
    'matched_model_id', 'price_version', 'breakdown_status', 'computed_at',
  ]) assert.match(revision, new RegExp(`\\b${column}\\b`))

  const runs = tableDefinition(migration, 'tokend_pricing_backfill_runs')
  for (const column of [
    'catalog_version', 'status', 'snapshot_at', 'target_count', 'input_tokens', 'output_tokens',
    'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens', 'before_total_cost',
    'cursor_member_code', 'cursor_event_id', 'reconciliation_hash', 'started_at', 'completed_at',
  ]) assert.match(runs, new RegExp(`\\b${column}\\b`))

  const targets = tableDefinition(migration, 'tokend_pricing_backfill_targets')
  assert.match(targets, /\bevent_snapshot\s+JSONB\s+NOT NULL\b/i)
  assert.match(targets, /\bprocessed_at\s+TIMESTAMPTZ\b/i)

  const shadows = tableDefinition(migration, 'tokend_pricing_shadow_sessions')
  for (const column of [
    'input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens',
    'input_cost', 'output_cost', 'reasoning_cost', 'cache_read_cost', 'cache_write_cost',
    'total_cost', 'call_count', 'reported_count', 'estimated_count', 'zero_rate_count',
    'unpriced_count', 'legacy_count',
  ]) assert.match(shadows, new RegExp(`\\b${column}\\b`))

  const audit = tableDefinition(migration, 'tokend_pricing_audit')
  for (const column of [
    'run_id', 'action', 'actor', 'old_catalog_version', 'new_catalog_version',
    'old_backfill_run_id', 'new_backfill_run_id', 'payload', 'created_at',
  ]) assert.match(audit, new RegExp(`\\b${column}\\b`))
}

function testMigrationLocksDownCatalogAndTableAccess(): void {
  const migration = readMigration()
  for (const table of NEW_TABLES) {
    assert.match(
      migration,
      new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, 'i'),
    )
    assert.match(
      migration,
      new RegExp(`REVOKE ALL PRIVILEGES ON TABLE public\\.${table} FROM PUBLIC, anon, authenticated`, 'i'),
    )
    assert.match(
      migration,
      new RegExp(`REVOKE ALL PRIVILEGES ON TABLE public\\.${table} FROM service_role`, 'i'),
    )
    assert.match(
      migration,
      new RegExp(`GRANT SELECT ON TABLE public\\.${table} TO service_role`, 'i'),
    )
  }
  assert.match(
    migration,
    /GRANT DELETE ON TABLE public\.tokend_event_cost_revisions TO service_role/i,
  )
  for (const table of NEW_TABLES.filter(table => table !== 'tokend_event_cost_revisions')) {
    assert.doesNotMatch(
      migration,
      new RegExp(`GRANT DELETE ON TABLE public\\.${table} TO service_role`, 'i'),
    )
  }
  assert.doesNotMatch(
    migration,
    /GRANT (?:ALL(?: PRIVILEGES)?|INSERT|UPDATE|TRUNCATE|REFERENCES|TRIGGER)[^;]*TO service_role/i,
  )
  assert.doesNotMatch(migration, /\bCREATE\s+POLICY\b/i)
  assert.doesNotMatch(migration, /\bGRANT\b[^;]*\bTO\s+(?:anon|authenticated)\b/i)

  const functions = [...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\s*\(/gi)]
  assert.ok(functions.length >= 3)
  assert.equal((migration.match(/\bSECURITY DEFINER\b/g) ?? []).length, functions.length)
  assert.equal(
    (migration.match(/SET search_path\s*=\s*public\s*,\s*pg_temp/g) ?? []).length,
    functions.length,
  )
  for (const [, functionName] of functions) {
    assert.match(
      migration,
      new RegExp(`REVOKE ALL ON FUNCTION public\\.${functionName}\\([^;]+FROM PUBLIC, anon, authenticated`, 'i'),
    )
    assert.match(
      migration,
      new RegExp(`REVOKE ALL ON FUNCTION public\\.${functionName}\\([^;]+FROM service_role`, 'i'),
    )
  }

  assert.match(migration, /ERRCODE\s*=\s*'55000'/)
  assert.match(migration, /p_hash IS NULL\s+OR p_hash !~/)
  assert.match(
    migration,
    /BEFORE UPDATE OR DELETE ON public\.tokend_pricing_catalogs/i,
  )
  for (const table of [
    'tokend_pricing_canonical_models',
    'tokend_pricing_models',
    'tokend_pricing_aliases',
  ]) {
    assert.match(
      migration,
      new RegExp(`BEFORE INSERT OR UPDATE OR DELETE ON public\\.${table}`, 'i'),
    )
  }
  assert.match(
    migration,
    /BEFORE UPDATE OR DELETE ON public\.tokend_pricing_backfill_targets/i,
  )
  assert.match(migration, /NEW\.created_at IS DISTINCT FROM OLD\.created_at/i)
  assert.match(migration, /\bEXCEPT\b[\s\S]+\bEXCEPT\b/i)
  assert.match(migration, /NOTIFY pgrst, 'reload schema'/i)
}

function testMigrationSeedsOnlyNullStatePointers(): void {
  const migration = readMigration()
  const state = tableDefinition(migration, 'tokend_pricing_state')
  for (const column of [
    'active_catalog_version',
    'previous_catalog_version',
    'active_backfill_run_id',
    'previous_backfill_run_id',
  ]) assert.match(state, new RegExp(`\\b${column}\\b`))
  assert.match(
    migration,
    /INSERT INTO public\.tokend_pricing_state[\s\S]{0,360}VALUES\s*\(TRUE, NULL, NULL, NULL, NULL\)[\s\S]{0,120}DO NOTHING/i,
  )
}

function testSupabaseConfigAndPackageScriptsAreIsolated(): void {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string> }
  assert.equal(
    packageJson.scripts?.['generate:pricing-sql'],
    'tsx scripts/generate-supabase-pricing.mjs --write',
  )
  assert.equal(
    packageJson.scripts?.['check:pricing-sql'],
    'tsx scripts/generate-supabase-pricing.mjs --check',
  )

  const config = fs.readFileSync(path.resolve(process.cwd(), 'supabase/config.toml'), 'utf8')
  assert.match(config, /^project_id\s*=\s*"tokend-pricing-contract"/m)
  assert.match(config, /\[db\.migrations\]\s*\nenabled\s*=\s*false/m)
  assert.match(config, /\[db\.seed\]\s*\nenabled\s*=\s*false/m)
  const ports = [...config.matchAll(/^port\s*=\s*(\d+)\s*$/gm)].map(match => Number(match[1]))
  assert.ok(ports.length >= 2)
  assert.equal(new Set(ports).size, ports.length)
  assert.ok(ports.every(port => port >= 55000))
}

function testPgTapContractIsSelfContained(): void {
  const pgTap = fs.readFileSync(
    path.resolve(process.cwd(), 'supabase/tests/database/pricing.test.sql'),
    'utf8',
  )
  assert.match(pgTap, /^BEGIN;/m)
  assert.match(pgTap, /^ROLLBACK;/m)
  assert.match(pgTap, /SELECT plan\(34\);/)
  assert.equal(
    (pgTap.match(/^\\ir \.\.\/\.\.\/migrations\/202607100001_pricing_core\.sql$/gm) ?? []).length,
    2,
  )
  for (const fixture of [
    'tokend_members',
    'tokend_usage_events',
    'tokend_sessions',
    'tokend_sync_state',
    'tokend_model_prices',
  ]) assert.match(pgTap, new RegExp(`CREATE TABLE public\\.${fixture}\\b`, 'i'))
  assert.match(pgTap, new RegExp(CATALOG_HASH))
  assert.match(
    pgTap,
    /SELECT fk_ok\([\s\S]*ARRAY\['version', 'model_id'\][\s\S]*tokend_pricing_canonical_models/i,
  )
  assert.doesNotMatch(pgTap, /SELECT has_fk\(/i)
  assert.ok((pgTap.match(/throws_ok\(/g) ?? []).length >= 11)
  assert.ok((pgTap.match(/'55000'/g) ?? []).length >= 11)
  assert.match(pgTap, /has_table_privilege\(\s*'service_role'[\s\S]*'SELECT'\s*\)/i)
  assert.match(pgTap, /has_table_privilege\(\s*'service_role'[\s\S]*'DELETE'\s*\)/i)
  for (const privilege of ['INSERT', 'UPDATE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
    assert.match(
      pgTap,
      new RegExp(`has_table_privilege\\(\\s*'service_role'[\\s\\S]*'${privilege}'\\s*\\)`, 'i'),
    )
  }
  assert.match(pgTap, /has_function_privilege\(\s*'service_role'[\s\S]*'EXECUTE'\s*\)/i)
  assert.doesNotMatch(pgTap, /\/Users\/|\/home\/|SUPABASE_(?:KEY|TOKEN)|NPM_TOKEN|member[_ -]?secret/i)
}

testGeneratorIsDeterministic()
testGeneratedRowsRoundTripToTypescriptCatalog()
testSharedCatalogValidatorRejectsUnsafeInput()
testMarkerReplacementIsSurgical()
testMigrationEmbedsExactlyGeneratedCatalog()
testMigrationIsAdditiveAndDefinesRequiredKeys()
testMigrationUsesExactMoneyTypesAndAuditShape()
testMigrationLocksDownCatalogAndTableAccess()
testMigrationSeedsOnlyNullStatePointers()
testSupabaseConfigAndPackageScriptsAreIsolated()
testPgTapContractIsSelfContained()
console.log('pricing SQL contract tests passed')
