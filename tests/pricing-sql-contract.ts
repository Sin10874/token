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

function readUploadMigration(): string {
  return fs.readFileSync(
    path.resolve(process.cwd(), 'supabase/migrations/202607100002_pricing_upload.sql'),
    'utf8',
  )
}

function readRpcMigration(): string {
  return fs.readFileSync(
    path.resolve(process.cwd(), 'supabase/migrations/202607100003_pricing_rpcs.sql'),
    'utf8',
  )
}

function functionDefinition(sql: string, name: string): string {
  const match = sql.match(new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${name}\\s*\\([\\s\\S]*?\\n\\$function\\$;`,
    'i',
  ))
  assert.ok(match, `missing complete function definition for ${name}`)
  return match[0]
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

function testUploadMigrationDefinesOnlyExactRpcSignatures(): void {
  const migration = readUploadMigration()
  const expected = [
    ['tokend_price_event', 'p_event JSONB, p_catalog_version TEXT', 'JSONB'],
    ['tokend_upload_events_v2', 'p_token TEXT, p_events JSONB, p_sync_states JSONB', 'JSON'],
    ['tokend_upload_events', 'p_token TEXT, p_events JSONB, p_sync_states JSONB', 'JSON'],
    ['tokend_pricing_preflight', '', 'JSON'],
  ] as const

  const definitions = [...migration.matchAll(
    /CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\s*\(([^)]*)\)\s*RETURNS\s+(JSONB|JSON)\b/gi,
  )]
  assert.equal(definitions.length, expected.length)
  for (const [name, args, returns] of expected) {
    const matches = definitions.filter(match => match[1] === name)
    assert.equal(matches.length, 1, `${name} must not be overloaded`)
    assert.equal(matches[0][2].replace(/\s+/g, ' ').trim(), args)
    assert.equal(matches[0][3].toUpperCase(), returns)

    const body = functionDefinition(migration, name)
    assert.match(body, /LANGUAGE\s+(?:plpgsql|sql)\b/i)
    assert.match(body, /SECURITY DEFINER/i)
    assert.match(body, /SET search_path\s*=\s*public\s*,\s*pg_temp/i)
  }

  assert.doesNotMatch(
    migration,
    /DROP\s+(?:TABLE|VIEW)\s+(?:IF EXISTS\s+)?(?:public\.)?tokend_/i,
  )
  assert.doesNotMatch(
    migration,
    /DROP\s+FUNCTION[^;]*tokend_(?:get_|validate_token|upload_messages|rebuild|backfill)/i,
  )
  assert.match(migration, /NOTIFY pgrst, 'reload schema'/i)
}

function testUploadMigrationValidatesBeforeMutatingAndPreservesBaseRows(): void {
  const migration = readUploadMigration()
  const upload = functionDefinition(migration, 'tokend_upload_events_v2')
  const wrapper = functionDefinition(migration, 'tokend_upload_events')

  assert.match(upload, /jsonb_typeof\(p_events\)\s+IS DISTINCT FROM\s+'array'/i)
  assert.match(upload, /jsonb_typeof\(p_sync_states\)\s+IS DISTINCT FROM\s+'array'/i)
  assert.match(upload, /ERRCODE\s*=\s*'22023'/i)
  assert.match(upload, /WITH ORDINALITY/i)
  assert.match(upload, /DISTINCT ON\s*\([^)]*->>\s*'id'\)/i)
  for (const field of [
    'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens',
  ]) assert.match(upload, new RegExp(`'${field}'`))
  assert.match(upload, /ON CONFLICT\s*\(id, member_code\)\s*DO NOTHING/i)
  assert.match(upload, /SET\s+project\s*=\s*COALESCE/i)
  const baseUpdates = [...upload.matchAll(
    /UPDATE public\.tokend_usage_events\s+SET([\s\S]*?)\s+WHERE\s+id\s*=/gi,
  )]
  assert.equal(baseUpdates.length, 1)
  assert.match(baseUpdates[0][1], /^\s*project\s*=\s*COALESCE\([\s\S]*\)\s*$/i)
  assert.doesNotMatch(baseUpdates[0][1], /,\s*[a-z_]+\s*=/i)
  assert.match(upload, /pricing_status\s*[,)]/i)
  assert.match(upload, /'reported'/i)
  assert.match(upload, /'legacy'/i)
  assert.match(upload, /'unpriced'/i)
  assert.match(upload, /LEFT\([^,]+,\s*256\)/i)
  assert.match(upload, /LEFT\([^,]+,\s*512\)/i)
  assert.match(upload, /RETURN json_build_object\('ok', true, 'inserted', v_inserted\)/i)
  assert.match(upload, /RETURN json_build_object\('ok', false, 'error', 'invalid_token'\)/i)
  assert.match(wrapper, /tokend_upload_events_v2\(p_token, p_events, p_sync_states\)/i)
}

function testServerEstimatorAndRevisionContractAreComplete(): void {
  const migration = readUploadMigration()
  const estimator = functionDefinition(migration, 'tokend_price_event')
  const upload = functionDefinition(migration, 'tokend_upload_events_v2')

  assert.match(estimator, /tokend_pricing_canonical_models/i)
  assert.match(estimator, /tokend_pricing_aliases/i)
  assert.match(estimator, /\^\(\.\*\)-\(\[0-9\]\{8\}\)\$/i)
  assert.match(estimator, /make_date/i)
  assert.match(estimator, /valid_from\s*<=\s*v_event_at/i)
  assert.match(estimator, /v_event_at\s*<\s*[^\n;]*valid_to/i)
  assert.match(estimator, /v_prompt_tokens\s*>\s*v_price\.long_context_threshold/i)
  assert.match(estimator, /v_semantics\s*=\s*'disjoint'/i)
  assert.match(estimator, /reasoning_cost[\s\S]{0,180}output_rate/i)
  assert.match(estimator, /'zero_rate'/i)
  assert.match(estimator, /'estimated'/i)
  assert.match(estimator, /'unpriced'/i)
  assert.match(estimator, /unknown_token_semantics/i)
  assert.doesNotMatch(estimator, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i)

  assert.match(upload, /active_catalog_version/i)
  assert.match(upload, /previous_catalog_version/i)
  assert.match(upload, /status\s+IN\s*\('staging',\s*'reconciled'\)/i)
  assert.match(upload, /array_agg\(DISTINCT target\.catalog_version ORDER BY target\.catalog_version\)/i)
  assert.match(upload, /FOREACH v_catalog_version IN ARRAY v_catalog_versions/i)
  assert.match(upload, /tokend_price_event\(v_evt, v_catalog_version\)/i)
  assert.match(upload, /INSERT INTO public\.tokend_event_cost_revisions/i)
  assert.match(upload, /backfill_run_id[\s\S]{0,900}\bNULL\b/i)
  assert.match(upload, /ON CONFLICT\s*\(version, member_code, event_id\)\s*DO UPDATE/i)
  assert.match(upload, /pricing_status\s*=\s*EXCLUDED\.pricing_status/i)
  assert.match(upload, /tokend_event_cost_revisions\.pricing_status\s*=\s*'unpriced'/i)
}

function testPreflightIsAggregateOnlyWithExactKeys(): void {
  const migration = readUploadMigration()
  const preflight = functionDefinition(migration, 'tokend_pricing_preflight')
  const expectedKeys = [
    'eventCount', 'eligibleEventCount', 'eligibleZeroCostEventCount', 'zeroCostByModel',
    'legacyPriceRowCount', 'statusCounts', 'unpricedEventCount', 'unpricedShare',
    'postSnapshotEventCount', 'membersOver2xCount', 'activeRunStatus',
    'activeReconciliationHash', 'rolloutFixtureCount', 'activeCatalogVersion',
    'activeRunId', 'previousCatalogVersion', 'previousRunId',
  ]
  const topLevelReturn = preflight.match(/RETURN json_build_object\(([\s\S]*?)\n\s*\);\s*\nEND/i)
  assert.ok(topLevelReturn, 'preflight must return one final JSON object')
  for (const key of expectedKeys) {
    assert.equal((topLevelReturn[1].match(new RegExp(`'${key}'`, 'g')) ?? []).length, 1, key)
  }
  assert.match(preflight, /total_tokens\s*>\s*0/i)
  assert.match(preflight, /member_code\s+LIKE\s+'ROLL%'/i)
  assert.match(preflight, />\s*2\s*\*/i)
  assert.match(preflight, /revision\.computed_at\s*>=\s*v_snapshot_at/i)
  assert.match(preflight, /revision\.backfill_run_id\s+IS NULL/i)
  assert.match(preflight, /tokend_pricing_backfill_targets[\s\S]{0,320}NOT EXISTS|NOT EXISTS[\s\S]{0,320}tokend_pricing_backfill_targets/i)
  assert.doesNotMatch(preflight, /usage_event\.timestamp_ms\s*>=/i)
  assert.doesNotMatch(preflight, /json_build_object\([\s\S]*?'(?:memberCode|token|phone|sessionId|eventId)'/i)
}

function testUploadFunctionAclsAreExplicitAndMinimal(): void {
  const migration = readUploadMigration()
  const signatures = [
    'tokend_price_event(JSONB, TEXT)',
    'tokend_upload_events_v2(TEXT, JSONB, JSONB)',
    'tokend_upload_events(TEXT, JSONB, JSONB)',
    'tokend_pricing_preflight()',
  ]
  for (const signature of signatures) {
    assert.match(
      migration,
      new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature.replace(/[()]/g, value => `\\${value}`)} FROM PUBLIC, anon, authenticated, service_role`, 'i'),
    )
  }
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public\.tokend_upload_events_v2\(TEXT, JSONB, JSONB\) TO anon, authenticated/i,
  )
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public\.tokend_upload_events\(TEXT, JSONB, JSONB\) TO anon, authenticated/i,
  )
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public\.tokend_pricing_preflight\(\) TO service_role/i,
  )
  assert.doesNotMatch(migration, /GRANT EXECUTE[^;]*tokend_price_event/i)
  assert.doesNotMatch(migration, /GRANT EXECUTE[^;]*tokend_upload_events[^;]*service_role/i)
}

