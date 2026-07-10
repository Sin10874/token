import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const catalog = require('../cli/pricing/catalog.ts')

const {
  CATALOG_HASH,
  CATALOG_VERSION,
  MODEL_ALIASES,
  PRICE_VERSIONS,
} = catalog

const BEGIN_MARKER = '-- BEGIN GENERATED PRICING CATALOG'
const END_MARKER = '-- END GENERATED PRICING CATALOG'
const MIGRATION_URL = new URL('../supabase/migrations/202607100001_pricing_core.sql', import.meta.url)

function compareText(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('SQL numeric literals must be finite')
    return String(value)
  }
  return `'${String(value).replace(/'/g, "''")}'`
}

function renderModelRow(row) {
  const longContext = row.longContext
  const values = [
    row.catalogVersion,
    row.modelId,
    row.provider,
    row.validFrom,
    row.validTo,
    row.standard.input,
    row.standard.output,
    row.standard.cacheRead,
    row.standard.cacheWrite,
    longContext?.input,
    longContext?.output,
    longContext?.cacheRead,
    longContext?.cacheWrite,
    row.longContextThreshold,
    row.sourceCheckedAt,
    row.sourceUrl,
  ]

  return [
    'INSERT INTO pg_temp.tokend_expected_pricing_models (',
    '  version, model_id, provider, valid_from, valid_to,',
    '  standard_input_rate, standard_output_rate,',
    '  standard_cache_read_rate, standard_cache_write_rate,',
    '  long_context_input_rate, long_context_output_rate,',
    '  long_context_cache_read_rate, long_context_cache_write_rate,',
    '  long_context_threshold, source_checked_at, source_url',
    `) VALUES (${values.map(sqlLiteral).join(', ')});`,
  ].join('\n')
}

function renderAliasRow(alias, modelId) {
  return [
    'INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)',
    `VALUES (${sqlLiteral(CATALOG_VERSION)}, ${sqlLiteral(alias)}, ${sqlLiteral(modelId)});`,
  ].join('\n')
}

export function renderCatalogSql() {
  const rows = [...PRICE_VERSIONS].sort((left, right) =>
    compareText(left.modelId, right.modelId) || compareText(left.validFrom, right.validFrom),
  )
  const aliases = Object.entries(MODEL_ALIASES)
    .sort(([left], [right]) => compareText(left, right))
  const catalogSourceCheckedAt = rows
    .map(row => row.sourceCheckedAt)
    .sort(compareText)
    .at(-1)

  return [
    '-- Generated from cli/pricing/catalog.ts. Do not edit by hand.',
    'TRUNCATE TABLE pg_temp.tokend_expected_pricing_models;',
    'TRUNCATE TABLE pg_temp.tokend_expected_pricing_aliases;',
    ...rows.map(renderModelRow),
    ...aliases.map(([alias, modelId]) => renderAliasRow(alias, modelId)),
    `SELECT public.tokend_install_pricing_catalog(${[
      CATALOG_VERSION,
      CATALOG_HASH,
      catalogSourceCheckedAt,
    ].map(sqlLiteral).join(', ')});`,
    '',
  ].join('\n')
}

function markerIndexes(sql, marker) {
  const indexes = []
  let offset = 0
  while (offset <= sql.length) {
    const index = sql.indexOf(marker, offset)
    if (index === -1) break
    indexes.push(index)
    offset = index + marker.length
  }
  return indexes
}

export function replaceGeneratedCatalogBlock(sql) {
  const begins = markerIndexes(sql, BEGIN_MARKER)
  const ends = markerIndexes(sql, END_MARKER)
  if (begins.length !== 1 || ends.length !== 1) {
    throw new Error(`Expected exactly one generated catalog marker pair; found ${begins.length}/${ends.length}`)
  }

  const contentStart = begins[0] + BEGIN_MARKER.length
  const contentEnd = ends[0]
  if (contentStart >= contentEnd) {
    throw new Error('Generated catalog markers are missing content space or appear in the wrong order')
  }

  const existingLeadingEol = sql.slice(contentStart).match(/^(\r\n|\n|\r)/)?.[0]
  const eol = existingLeadingEol ?? (sql.includes('\r\n') ? '\r\n' : '\n')
  const generated = renderCatalogSql().trimEnd().replace(/\n/g, eol)
  return `${sql.slice(0, contentStart)}${eol}${generated}${eol}${sql.slice(contentEnd)}`
}

function runCli() {
  const mode = process.argv[2]
  if (mode !== '--write' && mode !== '--check') {
    throw new Error('Usage: tsx scripts/generate-supabase-pricing.mjs --write|--check')
  }

  const current = fs.readFileSync(MIGRATION_URL, 'utf8')
  const expected = replaceGeneratedCatalogBlock(current)
  if (mode === '--write') {
    fs.writeFileSync(MIGRATION_URL, expected)
    return
  }
  if (expected !== current) {
    console.error('Generated pricing catalog is out of date. Run npm run generate:pricing-sql.')
    process.exitCode = 1
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  runCli()
}