const RPC_SIGNATURES = [
  ['tokend_get_summary_v5', "p_token TEXT, p_period TEXT DEFAULT '7d', p_timezone TEXT DEFAULT 'Asia/Shanghai'", 'TEXT, TEXT, TEXT'],
  ['tokend_get_daily_trend_v5', "p_token TEXT, p_period TEXT DEFAULT '7d', p_timezone TEXT DEFAULT 'Asia/Shanghai'", 'TEXT, TEXT, TEXT'],
  ['tokend_get_model_breakdown_v3', "p_token TEXT, p_period TEXT DEFAULT '7d'", 'TEXT, TEXT'],
  ['tokend_get_model_detail_v2', "p_token TEXT, p_model TEXT, p_period TEXT DEFAULT '7d'", 'TEXT, TEXT, TEXT'],
  ['tokend_get_channel_breakdown_v4', "p_token TEXT, p_period TEXT DEFAULT '7d'", 'TEXT, TEXT'],
  ['tokend_get_channel_detail_v3', "p_token TEXT, p_channel TEXT, p_period TEXT DEFAULT '7d', p_timezone TEXT DEFAULT 'Asia/Shanghai'", 'TEXT, TEXT, TEXT, TEXT'],
  ['tokend_get_sessions_v2', "p_token TEXT, p_period TEXT DEFAULT '7d', p_limit INTEGER DEFAULT 50", 'TEXT, TEXT, INTEGER'],
  ['tokend_get_session_detail_v2', 'p_token TEXT, p_session_id TEXT', 'TEXT, TEXT'],
  ['tokend_get_top_projects_v3', "p_token TEXT, p_period TEXT DEFAULT '7d'", 'TEXT, TEXT'],
] as const

const AGGREGATE_ENVELOPE_KEYS = [
  'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens',
  'cacheWriteTokens', 'totalTokens', 'inputCost', 'outputCost', 'reasoningCost',
  'cacheReadCost', 'cacheWriteCost', 'unallocatedCost', 'totalCost',
  'eligibleEventCount', 'reportedEventCount', 'estimatedEventCount',
  'zeroRateEventCount', 'legacyEventCount', 'unpricedEventCount',
  'breakdownInvalidCount', 'costAvailability', 'verifiedCostCoverage',
  'coverageStatus', 'costDetailsAvailable',
] as const

function normalizeSqlSignature(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim()
}

function testRpcMigrationDefinesExactSurfaceAndPrivileges(): void {
  const migration = readRpcMigration()
  const definitions = [...migration.matchAll(
    /CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\s*\(([^)]*)\)\s*RETURNS\s+JSON\b/gi,
  )]
  assert.equal(definitions.length, RPC_SIGNATURES.length, '003 must define only the nine vNext RPCs')

  for (const [name, args, aclArgs] of RPC_SIGNATURES) {
    const matches = definitions.filter(match => match[1] === name)
    assert.equal(matches.length, 1, `${name} must have exactly one definition`)
    assert.equal(normalizeSqlSignature(matches[0][2]), normalizeSqlSignature(args), `${name} signature`)

    const body = functionDefinition(migration, name)
    assert.match(body, /RETURNS\s+JSON\b/i)
    assert.match(body, /SECURITY DEFINER/i)
    assert.match(body, /SET search_path\s*=\s*public\s*,\s*pg_temp/i)
    assert.match(body, /public\.tokend_effective_usage_events/i)
    assert.doesNotMatch(body, /(?:FROM|JOIN)\s+public\.tokend_usage_events\b/i)
    for (const key of AGGREGATE_ENVELOPE_KEYS) {
      assert.match(body, new RegExp(`'${key}'\\s*,`, 'i'), `${name} must publish ${key}`)
    }
    assert.match(body, /'costDetailsAvailable'\s*,\s*true/i)
    assert.match(
      migration,
      new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(${aclArgs.replace(/[()]/g, value => `\\${value}`)}\\) FROM PUBLIC, anon, authenticated, service_role`, 'i'),
    )
    assert.match(
      migration,
      new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(${aclArgs.replace(/[()]/g, value => `\\${value}`)}\\) TO anon, authenticated`, 'i'),
    )
  }

  assert.doesNotMatch(migration, /DROP\s+FUNCTION/i)
  assert.equal((migration.match(/CREATE OR REPLACE VIEW public\.tokend_effective_usage_events\b/gi) ?? []).length, 1)
  assert.match(
    migration,
    /REVOKE ALL PRIVILEGES ON TABLE public\.tokend_effective_usage_events FROM PUBLIC, anon, authenticated, service_role/i,
  )
  assert.match(migration.trimEnd(), /NOTIFY pgrst, 'reload schema';$/i)
}

function testEffectiveRelationHasOneAuditablePrecedenceRule(): void {
  const migration = readRpcMigration()
  const view = migration.match(
    /CREATE OR REPLACE VIEW public\.tokend_effective_usage_events[\s\S]*?\nAS\n([\s\S]*?);\n\nREVOKE/i,
  )
  assert.ok(view, 'missing complete effective-cost view')
  const definition = view[1]

  for (const column of [
    'id', 'member_code', 'timestamp_ms', 'session_id', 'session_key', 'agent', 'provider',
    'model', 'channel', 'input_tokens', 'output_tokens', 'reasoning_tokens',
    'cache_read_tokens', 'cache_write_tokens', 'total_tokens', 'stop_reason', 'project',
    'effective_input_cost', 'effective_output_cost', 'effective_reasoning_cost',
    'effective_cache_read_cost', 'effective_cache_write_cost', 'effective_unallocated_cost',
    'effective_total_cost', 'effective_pricing_status', 'effective_pricing_tier',
    'effective_catalog_version', 'effective_breakdown_status', 'effective_backfill_run_id',
    'eligible_for_cost_coverage',
  ]) assert.match(definition, new RegExp(`\\b${column}\\b`, 'i'), column)

  assert.match(definition, /revision\.version\s*=\s*pricing_state\.active_catalog_version/i)
  assert.doesNotMatch(definition, /revision\.backfill_run_id\s*=|backfill_run_id\s*=\s*pricing_state\.active_backfill_run_id/i)

  const precedence = definition.match(/CASE\s+WHEN usage_event\.pricing_status\s*=\s*'reported'[\s\S]*?END\s+AS effective_source/i)
  assert.ok(precedence, 'effective relation must select one source through an explicit precedence CASE')
  const legacyAt = precedence[0].search(/legacy/i)
  const revisionAt = precedence[0].search(/revision\.event_id/i)
  const unpricedAt = precedence[0].lastIndexOf("'unpriced'")
  assert.ok(legacyAt > 0 && revisionAt > legacyAt && unpricedAt > revisionAt)
  assert.match(precedence[0], /usage_event\.(?:total_cost|input_cost|output_cost)/i)
  assert.match(
    definition,
    /WHEN resolved\.effective_breakdown_status\s*=\s*'invalid'\s+THEN 0::NUMERIC/i,
  )
  assert.match(
    definition,
    /WHEN resolved\.effective_breakdown_status\s*=\s*'unallocated'\s+THEN GREATEST\(\s*resolved\.effective_total_cost[\s\S]*?- resolved\.effective_input_cost[\s\S]*?- resolved\.effective_cache_write_cost,\s*0::NUMERIC\s*\)[\s\S]*?ELSE 0::NUMERIC/i,
  )
  assert.match(
    definition,
    /CASE\s+WHEN costed\.effective_source IN \('reported', 'legacy'\)[\s\S]*?GREATEST\(0\.000001::NUMERIC, ABS\(costed\.effective_total_cost\) \* 0\.000001::NUMERIC\)[\s\S]*?ELSE 0::NUMERIC\s+END AS comparison_epsilon/i,
  )
  assert.match(
    definition,
    /effective_component_total > effective_total_cost \+ comparison_epsilon THEN 'invalid'[\s\S]*?effective_total_cost - effective_component_total > comparison_epsilon THEN 'unallocated'[\s\S]*?ELSE 'reconciled'/i,
  )
  assert.doesNotMatch(definition, /selected_unallocated_cost\s*\+/i)
  assert.doesNotMatch(definition, /effective_component_total\s*>\s*effective_total_cost\s+THEN/i)
  assert.doesNotMatch(definition, /effective_cache_read_cost[\s\S]{0,160}(?:total_cost\s*-|-\s*[^\n]*total_cost)/i)
  assert.match(definition, /(?:usage_event|resolved)\.total_tokens\s*>\s*0\s+AS eligible_for_cost_coverage/i)
}

function testRpcAggregationContractIsConsistent(): void {
  const migration = readRpcMigration()
  for (const [name] of RPC_SIGNATURES) {
    const body = functionDefinition(migration, name)
    assert.match(body, /COUNT\(\*\) FILTER \(WHERE eligible_for_cost_coverage\)/i)
    for (const status of ['reported', 'estimated', 'zero_rate', 'legacy', 'unpriced']) {
      assert.match(
        body,
        new RegExp(`COUNT\\(\\*\\) FILTER \\(WHERE eligible_for_cost_coverage AND effective_pricing_status = '${status}'\\)`, 'i'),
      )
    }
    assert.match(body, /SUM\(input_tokens\)[\s\S]*SUM\(output_tokens\)[\s\S]*SUM\(reasoning_tokens\)[\s\S]*SUM\(cache_read_tokens\)[\s\S]*SUM\(cache_write_tokens\)/i)
    assert.match(body, /reported_event_count \+ estimated_event_count \+ zero_rate_event_count \+ legacy_event_count/i)
    assert.match(body, /reported_event_count \+ estimated_event_count \+ zero_rate_event_count/i)
    assert.match(body, /eligible_event_count\s*=\s*0\s+THEN\s+0/i)
    assert.match(body, /LEAST\(1::NUMERIC,\s*GREATEST\(0::NUMERIC/i)
    const statuses = body.match(/CASE\s+WHEN eligible_event_count\s*=\s*0 THEN 'no_usage'[\s\S]*?ELSE 'complete'\s+END/i)
    assert.ok(statuses, `${name} must implement the shared six-state ordering`)
    assert.ok(statuses[0].indexOf("'unpriced'") < statuses[0].indexOf("'zero_rate'"))
    assert.ok(statuses[0].indexOf("'zero_rate'") < statuses[0].indexOf("'partial'"))
    assert.ok(statuses[0].indexOf("'partial'") < statuses[0].indexOf("'legacy'"))
  }
  assert.match(migration, /RETURN json_build_object\('ok', true, 'granularity', v_granularity, 'days',/i)
  assert.match(migration, /RETURN json_build_object\('ok', true, 'models',/i)
  assert.match(migration, /RETURN json_build_object\('ok', true, 'channels',/i)
  assert.match(migration, /RETURN json_build_object\('ok', true, 'sessions',/i)
  assert.match(migration, /RETURN json_build_object\('ok', true, 'projects',/i)
  assert.ok((migration.match(/json_build_object\('ok', false, 'error', 'invalid_token'\)/g) ?? []).length === RPC_SIGNATURES.length)
}

function testSummaryChildrenAndSessionsUseTheFullEnvelopeContract(): void {
  const migration = readRpcMigration()
  const summary = functionDefinition(migration, 'tokend_get_summary_v5')
  const modelDistribution = summary.match(
    /SELECT COALESCE\(jsonb_agg\(jsonb_build_object\(([\s\S]*?)\) ORDER BY total_tokens DESC, model\), '.*?'::JSONB\)\s+INTO v_models/i,
  )
  const topConversations = summary.match(
    /SELECT COALESCE\(jsonb_agg\(jsonb_build_object\(([\s\S]*?)\) ORDER BY total_tokens DESC, total_cost DESC, session_id\), '.*?'::JSONB\)\s+INTO v_conversations/i,
  )
  assert.ok(modelDistribution, 'summary modelDistribution must be an auditable grouped envelope')
  assert.ok(topConversations, 'summary topConversations must be an auditable grouped envelope')
  for (const key of AGGREGATE_ENVELOPE_KEYS) {
    assert.match(modelDistribution[1], new RegExp(`'${key}'\\s*,`, 'i'), `modelDistribution ${key}`)
    assert.match(topConversations[1], new RegExp(`'${key}'\\s*,`, 'i'), `topConversations ${key}`)
  }
  for (const key of ['model', 'tokens']) assert.match(modelDistribution[1], new RegExp(`'${key}'\\s*,`, 'i'))
  for (const key of ['sessionId', 'title', 'channel', 'tokens', 'cost', 'lastAt']) {
    assert.match(topConversations[1], new RegExp(`'${key}'\\s*,`, 'i'))
  }
  assert.match(summary, /limited AS \(SELECT \* FROM envelope ORDER BY total_tokens DESC, model LIMIT 10\)[\s\S]*?INTO v_models/i)
  assert.match(summary, /limited AS \(SELECT \* FROM envelope ORDER BY total_tokens DESC, total_cost DESC, session_id LIMIT 8\)[\s\S]*?INTO v_conversations/i)

  const sessions = functionDefinition(migration, 'tokend_get_sessions_v2')
  assert.match(sessions, /selected_sessions AS\s*\([\s\S]*?timestamp_ms\s*>=\s*v_from_ms/i)
  assert.match(sessions, /FROM public\.tokend_effective_usage_events[\s\S]*?session_id IN \(SELECT session_id FROM selected_sessions\)/i)
  assert.doesNotMatch(sessions, /MAX\((?:session_key|agent|project|channel|model)\)/i)
  for (const column of ['session_key', 'agent', 'project', 'channel', 'model']) {
    assert.match(
      sessions,
      new RegExp(`ARRAY_AGG\\(${column} ORDER BY timestamp_ms DESC, id DESC\\) FILTER \\(WHERE NULLIF\\(${column}, ''\\) IS NOT NULL\\)`, 'i'),
    )
  }

  const detail = functionDefinition(migration, 'tokend_get_session_detail_v2')
  assert.doesNotMatch(detail, /MAX\((?:session_key|agent|project|channel|model)\)/i)
  for (const column of ['session_key', 'agent', 'project', 'channel', 'model']) {
    assert.match(
      detail,
      new RegExp(`ARRAY_AGG\\(${column} ORDER BY timestamp_ms DESC, id DESC\\) FILTER \\(WHERE NULLIF\\(${column}, ''\\) IS NOT NULL\\)`, 'i'),
    )
  }
  assert.match(sessions, /LIMIT LEAST\(GREATEST\(COALESCE\(p_limit, 50\), 0\), 200\)/i)
  assert.match(sessions, /jsonb_agg\([\s\S]*?ORDER BY last_seen_at DESC, session_id/i)
  assert.match(detail, /'totalTokens'\s*,\s*COALESCE\(input_tokens, 0\)::BIGINT\s*\+\s*COALESCE\(output_tokens, 0\)::BIGINT\s*\+\s*COALESCE\(reasoning_tokens, 0\)::BIGINT\s*\+\s*COALESCE\(cache_read_tokens, 0\)::BIGINT\s*\+\s*COALESCE\(cache_write_tokens, 0\)::BIGINT/i)
  assert.match(detail, /jsonb_agg\([\s\S]*?ORDER BY timestamp_ms, id/i)
  const latestMetadataArrays = migration.split('\n').filter(line => /ARRAY_AGG\([^)]*ORDER BY timestamp_ms DESC/i.test(line))
  assert.ok(latestMetadataArrays.length >= 13)
  for (const line of latestMetadataArrays) assert.match(line, /ORDER BY timestamp_ms DESC, id DESC/i)
}

function testSummaryUsesTheV14SingleScanExecutionShape(): void {
  const summary = functionDefinition(readRpcMigration(), 'tokend_get_summary_v5')
  assert.match(summary, /SET statement_timeout\s*=\s*'30s'/i)
  assert.equal(
    (summary.match(/FROM public\.tokend_effective_usage_events\b/gi) ?? []).length,
    1,
    'summary must scan the effective relation only for its temp materialization',
  )
  assert.equal(
    (summary.match(/FROM public\.tokend_message_events\b/gi) ?? []).length,
    1,
    'summary must scan message events once with filtered current/previous counters',
  )
  assert.match(summary, /DROP TABLE IF EXISTS pg_temp\.tokend_summary_effective_events/i)
  assert.doesNotMatch(summary, /DROP TABLE IF EXISTS\s+tokend_summary_effective_events/i)
  assert.match(summary, /CREATE TEMP TABLE tokend_summary_effective_events ON COMMIT DROP AS/i)
  assert.match(summary, /effective_event\.timestamp_ms\s*>=\s*v_previous_from_ms/i)
  assert.doesNotMatch(summary, /v_to_ms|timestamp_ms\s*<=\s*(?:now|v_to)/i)
  assert.match(summary, /timestamp_ms\s*>=\s*v_from_ms\s+AS is_current/i)
  assert.equal((summary.match(/FROM pg_temp\.tokend_summary_effective_events\b/gi) ?? []).length, 5)
  assert.match(summary, /COUNT\(\*\) FILTER \(WHERE message\.kind IN \('user', 'assistant'\) AND message\.timestamp_ms >= v_from_ms\)/i)
  assert.match(summary, /COUNT\(\*\) FILTER \(WHERE message\.kind IN \('user', 'assistant'\) AND message\.timestamp_ms < v_from_ms\)/i)
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
  const planned = Number(pgTap.match(/SELECT plan\((\d+)\);/)?.[1])
  const assertions = (pgTap.match(/^SELECT (?:fk_ok|is|lives_ok|ok|pass|results_eq|throws_ok)\(/gm) ?? []).length
  assert.equal(planned, assertions, 'pgTAP plan must exactly match its assertions')
  assert.equal(
    (pgTap.match(/^\\ir \.\.\/\.\.\/migrations\/202607100001_pricing_core\.sql$/gm) ?? []).length,
    2,
  )
  assert.equal(
    (pgTap.match(/^\\ir \.\.\/\.\.\/migrations\/202607100002_pricing_upload\.sql$/gm) ?? []).length,
    2,
  )
  assert.equal(
    (pgTap.match(/^\\ir \.\.\/\.\.\/migrations\/202607100003_pricing_rpcs\.sql$/gm) ?? []).length,
    2,
  )
  for (const fixture of [
    'tokend_members',
    'tokend_usage_events',
    'tokend_sessions',
    'tokend_sync_state',
    'tokend_model_prices',
    'tokend_message_events',
  ]) assert.match(pgTap, new RegExp(`CREATE TABLE public\\.${fixture}\\b`, 'i'))
  assert.match(pgTap, new RegExp(CATALOG_HASH))
  assert.match(
    pgTap,
    /SELECT fk_ok\([\s\S]*ARRAY\['version', 'model_id'\][\s\S]*tokend_pricing_canonical_models/i,
  )
  assert.doesNotMatch(pgTap, /SELECT has_fk\(/i)
  assert.ok((pgTap.match(/throws_ok\(/g) ?? []).length >= 20)
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
  for (const marker of [
    'effective relation ignores stale catalog revisions',
    'backfill run id remains audit metadata',
    'reported and legacy base costs beat active revisions',
    'zero-token telemetry remains in raw calls and sessions',
    'six coverage statuses follow the exact priority order',
    'mixed coverage is exactly 0.8 available and 0.6 verified',
    'deployed total_tokens alone controls coverage eligibility',
    'summary equals the sum of daily, model, channel, session, and project aggregates',
    'detail aggregates equal their parent rows',
    'all vNext RPCs preserve the invalid-token shape',
    'legacy function OIDs survive the additive RPC migration',
    'vNext signatures, return types, security, search_path, and ACLs are exact',
    'summary v5 preserves v14 visible-session message counts and no-message fallback',
    'reported and legacy effective breakdowns reconcile authoritative totals',
    'summary child lists expose complete envelopes and reconcile on the controlled fixture',
    'cross-window sessions use full history and latest non-empty metadata',
    'sessions period selection and limit remain exact',
    'service_role cannot execute any vNext RPC',
    'invalid timezone falls back to Asia Shanghai across timezone-aware RPCs',
    'REAL base costs use epsilon without inventing invalid or unallocated breakdowns',
    'session detail event token arithmetic widens before summing five buckets',
    'same timestamp metadata resolves by id descending in parent and detail',
    'session limits clamp negative and oversized anonymous requests',
  ]) assert.match(pgTap, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
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
testUploadMigrationDefinesOnlyExactRpcSignatures()
testUploadMigrationValidatesBeforeMutatingAndPreservesBaseRows()
testServerEstimatorAndRevisionContractAreComplete()
testPreflightIsAggregateOnlyWithExactKeys()
testUploadFunctionAclsAreExplicitAndMinimal()
testRpcMigrationDefinesExactSurfaceAndPrivileges()
testEffectiveRelationHasOneAuditablePrecedenceRule()
testRpcAggregationContractIsConsistent()
testSummaryChildrenAndSessionsUseTheFullEnvelopeContract()
testSummaryUsesTheV14SingleScanExecutionShape()
testSupabaseConfigAndPackageScriptsAreIsolated()
testPgTapContractIsSelfContained()
console.log('pricing SQL contract tests passed')
