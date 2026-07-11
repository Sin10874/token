#!/usr/bin/env node

import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto'
import { execFile as nodeExecFile } from 'node:child_process'
import * as nodeFs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const MANAGED_MIGRATION_VERSIONS = Object.freeze([
  '202607100001', '202607100002', '202607100003', '202607100004', '202607100005', '202607100006',
])
export const EMERGENCY_VERSION = '202607109999'
export const RECOVERY_MIN_VERSION = '202607110001'

export const CLIENT_RPC_NAMES = Object.freeze([
  'tokend_get_summary_v5',
  'tokend_get_channel_breakdown_v4',
  'tokend_get_model_breakdown_v3',
  'tokend_get_daily_trend_v5',
  'tokend_get_model_detail_v2',
  'tokend_get_channel_detail_v3',
  'tokend_get_sessions_v2',
  'tokend_get_top_projects_v3',
  'tokend_get_session_detail_v2',
])
export const CLIENT_RPC_SIGNATURES = Object.freeze({
  tokend_get_summary_v5: 'TEXT, TEXT, TEXT',
  tokend_get_channel_breakdown_v4: 'TEXT, TEXT',
  tokend_get_model_breakdown_v3: 'TEXT, TEXT',
  tokend_get_daily_trend_v5: 'TEXT, TEXT, TEXT',
  tokend_get_model_detail_v2: 'TEXT, TEXT, TEXT',
  tokend_get_channel_detail_v3: 'TEXT, TEXT, TEXT, TEXT',
  tokend_get_sessions_v2: 'TEXT, TEXT, INTEGER',
  tokend_get_top_projects_v3: 'TEXT, TEXT',
  tokend_get_session_detail_v2: 'TEXT, TEXT',
})

export const LEGACY_RPC_NAMES = Object.freeze([
  'tokend_get_summary_v4',
  'tokend_get_daily_trend_v4',
  'tokend_get_model_breakdown_v2',
  'tokend_get_model_detail',
  'tokend_get_channel_breakdown_v3',
  'tokend_get_channel_detail_v2',
  'tokend_get_sessions',
  'tokend_get_session_detail',
  'tokend_get_top_projects_v2',
])

export const ADMIN_RPC_NAMES = Object.freeze([
  'tokend_pricing_create_backfill',
  'tokend_pricing_freeze_batch',
  'tokend_pricing_finalize_backfill',
  'tokend_pricing_backfill_batch',
  'tokend_pricing_reconcile',
  'tokend_pricing_activate',
  'tokend_pricing_rollback',
  'tokend_pricing_get_backfill',
  'tokend_pricing_health',
])
export const ADMIN_RPC_SIGNATURES = Object.freeze({
  tokend_pricing_create_backfill: 'TEXT, UUID',
  tokend_pricing_freeze_batch: 'UUID, INTEGER',
  tokend_pricing_finalize_backfill: 'UUID',
  tokend_pricing_backfill_batch: 'UUID, TEXT, TEXT, INTEGER',
  tokend_pricing_reconcile: 'UUID',
  tokend_pricing_activate: 'UUID',
  tokend_pricing_rollback: 'UUID',
  tokend_pricing_get_backfill: 'UUID',
  tokend_pricing_health: '',
})
export const PREFLIGHT_RPC_NAME = 'tokend_pricing_preflight'

const spec = (required, optional = [], numeric = [], array = [], boolean = []) => ({ required, optional, numeric, array, boolean })
export const COMMAND_SPECS = Object.freeze({
  'wrapper-gate': spec(['live-schema', 'rollback-sql', 'state', 'out']),
  'migration-manifest': spec(['files', 'state', 'out'], [], [], ['files']),
  'migration-gate': spec(
    ['migration-list', 'migrations-dir', 'state', 'phase', 'out'],
    ['allow-empty-history'],
    [],
    [],
    ['allow-empty-history'],
  ),
  preflight: spec(['out']),
  'fixture-create': spec(['state']),
  'fixture-reset': spec(['state']),
  'upload-smoke': spec(['state'], ['legacy-only'], [], [], ['legacy-only']),
  sample: spec(['rpc', 'count', 'out'], ['state'], ['count']),
  'compare-samples': spec(
    ['baseline', 'candidate', 'max-error-rate-delta', 'max-p95-multiplier', 'max-p95-seconds'],
    [], ['max-error-rate-delta', 'max-p95-multiplier', 'max-p95-seconds'],
  ),
  'verify-rpcs': spec(['state', 'out']),
  'backfill-create': spec(['catalog', 'state']),
  'backfill-freeze': spec(['state', 'limit'], ['interrupt-after-batches'], ['limit', 'interrupt-after-batches']),
  'backfill-run': spec(['state', 'limit'], ['interrupt-after-batches'], ['limit', 'interrupt-after-batches']),
  'late-fixtures': spec(['state']),
  reconcile: spec(['state', 'out']),
  'activation-rehearsal': spec(['state', 'out']),
  'rollback-active': spec(['state', 'out']),
  'verify-emergency': spec(['state', 'migration-list', 'out']),
  'forward-recover': spec(['state', 'migration-list', 'migrations-dir', 'migration-file', 'post-schema', 'approval', 'out']),
  monitor: spec(
    ['state', 'duration', 'interval', 'late-upload-every', 'global-baseline', 'rpc-baseline', 'out'],
    [], ['duration', 'interval', 'late-upload-every'],
  ),
  cleanup: spec(['state']),
})

const camel = value => value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())

export class ExitCodeError extends Error {
  constructor(message, exitCode = 1, intentional = false) {
    super(message)
    this.name = 'ExitCodeError'
    this.exitCode = exitCode
    this.intentional = intentional
  }
}

function fail(message, exitCode = 1) {
  throw new ExitCodeError(message, exitCode)
}

export function parseCli(argv) {
  const [command, ...tokens] = argv
  const commandSpec = COMMAND_SPECS[command]
  if (!commandSpec) fail(`Unknown subcommand: ${command ?? '<missing>'}`)
  const allowed = new Set([...commandSpec.required, ...commandSpec.optional])
  const options = {}
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index]
    if (!token.startsWith('--')) fail(`Unexpected positional argument for ${command}`)
    const name = token.slice(2)
    if (!allowed.has(name)) fail(`Unknown option --${name} for ${command}`)
    const key = camel(name)
    if (Object.hasOwn(options, key)) fail(`Duplicate option --${name}`)
    if (commandSpec.boolean.includes(name)) {
      options[key] = true
      index += 1
      continue
    }
    if (commandSpec.array.includes(name)) {
      const values = []
      index += 1
      while (index < tokens.length && !tokens[index].startsWith('--')) values.push(tokens[index++])
      if (values.length === 0) fail(`Missing value for --${name}`)
      options[key] = values
      continue
    }
    const value = tokens[index + 1]
    if (value === undefined || value.startsWith('--')) fail(`Missing value for --${name}`)
    options[key] = commandSpec.numeric.includes(name) ? Number(value) : value
    index += 2
  }
  for (const name of commandSpec.required) {
    if (!Object.hasOwn(options, camel(name))) fail(`Missing required option --${name}`)
  }
  for (const name of commandSpec.numeric) {
    const value = options[camel(name)]
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) fail(`--${name} must be a positive number`)
  }
  for (const name of ['count', 'limit', 'interrupt-after-batches', 'duration', 'interval', 'late-upload-every']) {
    const value = options[camel(name)]
    if (value !== undefined && !Number.isSafeInteger(value)) fail(`--${name} must be a positive safe integer`)
  }
  if (command === 'migration-gate' && !['pre', 'post'].includes(options.phase)) {
    fail('--phase must be pre or post')
  }
  if (command === 'migration-gate' && options.allowEmptyHistory === true && options.phase !== 'pre') {
    fail('--allow-empty-history is only valid with --phase pre')
  }
  if (['backfill-freeze', 'backfill-run'].includes(command) && options.limit > 5000) fail('--limit must be at most 5000')
  if (command === 'sample' && options.count > 10000) fail('--count must be at most 10000')
  if (command === 'compare-samples' && options.maxErrorRateDelta > 1) fail('--max-error-rate-delta must be at most 1')
  if (command === 'compare-samples' && options.maxP95Seconds > 2) fail('--max-p95-seconds must be at most 2')
  if (command === 'monitor') {
    if (options.duration > 86400) fail('--duration must be at most 86400')
    if (options.interval > options.duration || options.lateUploadEvery > options.duration) fail('monitor intervals must not exceed duration')
  }
  return { command, options }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function dollarTagAt(sql, index) {
  const match = /^\$(?:[_\p{ID_Start}][_\p{ID_Continue}]*)?\$/u.exec(sql.slice(index))
  return match?.[0] ?? null
}

function scanSql(sql, onStatement) {
  const source = String(sql).replace(/\r\n?/g, '\n')
  let start = 0
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === "'" || char === '"') {
      const quote = char
      index += 1
      while (index < source.length) {
        if (source[index] === quote && source[index + 1] === quote) { index += 2; continue }
        if (source[index] === quote) { index += 1; break }
        if (source[index] === '\\' && quote === "'") { index += 2; continue }
        index += 1
      }
      continue
    }
    if (char === '$') {
      const tag = dollarTagAt(source, index)
      if (tag) {
        const end = source.indexOf(tag, index + tag.length)
        if (end < 0) fail('Unbalanced dollar quote in SQL')
        index = end + tag.length
        continue
      }
    }
    if (char === '-' && next === '-') {
      const end = source.indexOf('\n', index + 2)
      index = end < 0 ? source.length : end + 1
      continue
    }
    if (char === '/' && next === '*') {
      let depth = 1
      index += 2
      while (index < source.length && depth > 0) {
        if (source[index] === '/' && source[index + 1] === '*') { depth += 1; index += 2; continue }
        if (source[index] === '*' && source[index + 1] === '/') { depth -= 1; index += 2; continue }
        index += 1
      }
      if (depth !== 0) fail('Unbalanced block comment in SQL')
      continue
    }
    if (char === ';') {
      onStatement(source.slice(start, index + 1))
      start = index + 1
    }
    index += 1
  }
  if (source.slice(start).trim()) onStatement(source.slice(start))
}

function canonicalizeSql(statement) {
  const source = String(statement).replace(/\r\n?/g, '\n')
  let output = ''
  let pendingSpace = false
  let index = 0
  const append = value => {
    if (pendingSpace && output && !output.endsWith(' ')) output += ' '
    pendingSpace = false
    output += value
  }
  const separateAdjacentQuotedToken = quote => {
    const literalPrefix = quote === "'"
      ? /(?:[EeBbXxNn]|[Uu]&)$/.test(output)
      : /[Uu]&$/.test(output)
    if (!pendingSpace
      && /[A-Za-z0-9_$\u0080-\uFFFF]$/u.test(output)
      && !literalPrefix) pendingSpace = true
  }
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (/\s/.test(char)) { pendingSpace = true; index += 1; continue }
    if (char === '-' && next === '-') {
      const end = source.indexOf('\n', index + 2)
      pendingSpace = true
      index = end < 0 ? source.length : end + 1
      continue
    }
    if (char === '/' && next === '*') {
      let depth = 1
      index += 2
      while (index < source.length && depth > 0) {
        if (source[index] === '/' && source[index + 1] === '*') { depth += 1; index += 2; continue }
        if (source[index] === '*' && source[index + 1] === '/') { depth -= 1; index += 2; continue }
        index += 1
      }
      if (depth !== 0) fail('Unbalanced block comment in SQL')
      pendingSpace = true
      continue
    }
    if (char === "'" || char === '"') {
      separateAdjacentQuotedToken(char)
      const quote = char
      let end = index + 1
      while (end < source.length) {
        if (source[end] === quote && source[end + 1] === quote) { end += 2; continue }
        if (source[end] === quote) { end += 1; break }
        if (source[end] === '\\' && quote === "'") { end += 2; continue }
        end += 1
      }
      append(source.slice(index, end))
      index = end
      continue
    }
    if (char === '$') {
      const tag = dollarTagAt(source, index)
      if (tag) {
        separateAdjacentQuotedToken('$')
        const end = source.indexOf(tag, index + tag.length)
        if (end < 0) fail('Unbalanced dollar quote in SQL')
        const after = end + tag.length
        append(source.slice(index, after))
        index = after
        continue
      }
    }
    append(char)
    index += 1
  }
  return output.trim().replace(/\s*;\s*$/, ';')
}

function splitSqlList(text) {
  const parts = []
  let start = 0
  let depth = 0
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === quote && text[index + 1] === quote) { index += 1; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char === '(' || char === '[') { depth += 1; continue }
    if (char === ')' || char === ']') { depth -= 1; continue }
    if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

const SQL_IDENTIFIER_SOURCE = '(?:"(?:[^"]|"")*"|[A-Za-z_\\u0080-\\uFFFF][A-Za-z0-9_$\\u0080-\\uFFFF]*)'
const SQL_QUALIFIED_IDENTIFIER_SOURCE = `${SQL_IDENTIFIER_SOURCE}(?:\\s*\\.\\s*${SQL_IDENTIFIER_SOURCE})*`
const SQL_TYPE_SOURCE = `${SQL_IDENTIFIER_SOURCE}(?:\\s*\\.\\s*${SQL_IDENTIFIER_SOURCE})?(?:\\s*\\[\\s*\\])*`
const DOLLAR_TAG_SOURCE = '\\$(?:[A-Za-z_\\u0080-\\uFFFF][A-Za-z0-9_\\u0080-\\uFFFF]*)?\\$'

function parseSqlIdentifier(value) {
  const source = value.trim()
  if (source.startsWith('"') && source.endsWith('"')) {
    return { name: source.slice(1, -1).replace(/""/g, '"'), quoted: true }
  }
  return { name: source.toLowerCase(), quoted: false }
}

function splitParameterDefault(parameter) {
  let quote = null
  let depth = 0
  for (let index = 0; index < parameter.length; index += 1) {
    const char = parameter[index]
    if (quote) {
      if (char === quote && parameter[index + 1] === quote) { index += 1; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char === '(' || char === '[') { depth += 1; continue }
    if (char === ')' || char === ']') { depth -= 1; continue }
    if (depth !== 0) continue
    if (char === '=') {
      return { declaration: parameter.slice(0, index).trim(), defaultExpression: parameter.slice(index + 1).trim() }
    }
    const keyword = /^DEFAULT\b/i.exec(parameter.slice(index))
    if (keyword && (index === 0 || /\s/.test(parameter[index - 1]))) {
      return {
        declaration: parameter.slice(0, index).trim(),
        defaultExpression: parameter.slice(index + keyword[0].length).trim(),
      }
    }
  }
  return { declaration: parameter.trim(), defaultExpression: null }
}

function normalizeSqlType(value) {
  const source = value.trim()
  const match = new RegExp(`^(${SQL_IDENTIFIER_SOURCE})(?:\\s*\\.\\s*(${SQL_IDENTIFIER_SOURCE}))?((?:\\s*\\[\\s*\\])*)$`, 'u').exec(source)
  if (!match) return canonicalizeSql(source).replace(/;$/, '')
  const first = parseSqlIdentifier(match[1]).name
  const second = match[2] ? parseSqlIdentifier(match[2]).name : null
  const schema = second ? first : null
  const type = second ?? first
  const dimensions = (match[3].match(/\[/g) ?? []).length
  const qualified = schema && schema !== 'pg_catalog' ? `${schema}.${type}` : type
  return `${qualified}${'[]'.repeat(dimensions)}`
}

function parseSqlParameter(parameter) {
  const { declaration: rawDeclaration, defaultExpression } = splitParameterDefault(parameter)
  let declaration = rawDeclaration
  let mode = 'in'
  const modeMatch = /^(INOUT|IN|OUT|VARIADIC)\b\s*/i.exec(declaration)
  if (modeMatch) {
    mode = modeMatch[1].toLowerCase()
    declaration = declaration.slice(modeMatch[0].length).trim()
  }
  const named = new RegExp(`^(${SQL_IDENTIFIER_SOURCE})\\s+([\\s\\S]+)$`, 'u').exec(declaration)
  return {
    name: named ? parseSqlIdentifier(named[1]).name : null,
    mode,
    type: normalizeSqlType(named ? named[2] : declaration),
    defaultExpression: defaultExpression === null
      ? null
      : canonicalizeSql(defaultExpression).replace(/;$/, ''),
  }
}

function signatureTypes(parameterText) {
  if (!parameterText.trim()) return []
  return splitSqlList(parameterText).map(parameter => parseSqlParameter(parameter).type)
}

function sqlIdentifierPattern(identifier) {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `(?:"${escaped}"|${escaped})`
}

function qualifiedPublicFunctionPattern(name) {
  return `${sqlIdentifierPattern('public')}\\s*\\.\\s*${sqlIdentifierPattern(name)}`
}

function normalizeSqlRole(role) {
  const parsed = parseSqlIdentifier(role)
  if (!parsed.quoted && parsed.name === 'public') return 'PUBLIC'
  if (parsed.quoted && parsed.name.toLowerCase() === 'public') return `"${parsed.name.replace(/"/g, '""')}"`
  return parsed.name
}

const WRAPPER_SIGNATURE = 'public.tokend_upload_events(text,jsonb,jsonb)'
const LEGACY_WRAPPER_GRANTS = ['anon', 'authenticated', 'service_role']
const HARDENED_WRAPPER_GRANTS = ['anon', 'authenticated']
const LEGACY_WRAPPER_ACL_TUPLES = LEGACY_WRAPPER_GRANTS.map(role => `GRANT:${role}`).sort()
const HARDENED_WRAPPER_ACL_TUPLES = [
  'REVOKE:PUBLIC', 'REVOKE:anon', 'REVOKE:authenticated', 'REVOKE:service_role',
  'GRANT:anon', 'GRANT:authenticated',
].sort()
const LEGACY_WRAPPER_RELATIONS = [
  'tokend_members', 'tokend_model_prices', 'tokend_usage_events', 'tokend_sync_state',
]

function normalizeFunctionBody(value) {
  return value.replace(/\r\n?/g, '\n').trim()
}

function normalizeSettingValue(value) {
  return splitSqlList(value).map(rawValue => {
    const item = rawValue.trim()
    if (/^'(?:[^']|'')*'$/.test(item)) return item.slice(1, -1).replace(/''/g, "'")
    if (new RegExp(`^${SQL_IDENTIFIER_SOURCE}$`, 'u').test(item)) return parseSqlIdentifier(item).name
    return canonicalizeSql(item).replace(/;$/, '')
  }).join(',')
}

function parseFunctionSettings(header) {
  const settings = []
  const nextClause = '(?:SET|LANGUAGE|TRANSFORM|WINDOW|IMMUTABLE|STABLE|VOLATILE|LEAKPROOF|NOT\\s+LEAKPROOF|CALLED\\s+ON\\s+NULL\\s+INPUT|RETURNS\\s+NULL\\s+ON\\s+NULL\\s+INPUT|STRICT|EXTERNAL\\s+SECURITY|SECURITY|PARALLEL|COST|ROWS|SUPPORT)'
  const pattern = new RegExp(`\\bSET\\s+(${SQL_QUALIFIED_IDENTIFIER_SOURCE})\\s*(?:FROM\\s+(CURRENT)\\s*|(?:TO\\s+|=\\s*)([\\s\\S]*?))(?=\\s+${nextClause}\\b|$)`, 'giu')
  for (const match of header.matchAll(pattern)) {
    settings.push({
      name: parseQualifiedIdentifier(match[1]),
      value: match[2] ? 'from current' : normalizeSettingValue(match[3]),
    })
  }
  return settings.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function parseQualifiedIdentifier(value) {
  const parts = []
  let start = 0
  let quoted = false
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"') {
      if (quoted && value[index + 1] === '"') { index += 1; continue }
      quoted = !quoted
      continue
    }
    if (!quoted && value[index] === '.') {
      parts.push(value.slice(start, index))
      start = index + 1
    }
  }
  parts.push(value.slice(start))
  return parts.map(part => parseSqlIdentifier(part).name).join('.')
}

function parseFunctionTransforms(header) {
  const transforms = []
  const nextClause = '(?:SET|LANGUAGE|TRANSFORM|WINDOW|IMMUTABLE|STABLE|VOLATILE|LEAKPROOF|NOT\\s+LEAKPROOF|CALLED\\s+ON\\s+NULL\\s+INPUT|RETURNS\\s+NULL\\s+ON\\s+NULL\\s+INPUT|STRICT|EXTERNAL\\s+SECURITY|SECURITY|PARALLEL|COST|ROWS|SUPPORT)'
  const clausePattern = new RegExp(`\\bTRANSFORM\\s+([\\s\\S]*?)(?=\\s+${nextClause}\\b|$)`, 'giu')
  const itemPattern = new RegExp(`^FOR\\s+TYPE\\s+(${SQL_TYPE_SOURCE})$`, 'iu')
  for (const clause of header.matchAll(clausePattern)) {
    const items = splitSqlList(clause[1])
    if (items.length === 0) fail('Exact wrapper transform metadata is incomplete')
    for (const item of items) {
      const parsed = itemPattern.exec(item.trim())
      if (!parsed) fail('Exact wrapper transform metadata is incomplete')
      transforms.push(normalizeSqlType(parsed[1]))
    }
  }
  return transforms.sort()
}

function parseWrapperDefinition(statement, parameterText) {
  const body = new RegExp(`\\bAS\\s+(${DOLLAR_TAG_SOURCE})([\\s\\S]*?)\\1\\s*;?$`, 'iu').exec(statement)
  const header = body ? statement.slice(0, body.index) : statement
  const returnType = new RegExp(`\\bRETURNS\\s+(${SQL_TYPE_SOURCE})`, 'iu').exec(header)
  const language = new RegExp(`\\bLANGUAGE\\s+(${SQL_IDENTIFIER_SOURCE})`, 'iu').exec(header)
  const security = /\bSECURITY\s+(DEFINER|INVOKER)\b/i.exec(header)
  const volatility = /\b(IMMUTABLE|STABLE|VOLATILE)\b/i.exec(header)
  const parallel = /\bPARALLEL\s+(UNSAFE|RESTRICTED|SAFE)\b/i.exec(header)
  const numericClauseGap = '(?:\\s+|(?=[+.-]?(?:[0-9]|\\.[0-9])))'
  const cost = new RegExp(`\\bCOST${numericClauseGap}([^\\s;]+)`, 'iu').exec(header)
  const rows = new RegExp(`\\bROWS${numericClauseGap}([^\\s;]+)`, 'iu').exec(header)
  const support = new RegExp(`\\bSUPPORT\\s+(${SQL_IDENTIFIER_SOURCE}(?:\\s*\\.\\s*${SQL_IDENTIFIER_SOURCE})?)`, 'iu').exec(header)
  if (!returnType || !language || !body) fail('Exact wrapper definition metadata is incomplete')
  const semantic = {
    signature: `public.tokend_upload_events(${signatureTypes(parameterText).join(',')})`,
    parameters: splitSqlList(parameterText).map(parseSqlParameter),
    returnType: normalizeSqlType(returnType[1]),
    language: parseSqlIdentifier(language[1]).name,
    volatility: volatility?.[1].toLowerCase() ?? 'volatile',
    securityDefiner: security?.[1].toUpperCase() === 'DEFINER',
    settings: parseFunctionSettings(header),
    strict: /\bSTRICT\b|\bRETURNS\s+NULL\s+ON\s+NULL\s+INPUT\b/i.test(header),
    leakproof: /\bLEAKPROOF\b/i.test(header) && !/\bNOT\s+LEAKPROOF\b/i.test(header),
    parallel: parallel?.[1].toLowerCase() ?? 'unsafe',
    window: /\bWINDOW\b/i.test(header),
    cost: cost?.[1] ?? null,
    rows: rows?.[1] ?? null,
    support: support ? parseQualifiedIdentifier(support[1]) : null,
    transforms: parseFunctionTransforms(header),
    body: normalizeFunctionBody(body[2]),
  }
  return { semantic, hash: sha256(JSON.stringify(semantic)) }
}

export function extractExactUploadWrapper(sql) {
  const statements = []
  scanSql(sql, statement => statements.push(canonicalizeSql(statement)))
  const wrappers = []
  const aclTuples = []
  let publicExecute = true
  let publicGrantOption = false
  let grantOptionGranted = false
  const namedGrants = new Map()
  const wrapperDrops = []
  const wrapperOwners = []
  const wrapperAclStatements = []
  const defaultFunctionAclStatements = []
  const definitionPattern = new RegExp(`^CREATE(?: OR REPLACE)? FUNCTION\\s+(${SQL_IDENTIFIER_SOURCE})\\s*\\.\\s*(${SQL_IDENTIFIER_SOURCE})\\s*\\(([\\s\\S]*?)\\)\\s*RETURNS\\b`, 'iu')
  const aclPattern = new RegExp(`^(GRANT|REVOKE)\\s+(GRANT\\s+OPTION\\s+FOR\\s+)?(?:ALL(?:\\s+PRIVILEGES)?|EXECUTE)\\s+ON\\s+(?:FUNCTION|ROUTINE)\\s+(${SQL_IDENTIFIER_SOURCE})\\s*\\.\\s*(${SQL_IDENTIFIER_SOURCE})\\s*\\(([^)]*)\\)\\s+(TO|FROM)\\s+([^;]+);?$`, 'iu')
  const alterPattern = new RegExp(`^ALTER\\s+(?:FUNCTION|ROUTINE)\\s+(${SQL_IDENTIFIER_SOURCE})\\s*\\.\\s*(${SQL_IDENTIFIER_SOURCE})\\s*\\(([^)]*)\\)\\s+([\\s\\S]+?);?$`, 'iu')
  const dropPattern = new RegExp(`^DROP\\s+(?:FUNCTION|ROUTINE)\\s+(?:IF\\s+EXISTS\\s+)?(${SQL_IDENTIFIER_SOURCE})\\s*\\.\\s*(${SQL_IDENTIFIER_SOURCE})\\s*\\(([^)]*)\\)(?:\\s+(?:CASCADE|RESTRICT))?;?$`, 'iu')
  const allFunctionsAclPattern = /^(?:GRANT|REVOKE)\b[\s\S]*?\bON\s+ALL\s+(?:FUNCTIONS|ROUTINES)\s+IN\s+SCHEMA\s+([\s\S]*?)\s+(?:TO|FROM)\b/iu
  const defaultFunctionAclPattern = /^ALTER\s+DEFAULT\s+PRIVILEGES\b[\s\S]*?\b(?:GRANT|REVOKE)\b[\s\S]*?\bON\s+(?:FUNCTIONS|ROUTINES)\b/iu
  const defaultAclSchemaPattern = /\bIN\s+SCHEMA\s+([\s\S]*?)\s+(?=GRANT|REVOKE)\b/iu
  const mentionsWrapper = statement => /(?:^|[^A-Za-z0-9_$])(?:"tokend_upload_events"|tokend_upload_events)(?![A-Za-z0-9_$])/i.test(statement)
  const isExactIdentity = (schema, name, parameters) => parseSqlIdentifier(schema).name === 'public'
    && parseSqlIdentifier(name).name === 'tokend_upload_events'
    && signatureTypes(parameters).join(',') === 'text,jsonb,jsonb'
  for (const [statementIndex, statement] of statements.entries()) {
    if (/[Uu]&"/.test(statement)
      && /\b(?:FUNCTION|FUNCTIONS|ROUTINE|ROUTINES)\b/i.test(statement)) {
      fail('Exact wrapper has an unreviewed Unicode-escaped function or ACL mutation')
    }
    if (defaultFunctionAclPattern.test(statement)) {
      const schemaScope = defaultAclSchemaPattern.exec(statement)
      if (!schemaScope || splitSqlList(schemaScope[1]).some(
        schema => parseSqlIdentifier(schema).name === 'public',
      )) {
        defaultFunctionAclStatements.push(statementIndex)
      }
    }
    const schemaAcl = allFunctionsAclPattern.exec(statement)
    if (schemaAcl && splitSqlList(schemaAcl[1]).some(
      schema => parseSqlIdentifier(schema).name === 'public',
    )) {
      fail('Exact wrapper has an unreviewed ACL mutation')
    }
    const header = definitionPattern.exec(statement)
    if (header && isExactIdentity(header[1], header[2], header[3])) {
      wrappers.push({ statement, parameterText: header[3], statementIndex })
    }

    const altered = alterPattern.exec(statement)
    if (altered && isExactIdentity(altered[1], altered[2], altered[3])) {
      const owner = new RegExp(`^OWNER\\s+TO\\s+(${SQL_IDENTIFIER_SOURCE});?$`, 'iu').exec(altered[4])
      if (!owner || parseSqlIdentifier(owner[1]).name !== 'postgres') {
        fail('Exact wrapper has an unreviewed post-create mutation')
      }
      wrapperOwners.push(statementIndex)
    } else if (/^ALTER\s+(?:FUNCTION|ROUTINE)\b/i.test(statement) && mentionsWrapper(statement)) {
      fail('Exact wrapper has an unreviewed post-create mutation')
    }

    const dropped = dropPattern.exec(statement)
    if (dropped && isExactIdentity(dropped[1], dropped[2], dropped[3])) {
      wrapperDrops.push(statementIndex)
    } else if (/^DROP\s+(?:FUNCTION|ROUTINE)\b/i.test(statement) && mentionsWrapper(statement)) {
      fail('Exact wrapper has an unreviewed drop mutation')
    }

    const acl = aclPattern.exec(statement)
    if (acl && isExactIdentity(acl[3], acl[4], acl[5])) {
      wrapperAclStatements.push(statementIndex)
      const action = acl[1].toUpperCase()
      if ((action === 'GRANT' && acl[6].toUpperCase() !== 'TO') || (action === 'REVOKE' && acl[6].toUpperCase() !== 'FROM')) continue
      const grantOptionOnly = action === 'REVOKE' && Boolean(acl[2])
      let roleList = acl[7].trim()
      const withGrantOption = action === 'GRANT' && /\s+WITH\s+GRANT\s+OPTION$/i.test(roleList)
      grantOptionGranted ||= withGrantOption
      if (withGrantOption) roleList = roleList.replace(/\s+WITH\s+GRANT\s+OPTION$/i, '').trim()
      if (action === 'REVOKE') roleList = roleList.replace(/\s+(?:CASCADE|RESTRICT)$/i, '').trim()
      for (const rawRole of splitSqlList(roleList)) {
        const role = normalizeSqlRole(rawRole)
        aclTuples.push(`${grantOptionOnly ? 'REVOKE_GRANT_OPTION' : action}:${role}`)
        if (role === 'PUBLIC') {
          if (action === 'GRANT') {
            publicExecute = true
            publicGrantOption ||= withGrantOption
          } else if (grantOptionOnly) {
            publicGrantOption = false
          } else {
            publicExecute = false
            publicGrantOption = false
          }
        } else if (action === 'GRANT') {
          namedGrants.set(role, Boolean(namedGrants.get(role)) || withGrantOption)
        } else if (grantOptionOnly) {
          if (namedGrants.has(role)) namedGrants.set(role, false)
        } else {
          namedGrants.delete(role)
        }
      }
    } else if (/^(?:GRANT|REVOKE)\b/i.test(statement) && mentionsWrapper(statement)) {
      fail('Exact wrapper has an unreviewed ACL mutation')
    }
  }
  if (wrappers.length === 0) fail('Exact wrapper definition missing')
  if (wrappers.length !== 1) fail('Exact wrapper definition is ambiguous')
  if (wrapperOwners.length > 1 || wrapperOwners.some(index => index < wrappers[0].statementIndex)) {
    fail('Exact wrapper has an unreviewed owner mutation')
  }
  if (wrapperDrops.length > 1 || wrapperDrops.some(index => index > wrappers[0].statementIndex)) {
    fail('Exact wrapper has an unreviewed drop mutation')
  }
  if (wrapperAclStatements.some(index => index < wrappers[0].statementIndex)) {
    fail('Exact wrapper has an unreviewed ACL mutation')
  }
  if (defaultFunctionAclStatements.some(index => index < wrappers[0].statementIndex)) {
    fail('Exact wrapper has an unreviewed default ACL mutation')
  }
  const definition = wrappers[0].statement
  const parsed = parseWrapperDefinition(definition, wrappers[0].parameterText)
  const exactNamedGrants = [...namedGrants.entries()]
    .map(([role, grantOption]) => ({ role, grantOption }))
    .sort((left, right) => left.role.localeCompare(right.role))
  const effectiveNamedGrants = publicExecute
    ? (publicGrantOption ? [] : exactNamedGrants.filter(grant => grant.grantOption))
    : exactNamedGrants
  const effectiveAcl = { publicExecute, publicGrantOption, namedGrants: effectiveNamedGrants }
  return {
    signature: WRAPPER_SIGNATURE,
    definition,
    semantic: parsed.semantic,
    hash: parsed.hash,
    aclTuples: aclTuples.sort(),
    namedGrants: exactNamedGrants,
    grantOptionGranted,
    effectiveAcl,
    aclHash: sha256(JSON.stringify(effectiveAcl)),
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function qualifyLegacyWrapperRelations(body) {
  const relationPattern = LEGACY_WRAPPER_RELATIONS.join('|')
  return body.replace(
    new RegExp(`(?<![A-Za-z0-9_$".])(${relationPattern})\\b`, 'g'),
    'public.$1',
  )
}

function isKnownLegacyHardeningDefinition(live, reviewed) {
  if (!sameJson(live.semantic.settings, [])) return false
  const expected = {
    ...live.semantic,
    settings: [{ name: 'search_path', value: 'public,pg_temp' }],
    body: qualifyLegacyWrapperRelations(live.semantic.body),
  }
  return sameJson(reviewed.semantic, expected)
}

function hasExactNamedGrants(wrapper, roles) {
  return sameJson(
    wrapper.namedGrants,
    [...roles].sort().map(role => ({ role, grantOption: false })),
  )
}

function hasKnownLegacyAcl(wrapper) {
  return wrapper.effectiveAcl.publicExecute
    && !wrapper.effectiveAcl.publicGrantOption
    && sameJson(wrapper.aclTuples, LEGACY_WRAPPER_ACL_TUPLES)
    && hasExactNamedGrants(wrapper, LEGACY_WRAPPER_GRANTS)
}

function hasHardenedAcl(wrapper) {
  return !wrapper.effectiveAcl.publicExecute
    && !wrapper.effectiveAcl.publicGrantOption
    && sameJson(wrapper.aclTuples, HARDENED_WRAPPER_ACL_TUPLES)
    && hasExactNamedGrants(wrapper, HARDENED_WRAPPER_GRANTS)
}

function hasNoUnexpectedAclExpansion(wrapper) {
  const allowed = new Set(['PUBLIC', ...LEGACY_WRAPPER_GRANTS])
  return !wrapper.grantOptionGranted
    && !wrapper.effectiveAcl.publicGrantOption
    && wrapper.namedGrants.every(grant => allowed.has(grant.role) && !grant.grantOption)
    && wrapper.aclTuples.every(tuple => allowed.has(tuple.slice(tuple.indexOf(':') + 1)))
}

function wrapperRoleNames(wrapper) {
  return wrapper.effectiveAcl.publicExecute
    ? ['PUBLIC', ...wrapper.effectiveAcl.namedGrants.map(grant => grant.role)]
    : wrapper.effectiveAcl.namedGrants.map(grant => grant.role)
}

export function compareWrapperDefinitions(liveSql, reviewedSql) {
  const live = extractExactUploadWrapper(liveSql)
  const reviewed = extractExactUploadWrapper(reviewedSql)
  if (!hasNoUnexpectedAclExpansion(live) || !hasNoUnexpectedAclExpansion(reviewed)) {
    fail('Wrapper ACL mismatch')
  }
  if (live.hash === reviewed.hash) {
    if (live.aclHash !== reviewed.aclHash) fail('Wrapper ACL mismatch')
    return {
      wrapperGatePassed: true,
      securityHardeningApplied: false,
      wrapperHash: live.hash,
      aclHash: live.aclHash,
      roleNames: wrapperRoleNames(live),
    }
  }
  if (!isKnownLegacyHardeningDefinition(live, reviewed)) fail('Wrapper definition hash mismatch')
  if (!hasKnownLegacyAcl(live) || !hasHardenedAcl(reviewed)) {
    fail('Wrapper security hardening ACL mismatch')
  }
  return {
    wrapperGatePassed: true,
    securityHardeningApplied: true,
    wrapperHash: reviewed.hash,
    aclHash: reviewed.aclHash,
    roleNames: wrapperRoleNames(reviewed),
  }
}

const sensitiveKey = key => /(?:secret|prompt|payload|^raw|provider.*url|run.*ids?$)|^(?:authorization|apiKey|apikey|serviceKey|anonKey|token|memberToken|memberCode|memberId|eventId|sessionId|cursorMember|cursorEvent|nextMember|nextEvent|body|id|ids|members?|events?|sessions?|fixtures?|(?:member|event|session|fixture)Ids)$/i.test(key)

export function sanitizeForOutput(value) {
  if (Array.isArray(value)) return value.map(sanitizeForOutput).filter(child => child !== undefined)
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) return undefined
  if (!value || typeof value !== 'object') return value
  const clean = {}
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKey(key)) continue
    const sanitized = sanitizeForOutput(child)
    if (sanitized === undefined) continue
    if (sanitized && !Array.isArray(sanitized) && typeof sanitized === 'object' && Object.keys(sanitized).length === 0) continue
    clean[key] = sanitized
  }
  return clean
}

export async function atomicWriteJson(file, value, adapters = {}) {
  const fs = adapters.fs ?? nodeFs
  const uuid = (adapters.randomUUID ?? nodeRandomUUID)()
  const temporary = `${file}.${uuid}.tmp`
  let handle
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporary, file)
    await fs.chmod(file, 0o600)
  } catch (_error) {
    try { await handle?.close() } catch {}
    try { await fs.unlink(temporary) } catch {}
    fail('Atomic state write failed')
  }
}

async function readJson(file, fs = nodeFs) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

const mutationCommands = new Set([
  'fixture-create', 'fixture-reset', 'upload-smoke', 'backfill-create', 'backfill-freeze', 'backfill-run',
  'late-fixtures', 'reconcile', 'activation-rehearsal', 'rollback-active', 'monitor',
])
const stickyAllowed = new Set(['verify-emergency', 'forward-recover', 'cleanup'])

export function assertCommandAllowed(state, command) {
  if (mutationCommands.has(command) && state.wrapperGatePassed !== true) fail('Wrapper gate is required before mutation')
  if (state.forwardRecoveryRequired === true && !stickyAllowed.has(command)) fail('Forward recovery required; ordinary mutation is blocked')
}

function migrationVersion(file) {
  const match = /^(\d{12,14})_[^/]+\.sql$/i.exec(path.basename(file))
  if (!match) fail(`Migration filename lacks a version: ${path.basename(file)}`)
  return match[1]
}

export async function createMigrationManifest(files, adapters = {}) {
  const fs = adapters.fs ?? nodeFs
  const paths = new Set()
  const versions = new Set()
  const entries = []
  for (const file of files) {
    const resolved = path.resolve(file)
    if (paths.has(resolved)) fail(`Duplicate path in migration manifest: ${file}`)
    paths.add(resolved)
    const version = migrationVersion(file)
    if (versions.has(version)) fail(`Duplicate version in migration manifest: ${version}`)
    versions.add(version)
    const content = await fs.readFile(file)
    entries.push({ version, path: path.basename(file), hash: sha256(content) })
  }
  entries.sort((left, right) => left.version.localeCompare(right.version) || left.path.localeCompare(right.path))
  const migrationHashes = Object.fromEntries(entries.map(entry => [entry.version, entry.hash]))
  return { entries, migrationHashes, manifestHash: sha256(JSON.stringify(entries)) }
}

export function mergeMigrationManifestState(state, manifest) {
  const plannedMigrationHashes = { ...(state.plannedMigrationHashes ?? {}) }
  const plannedMigrationPaths = { ...(state.plannedMigrationPaths ?? {}) }
  for (const entry of manifest.entries) {
    if (plannedMigrationHashes[entry.version] && plannedMigrationHashes[entry.version] !== entry.hash) {
      fail(`Planned migration hash cannot be replaced for ${entry.version}`)
    }
    if (plannedMigrationPaths[entry.version] && plannedMigrationPaths[entry.version] !== entry.path) {
      fail(`Planned migration path cannot be replaced for ${entry.version}`)
    }
    plannedMigrationHashes[entry.version] = entry.hash
    plannedMigrationPaths[entry.version] = entry.path
  }
  const mergedEntries = Object.entries(plannedMigrationHashes).sort(([left], [right]) => left.localeCompare(right))
  return {
    ...state,
    plannedMigrationHashes,
    plannedMigrationPaths,
    manifestHash: sha256(JSON.stringify(mergedEntries)),
    manifestHistory: [...(state.manifestHistory ?? []), {
      manifestHash: manifest.manifestHash,
      versions: manifest.entries.map(entry => entry.version),
    }],
  }
}

function isEmptySupabasePrettyMigrationList(text) {
  const lines = String(text).split(/\r?\n/)
  let first = 0
  while (first < lines.length && lines[first].trim() === '') first += 1
  let last = lines.length - 1
  while (last >= first && lines[last].trim() === '') last -= 1
  const body = lines.slice(first, last + 1)
  return body.length === 2
    && /^\s*Local\s*\|\s*Remote\s*\|\s*Time\s+\(UTC\)\s*$/.test(body[0])
    && /^\s*-{3,}\s*\|\s*-{3,}\s*\|\s*-{3,}\s*$/.test(body[1])
}

export function parseMigrationList(text, { allowEmptyHistory = false } = {}) {
  const rows = []
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.includes('|') || /^\s*(?:Local|-)/i.test(line)) continue
    const [local = '', remote = ''] = line.split('|').map(part => part.trim())
    if (!local && !remote) continue
    if ((local && !/^\d{12,14}$/.test(local)) || (remote && !/^\d{12,14}$/.test(remote))) fail('Migration list contains an invalid local/remote row')
    rows.push({ local, remote })
  }
  if (rows.length > 0) {
    if (allowEmptyHistory) fail('--allow-empty-history requires an empty migration history')
    return rows
  }
  if (!allowEmptyHistory) fail('Migration list contains no version rows')
  if (!isEmptySupabasePrettyMigrationList(text)) {
    fail('Empty migration history requires an exact Supabase pretty header')
  }
  return rows
}

async function filesByVersion(directory, fs) {
  const result = new Map()
  for (const name of await fs.readdir(directory)) {
    if (!/^\d{12,14}_.+\.sql$/i.test(name)) continue
    const version = migrationVersion(name)
    if (result.has(version)) fail(`Duplicate version in migrations directory: ${version}`)
    result.set(version, path.join(directory, name))
  }
  return result
}

function exactVersionList(actual, expected) {
  return actual.length === expected.length && actual.every((version, index) => version === expected[index])
}

function orderedBoundVersions(state) {
  const applied = state.appliedMigrationHashes ?? {}
  const keys = Object.keys(applied)
  const allowed = new Set([...MANAGED_MIGRATION_VERSIONS, EMERGENCY_VERSION])
  const recovery = keys.filter(version => version >= RECOVERY_MIN_VERSION).sort()
  for (const version of recovery) allowed.add(version)
  for (const version of keys) if (!allowed.has(version)) fail(`Unexpected bound migration ${version}`)
  const managed = MANAGED_MIGRATION_VERSIONS.filter(version => Object.hasOwn(applied, version))
  if (!exactVersionList(managed, MANAGED_MIGRATION_VERSIONS.slice(0, managed.length))) {
    fail('Bound migrations violate production order')
  }
  if (Object.hasOwn(applied, EMERGENCY_VERSION) && managed.length !== MANAGED_MIGRATION_VERSIONS.length) {
    fail('Emergency migration cannot precede all managed migrations')
  }
  if (recovery.length > 0 && !Object.hasOwn(applied, EMERGENCY_VERSION)) fail('Recovery migration requires bound emergency migration')
  if (recovery.length > 1) fail('Only one reviewed recovery migration may be bound')
  return [...managed, ...(Object.hasOwn(applied, EMERGENCY_VERSION) ? [EMERGENCY_VERSION] : []), ...recovery]
}

function expectedNextMigration(bound, candidate) {
  if (bound.length < MANAGED_MIGRATION_VERSIONS.length) return MANAGED_MIGRATION_VERSIONS[bound.length]
  if (!bound.includes(EMERGENCY_VERSION)) return EMERGENCY_VERSION
  if (!bound.some(version => version >= RECOVERY_MIN_VERSION)) {
    if (candidate >= RECOVERY_MIN_VERSION) return candidate
    return RECOVERY_MIN_VERSION
  }
  return null
}

function hasMatchingPostBinding(state, version) {
  const hash = state.appliedMigrationHashes?.[version]
  if (!hash) return false
  const bindingHash = sha256(`${version}:${hash}`)
  return (state.migrationGateHistory ?? []).some(entry =>
    entry.phase === 'post' && entry.version === version && entry.hash === hash && entry.bindingHash === bindingHash)
}

export async function validateMigrationGate({
  state,
  migrationList,
  migrationsDir,
  phase,
  allowEmptyHistory = false,
  fs = nodeFs,
  now = () => new Date().toISOString(),
}) {
  if (!['pre', 'post'].includes(phase)) fail('Migration gate phase must be pre or post')
  if (allowEmptyHistory && phase !== 'pre') fail('--allow-empty-history is only valid with phase pre')
  const rows = parseMigrationList(migrationList, { allowEmptyHistory })
  for (const row of rows) {
    if (!row.local || !row.remote || row.local !== row.remote) fail(`Migration local/remote mismatch at ${row.local || row.remote}`)
  }
  const listed = rows.map(row => row.local)
  if (new Set(listed).size !== listed.length) fail('Migration list contains duplicate versions')
  const history = [...(state.migrationGateHistory ?? [])]
  if (phase === 'pre') {
    if (!Array.isArray(state.migrationBaselineVersions)) {
      if (allowEmptyHistory && orderedBoundVersions(state).length > 0) {
        fail('Bound migrations cannot establish an empty migration baseline')
      }
      const contaminated = listed.find(version =>
        MANAGED_MIGRATION_VERSIONS.includes(version) || version === EMERGENCY_VERSION || version >= RECOVERY_MIN_VERSION)
      if (contaminated) fail(`Emergency, managed, or recovery rollout version ${contaminated} cannot be part of the initial baseline`)
      const historyHash = sha256(JSON.stringify(listed))
      history.push({
        phase: 'pre',
        versions: listed,
        historyHash,
        ...(allowEmptyHistory ? { emptyHistoryAccepted: true } : {}),
        timestamp: now(),
      })
      return {
        ...state,
        migrationBaselineVersions: listed,
        migrationBaselineHash: historyHash,
        ...(allowEmptyHistory ? { emptyHistoryAccepted: true } : {}),
        migrationGateHistory: history,
        transition: 'migrations-consistent',
      }
    }
    const bound = orderedBoundVersions(state)
    const expected = [...state.migrationBaselineVersions, ...bound]
    if (!exactVersionList(listed, expected)) fail('Pre migration history must equal the original baseline plus bound migrations')
    return { ...state, transition: state.forwardRecoveryRequired ? 'forward-required' : 'migrations-consistent' }
  }
  const baseline = state.migrationBaselineVersions
  if (!Array.isArray(baseline)) fail('Post migration gate requires a recorded pre baseline')
  const bound = orderedBoundVersions(state)
  const prefix = [...baseline, ...bound]
  if (!exactVersionList(listed.slice(0, prefix.length), prefix)) fail('Post migration history lost or changed the baseline plus bound migrations')
  const additions = listed.slice(prefix.length)
  if (additions.length > 1) fail('Post migration gate binds exactly one migration at a time')
  if (listed.length < prefix.length) fail('Post migration history lost a baseline or bound migration')
  if (additions.length === 0 && bound.length === 0) fail('Post migration gate must add exactly one migration unless a matching post binding already exists')
  if (additions.length === 1) {
    const expected = expectedNextMigration(bound, additions[0])
    if (expected === null || additions[0] !== expected) fail(`Migration violates production order; expected ${expected ?? 'no further migration'}`)
  }
  const staged = await filesByVersion(migrationsDir, fs)
  const appliedMigrationHashes = { ...(state.appliedMigrationHashes ?? {}) }
  const rolloutVersions = [...bound, ...additions]
  for (const version of rolloutVersions) {
    const planned = state.plannedMigrationHashes?.[version]
    if (!planned) fail(`Migration ${version} was not preplanned in a manifest`)
    const file = staged.get(version)
    if (!file) fail(`Staged migration file missing for ${version}`)
    if (state.plannedMigrationPaths?.[version] && path.basename(file) !== state.plannedMigrationPaths[version]) {
      fail(`Staged migration path mismatch for ${version}`)
    }
    const hash = sha256(await fs.readFile(file))
    if (hash !== planned) fail(`Planned hash mismatch for migration ${version}`)
    const previouslyApplied = appliedMigrationHashes[version]
    if (previouslyApplied && previouslyApplied !== hash) {
      fail(`Applied hash is immutable for migration ${version}`)
    }
    appliedMigrationHashes[version] = hash
    if (!previouslyApplied) {
      history.push({
        phase: 'post',
        version,
        hash,
        bindingHash: sha256(`${version}:${hash}`),
        timestamp: now(),
      })
    }
  }
  for (const version of bound) {
    if (!hasMatchingPostBinding(state, version)) fail(`Migration ${version} is missing a matching post binding`)
  }
  const sticky = state.forwardRecoveryRequired === true || Object.hasOwn(appliedMigrationHashes, EMERGENCY_VERSION)
  return {
    ...state,
    appliedMigrationHashes,
    migrationGateHistory: history,
    forwardRecoveryRequired: sticky || undefined,
    transition: sticky ? 'forward-required' : 'migrations-consistent',
  }
}

function sameSet(actual, expected) {
  return JSON.stringify([...new Set(actual)].sort()) === JSON.stringify([...new Set(expected)].sort())
}

export function validateEmergencySurface({ state, migrationList, surface, now = () => new Date().toISOString() }) {
  const rows = parseMigrationList(migrationList)
  if (!rows.some(row => row.local === EMERGENCY_VERSION && row.remote === EMERGENCY_VERSION)) fail('999 emergency migration must be present in history')
  if (!state.appliedMigrationHashes?.[EMERGENCY_VERSION]) fail('999 emergency migration must have an applied hash')
  if (!surface.legacyWrapperPresent || !sameSet(surface.legacyRpcNames ?? [], LEGACY_RPC_NAMES)) fail('Legacy wrapper and RPC surface must remain present')
  if (!surface.legacyWrapperAllowed || !sameSet(surface.legacyAllowedRpcNames ?? [], LEGACY_RPC_NAMES)) {
    fail('Legacy wrapper and all legacy RPCs must remain allowed')
  }
  if (surface.v2UploadPresent || (surface.vNextRpcNames?.length ?? 0) > 0 || (surface.adminRpcNames?.length ?? 0) > 0) {
    fail('vNext, v2, and admin RPCs must be absent after emergency rollback')
  }
  return {
    ...state,
    emergencyVerified: true,
    emergencyVerifiedAt: now(),
    forwardRecoveryRequired: true,
    transition: 'emergency-verified',
  }
}

function validateReviewedPostSchema(sql) {
  const statements = []
  scanSql(sql, statement => statements.push(canonicalizeSql(statement)))
  const signatures = {
    tokend_upload_events_v2: 'TEXT, JSONB, JSONB',
    [PREFLIGHT_RPC_NAME]: '',
    ...ADMIN_RPC_SIGNATURES,
    ...CLIENT_RPC_SIGNATURES,
  }
  const surfaceNames = Object.keys(signatures)
  const surfaceRecords = []
  for (const name of surfaceNames) {
    const qualified = qualifiedPublicFunctionPattern(name)
    const definitions = statements.filter(statement => new RegExp(`^CREATE(?: OR REPLACE)? FUNCTION\\s+${qualified}\\s*\\(`, 'i').test(statement))
    if (definitions.length !== 1 || !/\bSECURITY DEFINER\b/i.test(definitions[0])
      || !/\bSET\s+(?:"search_path"|search_path)\s+(?:=|TO)\s+(?:"public"|'public'|public)\s*,\s*(?:"pg_temp"|'pg_temp'|pg_temp)(?:\s|$)/i.test(definitions[0])) {
      fail(`Post schema is missing exact security/search_path for ${name}`)
    }
    const header = new RegExp(`^CREATE(?: OR REPLACE)? FUNCTION\\s+${qualified}\\s*\\(([\\s\\S]*?)\\)\\s*RETURNS`, 'i').exec(definitions[0])
    const actualTypes = header?.[1].trim() ? signatureTypes(header[1]).join(',') : ''
    const expectedTypes = signatures[name].trim() ? signatureTypes(signatures[name]).join(',') : ''
    if (actualTypes !== expectedTypes) fail(`Post schema signature mismatch for ${name}`)
    const grants = []
    for (const statement of statements) {
      const match = new RegExp(`^GRANT\\s+(?:EXECUTE|ALL(?:\\s+PRIVILEGES)?)\\s+ON\\s+FUNCTION\\s+${qualified}\\s*\\(([^)]*)\\)\\s+TO\\s+([^;]+);?$`, 'i').exec(statement)
      if (match) {
        const aclTypes = match[1].trim() ? signatureTypes(match[1]).join(',') : ''
        if (aclTypes !== expectedTypes) fail(`Post schema grant signature mismatch for ${name}`)
        grants.push(...splitSqlList(match[2]).map(normalizeSqlRole))
      }
    }
    const expected = ADMIN_RPC_NAMES.includes(name) || name === PREFLIGHT_RPC_NAME ? ['service_role'] : ['anon', 'authenticated']
    if (!sameSet(grants, expected)) fail(`Post schema grant mismatch for ${name}`)
    const revokedRoles = []
    for (const statement of statements) {
      const match = new RegExp(`^REVOKE\\s+(?:EXECUTE|ALL(?:\\s+PRIVILEGES)?)\\s+ON\\s+FUNCTION\\s+${qualified}\\s*\\(([^)]*)\\)\\s+FROM\\s+([^;]+);?$`, 'i').exec(statement)
      if (!match) continue
      const aclTypes = match[1].trim() ? signatureTypes(match[1]).join(',') : ''
      if (aclTypes !== expectedTypes) fail(`Post schema revoke signature mismatch for ${name}`)
      revokedRoles.push(...splitSqlList(match[2]).map(normalizeSqlRole))
    }
    if (!revokedRoles.includes('PUBLIC')) fail(`Post schema PUBLIC grant revocation is missing for ${name}`)
    surfaceRecords.push({
      name,
      signature: actualTypes,
      definition: definitions[0].replace(/^CREATE OR REPLACE FUNCTION/i, 'CREATE FUNCTION'),
      grants: [...new Set(grants)].sort(),
      revokes: ['PUBLIC'],
    })
  }
  return {
    securityDefinerNames: surfaceNames,
    searchPathNames: surfaceNames,
    surfaceHash: sha256(JSON.stringify(surfaceRecords.sort((left, right) => binaryTextCompare(left.name, right.name)))),
  }
}

function validateLinkedPostSchema(postSchema, livePostSchema) {
  const reviewedSchema = validateReviewedPostSchema(postSchema)
  const linkedLiveSchema = validateReviewedPostSchema(livePostSchema)
  if (linkedLiveSchema.surfaceHash !== reviewedSchema.surfaceHash) fail('Linked live schema differs from reviewed post schema')
  return { reviewedSchema, linkedLiveSchema }
}

function validateRecoveredLiveSurface(surface) {
  const all = ['tokend_upload_events_v2', PREFLIGHT_RPC_NAME, ...ADMIN_RPC_NAMES, ...CLIENT_RPC_NAMES]
  if (!surface.legacyWrapperPresent || !surface.v2UploadPresent) fail('Live legacy wrapper and v2 upload must both be present')
  if (!sameSet(surface.clientRpcNames ?? [], CLIENT_RPC_NAMES) || !sameSet(surface.adminRpcNames ?? [], ADMIN_RPC_NAMES)) fail('Live RPC equality failed')
  if (!sameSet(surface.securityDefinerNames ?? [], all) || !sameSet(surface.searchPathNames ?? [], all)) fail('Live RPC security/search_path mismatch')
  if (!sameSet(surface.anonExecuteNames ?? [], ['tokend_upload_events_v2', ...CLIENT_RPC_NAMES]) || !sameSet(surface.serviceExecuteNames ?? [], [PREFLIGHT_RPC_NAME, ...ADMIN_RPC_NAMES])) {
    fail('Live RPC grants mismatch')
  }
}

export async function validateForwardRecovery({
  state, migrationList, migrationsDir, migrationFile, approval, postSchema, livePostSchema, liveSurface,
  fs = nodeFs, now = () => new Date().toISOString(),
}) {
  if (state.forwardRecoveryRequired !== true) fail('Forward recovery is not currently required')
  if (state.emergencyVerified !== true) fail('Emergency verification must complete first')
  const rows = parseMigrationList(migrationList)
  const versions = rows.map(row => {
    if (row.local !== row.remote) fail('Recovery migration local/remote mismatch')
    return row.local
  })
  for (const version of MANAGED_MIGRATION_VERSIONS) if (!versions.includes(version)) fail('Recovery history must retain all managed migrations')
  if (!versions.includes(EMERGENCY_VERSION)) fail('999 emergency migration must remain in recovery history')
  if (!state.appliedMigrationHashes?.[EMERGENCY_VERSION]) fail('999 emergency migration must retain its applied hash')
  const version = migrationVersion(migrationFile)
  if (version < RECOVERY_MIN_VERSION) fail(`Recovery version must be at least ${RECOVERY_MIN_VERSION}`)
  if (!versions.includes(version)) fail('Recovery version must be present in local and remote history')
  const recoveryVersions = versions.filter(candidate => candidate >= RECOVERY_MIN_VERSION)
  if (recoveryVersions.length !== 1 || recoveryVersions[0] !== version) fail('Recovery history must identify exactly one reviewed recovery version')
  const relative = path.relative(path.resolve(migrationsDir), path.resolve(migrationFile))
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('Recovery migration file must be staged in the migrations directory')
  const staged = await filesByVersion(migrationsDir, fs)
  if (path.resolve(staged.get(version) ?? '') !== path.resolve(migrationFile)) fail('Recovery migration file is not the exact staged version')
  const hash = sha256(await fs.readFile(migrationFile))
  if (state.plannedMigrationHashes?.[version] !== hash) fail('Recovery planned hash mismatch')
  if (state.appliedMigrationHashes?.[version] !== hash) fail('Recovery applied hash mismatch')
  if (approval?.version !== version || approval?.migrationHash !== hash) fail('Recovery approval hash/version mismatch')
  if (approval.specReview !== 'Approved') fail('specReview must be Approved')
  if (approval.qualityReview !== 'Approved') fail('qualityReview must be Approved')
  const bindingHash = sha256(`${version}:${hash}`)
  const postGate = (state.migrationGateHistory ?? []).some(entry =>
    entry.phase === 'post' && entry.version === version && entry.hash === hash && entry.bindingHash === bindingHash)
  if (!postGate) fail('Matching post migration gate binding is required')
  const { linkedLiveSchema } = validateLinkedPostSchema(postSchema, livePostSchema)
  validateRecoveredLiveSurface(liveSurface)
  return {
    ...state,
    forwardRecoveryRequired: false,
    recoveryVersion: version,
    recoveryHash: hash,
    livePostSchemaHash: linkedLiveSchema.surfaceHash,
    livePostSchemaSource: 'supabase-db-dump-linked',
    livePostSchemaRecoveryBinding: sha256(`${version}:${hash}:${linkedLiveSchema.surfaceHash}`),
    recoveryTime: now(),
    transition: 'newly-reviewed-forward-recovered',
  }
}

async function productionDumpLinkedSchema() {
  return new Promise((resolve, reject) => {
    nodeExecFile('supabase', ['db', 'dump', '--linked', '--schema', 'public'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        reject(new ExitCodeError('Linked production schema dump failed'))
        return
      }
      resolve(stdout)
    })
  })
}

export async function fetchAllPages({ fetch: fetchImpl, url, headers = {}, pageSize = 1000 }) {
  const rows = []
  let from = 0
  let knownTotal = null
  while (true) {
    const requestedEnd = knownTotal === null ? from + pageSize - 1 : Math.min(from + pageSize - 1, knownTotal - 1)
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { ...headers, Range: `${from}-${requestedEnd}`, 'Range-Unit': 'items', Prefer: 'count=exact' },
    })
    if (!response.ok) fail(`HTTP request failed with status ${response.status}`)
    let page
    try { page = await response.json() } catch { fail('HTTP response was not valid JSON') }
    if (!Array.isArray(page)) fail('Paginated HTTP response must be an array')
    rows.push(...page)
    const contentRange = response.headers.get('content-range')
    const range = /^(\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange ?? '')
    if (!range) {
      if (page.length < pageSize) break
      fail('Paginated response is missing Content-Range')
    }
    const end = Number(range[2])
    const total = range[3] === '*' ? null : Number(range[3])
    if (total !== null) knownTotal = total
    if (total !== null && end + 1 >= total) break
    if (page.length === 0) fail('Pagination made no progress')
    from = end + 1
  }
  return rows
}

const LEGACY_PREFLIGHT_SAMPLE_SIZE = 256
const LEGACY_PREFLIGHT_PRICE_LIMIT = 1000

async function fetchBoundedJsonRows({ fetch: fetchImpl, url, headers, limit }) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { ...headers, Range: `0-${limit - 1}`, 'Range-Unit': 'items' },
  })
  if (!response.ok) fail(`HTTP request failed with status ${response.status}`)
  let rows
  try { rows = await response.json() } catch { fail('HTTP response was not valid JSON') }
  if (!Array.isArray(rows) || rows.length > limit) fail('Bounded HTTP response exceeded its row limit')
  return rows
}

async function collectLegacyBoundedPreflight({ fetch: fetchImpl, http, clock }) {
  const base = http.base()
  const headers = http.headers('service')
  const countResponse = await fetchImpl(`${base}/rest/v1/tokend_usage_events?select=id`, {
    method: 'HEAD',
    headers: { ...headers, Range: '0-0', 'Range-Unit': 'items', Prefer: 'count=planned' },
  })
  if (!countResponse.ok) fail(`HTTP request failed with status ${countResponse.status}`)
  const countRange = /^(?:\d+-\d+|\*)\/(\d+|\*)$/.exec(countResponse.headers.get('content-range') ?? '')
  const estimatedEventCount = countRange?.[1] && countRange[1] !== '*' ? BigInt(countRange[1]).toString() : null
  const select = 'id,member_code,model,total_tokens,total_cost'
  const [firstRows, lastRows, legacyPriceRows] = await Promise.all([
    fetchBoundedJsonRows({
      fetch: fetchImpl,
      url: `${base}/rest/v1/tokend_usage_events?select=${select}&order=id.asc,member_code.asc&limit=${LEGACY_PREFLIGHT_SAMPLE_SIZE}`,
      headers,
      limit: LEGACY_PREFLIGHT_SAMPLE_SIZE,
    }),
    fetchBoundedJsonRows({
      fetch: fetchImpl,
      url: `${base}/rest/v1/tokend_usage_events?select=${select}&order=id.desc,member_code.desc&limit=${LEGACY_PREFLIGHT_SAMPLE_SIZE}`,
      headers,
      limit: LEGACY_PREFLIGHT_SAMPLE_SIZE,
    }),
    fetchBoundedJsonRows({
      fetch: fetchImpl,
      url: `${base}/rest/v1/tokend_model_prices?select=model_id&limit=${LEGACY_PREFLIGHT_PRICE_LIMIT}`,
      headers,
      limit: LEGACY_PREFLIGHT_PRICE_LIMIT,
    }),
  ])
  const sampled = []
  const seen = new Set()
  for (const row of [...firstRows, ...lastRows]) {
    const identity = `${String(row?.id ?? '')}\u0000${String(row?.member_code ?? '')}`
    if (seen.has(identity)) continue
    seen.add(identity)
    sampled.push(row)
  }
  const eligible = sampled.filter(row => Number(row?.total_tokens ?? 0) > 0)
  return {
    evidenceMode: 'legacy_bounded',
    authoritative: false,
    exactCountAttempted: false,
    countMethod: 'planned',
    estimatedEventCount,
    sampledEventCount: sampled.length,
    sampledEligibleEventCount: eligible.length,
    sampledZeroCostEventCount: eligible.filter(row => Number(row?.total_cost ?? 0) === 0).length,
    sampledTotalCost: sampled.reduce((sum, row) => sum + Number(row?.total_cost ?? 0), 0),
    legacyPriceRowsObserved: legacyPriceRows.length,
    legacyPriceRowsTruncated: legacyPriceRows.length === LEGACY_PREFLIGHT_PRICE_LIMIT,
    maxRowsFetched: (2 * LEGACY_PREFLIGHT_SAMPLE_SIZE) + LEGACY_PREFLIGHT_PRICE_LIMIT,
    timestamp: clock().toISOString(),
  }
}

function transient(error) {
  if (String(error?.sqlstate ?? error?.code) === '55000') return false
  return error?.status === 429 || error?.status >= 500 || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(error?.code)
}

export async function retryTransient(operation, { maxRetries = 3, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let attempt = 0
  while (true) {
    try {
      return await operation()
    } catch (error) {
      if (!transient(error) || attempt >= maxRetries) throw error
      await sleep(1000 * (2 ** attempt))
      attempt += 1
    }
  }
}

export function percentile95(values) {
  if (!Array.isArray(values) || values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]
}

export function compareSampleReports(baseline, candidate, limits) {
  const rate = (report, key) => report.count > 0 ? report[key] / report.count : 0
  if (rate(candidate, 'httpErrorCount') - rate(baseline, 'httpErrorCount') > limits.maxErrorRateDelta) fail('HTTP error rate delta exceeded')
  if (rate(candidate, 'jsonErrorCount') - rate(baseline, 'jsonErrorCount') > limits.maxErrorRateDelta) fail('JSON error rate delta exceeded')
  const p95Limit = Math.min(baseline.p95Seconds * limits.maxP95Multiplier, limits.maxP95Seconds)
  if (candidate.p95Seconds > p95Limit) fail('P95 latency gate exceeded')
  return {
    passed: true,
    httpErrorRateDelta: rate(candidate, 'httpErrorCount') - rate(baseline, 'httpErrorCount'),
    jsonErrorRateDelta: rate(candidate, 'jsonErrorCount') - rate(baseline, 'jsonErrorCount'),
    p95Limit,
  }
}

const ENVELOPE_KEYS = Object.freeze([
  'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'totalTokens', 'inputCost', 'outputCost', 'reasoningCost', 'cacheReadCost', 'cacheWriteCost',
  'unallocatedCost', 'totalCost', 'eligibleEventCount', 'reportedEventCount',
  'estimatedEventCount', 'zeroRateEventCount', 'legacyEventCount', 'unpricedEventCount',
  'breakdownInvalidCount', 'costAvailability', 'verifiedCostCoverage', 'coverageStatus',
  'costDetailsAvailable',
])

function assertEnvelope(envelope, label) {
  if (!envelope || typeof envelope !== 'object') fail(`${label} lacks an envelope`)
  for (const key of ENVELOPE_KEYS) {
    if (!Object.hasOwn(envelope, key)) fail(`${label} envelope is missing ${key}`)
    if (!['coverageStatus', 'costDetailsAvailable'].includes(key) && !Number.isFinite(Number(envelope[key]))) {
      fail(`${label} envelope has a nonnumeric ${key}`)
    }
  }
  if (typeof envelope.coverageStatus !== 'string' || typeof envelope.costDetailsAvailable !== 'boolean') {
    fail(`${label} envelope has invalid derived fields`)
  }
}

function equalWithin(left, right, tolerance, label) {
  if (typeof left === 'number' || typeof right === 'number') {
    const leftNumber = Number(left)
    const rightNumber = Number(right)
    if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)
      || Math.abs(leftNumber - rightNumber) > tolerance) fail(`${label} numeric mismatch`)
    return
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) fail(`${label} array mismatch`)
    left.forEach((value, index) => equalWithin(value, right[index], tolerance, `${label}[${index}]`))
    return
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])]
    for (const key of keys) equalWithin(left[key], right[key], tolerance, `${label}.${key}`)
    return
  }
  if (left !== right) fail(`${label} mismatch`)
}

export function validateRpcVerification(report, tolerance = 1e-9) {
  if (!sameSet(Object.keys(report.clientRpcResults ?? {}), CLIENT_RPC_NAMES)) fail('Nine vNext RPC equality failed')
  for (const [name, payload] of Object.entries(report.clientRpcResults)) if (payload?.ok !== true) fail(`${name} did not return ok`)
  assertEnvelope(report.summaryEnvelope, 'summary')
  for (const dimension of ['daily', 'model', 'channel', 'session', 'project']) {
    const child = report.childEnvelopeSums?.[dimension]
    assertEnvelope(child, dimension)
    equalWithin(report.summaryEnvelope, child, tolerance, `summary versus ${dimension}`)
  }
  for (const [index, pair] of (report.detailParentPairs ?? []).entries()) {
    assertEnvelope(pair.detail, `detail ${index}`)
    assertEnvelope(pair.parent, `parent ${index}`)
    equalWithin(pair.detail, pair.parent, tolerance, `detail versus parent ${index}`)
  }
  if ((report.detailParentPairs ?? []).length !== 3) fail('Model, channel, and session detail-parent proofs are required')
  if (!sameSet(report.legacyRpcNames ?? [], LEGACY_RPC_NAMES)) fail('Legacy RPC availability mismatch')
  const expectedClient = ['tokend_upload_events', 'tokend_upload_events_v2', ...CLIENT_RPC_NAMES]
  const expectedAdmin = report.adminExpected === false ? [PREFLIGHT_RPC_NAME] : [PREFLIGHT_RPC_NAME, ...ADMIN_RPC_NAMES]
  if (!sameSet(report.liveAccess?.anonAllowed ?? [], expectedClient)
    || !sameSet(report.liveAccess?.serviceDenied ?? [], expectedClient)
    || !sameSet(report.liveAccess?.serviceAllowed ?? [], expectedAdmin)
    || !sameSet(report.liveAccess?.anonDenied ?? [], expectedAdmin)
    || (report.adminExpected === false && !sameSet(report.liveAccess?.adminAbsent ?? [], ADMIN_RPC_NAMES))) fail('RPC live permission proof failed')
  return { passed: true, tolerance }
}

function requireRows(payload, key) {
  const rows = payload?.[key]
  if (!Array.isArray(rows) || rows.length === 0) fail(`${key} must be a non-empty RPC child array`)
  return rows
}

export async function collectRpcVerification({ token, liveAccess, adminExpected = true, callClient, callLegacy }) {
  const base = { p_token: token, p_period: '7d' }
  const clientRpcResults = {}
  clientRpcResults.tokend_get_summary_v5 = await callClient('tokend_get_summary_v5', { ...base, p_timezone: 'Asia/Shanghai' })
  clientRpcResults.tokend_get_daily_trend_v5 = await callClient('tokend_get_daily_trend_v5', { ...base, p_timezone: 'Asia/Shanghai' })
  const days = requireRows(clientRpcResults.tokend_get_daily_trend_v5, 'days')
  clientRpcResults.tokend_get_model_breakdown_v3 = await callClient('tokend_get_model_breakdown_v3', base)
  const models = requireRows(clientRpcResults.tokend_get_model_breakdown_v3, 'models')
  clientRpcResults.tokend_get_model_detail_v2 = await callClient('tokend_get_model_detail_v2', { ...base, p_model: models[0].model })
  clientRpcResults.tokend_get_channel_breakdown_v4 = await callClient('tokend_get_channel_breakdown_v4', base)
  const channels = requireRows(clientRpcResults.tokend_get_channel_breakdown_v4, 'channels')
  clientRpcResults.tokend_get_channel_detail_v3 = await callClient('tokend_get_channel_detail_v3', { ...base, p_channel: channels[0].channel, p_timezone: 'Asia/Shanghai' })
  clientRpcResults.tokend_get_sessions_v2 = await callClient('tokend_get_sessions_v2', { ...base, p_limit: 200 })
  const sessions = requireRows(clientRpcResults.tokend_get_sessions_v2, 'sessions')
  clientRpcResults.tokend_get_session_detail_v2 = await callClient('tokend_get_session_detail_v2', { p_token: token, p_session_id: sessions[0].sessionId })
  clientRpcResults.tokend_get_top_projects_v3 = await callClient('tokend_get_top_projects_v3', base)
  const projects = requireRows(clientRpcResults.tokend_get_top_projects_v3, 'projects')
  const legacyBodies = {
    tokend_get_summary_v4: { ...base, p_timezone: 'Asia/Shanghai' },
    tokend_get_daily_trend_v4: { ...base, p_timezone: 'Asia/Shanghai' },
    tokend_get_model_breakdown_v2: base,
    tokend_get_model_detail: { ...base, p_model: models[0].model },
    tokend_get_channel_breakdown_v3: base,
    tokend_get_channel_detail_v2: { ...base, p_channel: channels[0].channel, p_timezone: 'Asia/Shanghai' },
    tokend_get_sessions: { ...base, p_limit: 200 },
    tokend_get_session_detail: { p_token: token, p_session_id: sessions[0].sessionId },
    tokend_get_top_projects_v2: base,
  }
  const legacyRpcNames = []
  for (const name of LEGACY_RPC_NAMES) {
    const payload = await callLegacy(name, legacyBodies[name])
    if (!payload || payload.ok === false) fail(`Legacy RPC ${name} is unavailable`)
    legacyRpcNames.push(name)
  }
  return {
    clientRpcResults,
    summaryEnvelope: envelopeFromPayload(clientRpcResults.tokend_get_summary_v5),
    childEnvelopeSums: {
      daily: aggregateEnvelopes(days.map(envelopeFromPayload)),
      model: aggregateEnvelopes(models.map(envelopeFromPayload)),
      channel: aggregateEnvelopes(channels.map(envelopeFromPayload)),
      session: aggregateEnvelopes(sessions.map(envelopeFromPayload)),
      project: aggregateEnvelopes(projects.map(envelopeFromPayload)),
    },
    detailParentPairs: [
      { detail: envelopeFromPayload(clientRpcResults.tokend_get_model_detail_v2), parent: envelopeFromPayload(models[0]) },
      { detail: envelopeFromPayload(clientRpcResults.tokend_get_channel_detail_v3), parent: envelopeFromPayload(channels[0]) },
      { detail: envelopeFromPayload(clientRpcResults.tokend_get_session_detail_v2), parent: envelopeFromPayload(sessions[0]) },
    ],
    legacyRpcNames,
    liveAccess,
    adminExpected,
  }
}

function accessProbeBody(name) {
  const zeroUuid = '00000000-0000-0000-0000-000000000000'
  if (name === 'tokend_upload_events' || name === 'tokend_upload_events_v2') return { p_token: 'acl-probe-invalid', p_events: [], p_sync_states: [] }
  if (name === 'tokend_get_model_detail_v2') return { p_token: 'acl-probe-invalid', p_model: '__acl_probe__' }
  if (name === 'tokend_get_channel_detail_v3') return { p_token: 'acl-probe-invalid', p_channel: '__acl_probe__' }
  if (name === 'tokend_get_session_detail_v2') return { p_token: 'acl-probe-invalid', p_session_id: '__acl_probe__' }
  if (name === 'tokend_get_model_detail') return { p_token: 'acl-probe-invalid', p_model: '__acl_probe__' }
  if (name === 'tokend_get_channel_detail_v2') return { p_token: 'acl-probe-invalid', p_channel: '__acl_probe__' }
  if (name === 'tokend_get_session_detail') return { p_token: 'acl-probe-invalid', p_session_id: '__acl_probe__' }
  if (CLIENT_RPC_NAMES.includes(name) || LEGACY_RPC_NAMES.includes(name)) return { p_token: 'acl-probe-invalid' }
  if (name === PREFLIGHT_RPC_NAME) return {}
  if (name === 'tokend_pricing_health') return {}
  if (name === 'tokend_pricing_create_backfill') return { p_catalog_version: '__rollout_acl_probe__', p_create_request_id: zeroUuid }
  if (name === 'tokend_pricing_freeze_batch') return { p_run_id: zeroUuid, p_limit: 1 }
  if (name === 'tokend_pricing_backfill_batch') return { p_run_id: zeroUuid, p_after_member: '', p_after_event: '', p_limit: 1 }
  return { p_run_id: zeroUuid }
}

export async function probeLiveRpcAccess({ fetch: fetchImpl, url, anonKey, serviceKey, expectAdmin = true }) {
  const base = url.replace(/\/$/, '')
  const call = async (name, key) => fetchImpl(`${base}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(accessProbeBody(name)),
  })
  const clientNames = ['tokend_upload_events', 'tokend_upload_events_v2', ...CLIENT_RPC_NAMES]
  const proof = { anonAllowed: [], serviceDenied: [], serviceAllowed: [], anonDenied: [], adminAbsent: [] }
  for (const name of clientNames) {
    const [anon, service] = await Promise.all([call(name, anonKey), call(name, serviceKey)])
    if ([401, 403, 404, 405].includes(anon.status)) fail(`Anon cannot execute reviewed client RPC ${name}`)
    if (![401, 403, 404].includes(service.status)) fail(`Service role unexpectedly executes client RPC ${name}`)
    proof.anonAllowed.push(name)
    proof.serviceDenied.push(name)
  }
  for (const name of [PREFLIGHT_RPC_NAME]) {
    const [service, anon] = await Promise.all([call(name, serviceKey), call(name, anonKey)])
    if ([401, 403, 404, 405].includes(service.status)) fail(`Service role cannot execute reviewed admin RPC ${name}`)
    if (![401, 403, 404].includes(anon.status)) fail(`Anon unexpectedly executes admin RPC ${name}`)
    proof.serviceAllowed.push(name)
    proof.anonDenied.push(name)
  }
  for (const name of ADMIN_RPC_NAMES) {
    const [service, anon] = await Promise.all([call(name, serviceKey), call(name, anonKey)])
    if (!expectAdmin) {
      if (service.status !== 404 || anon.status !== 404) fail(`Pre-backfill RPC ${name} must be absent`)
      proof.adminAbsent.push(name)
      continue
    }
    if ([401, 403, 404, 405].includes(service.status)) fail(`Service role cannot execute reviewed admin RPC ${name}`)
    if (![401, 403, 404].includes(anon.status)) fail(`Anon unexpectedly executes admin RPC ${name}`)
    proof.serviceAllowed.push(name)
    proof.anonDenied.push(name)
  }
  return proof
}

function exactNonnegativeInteger(value, label) {
  let text
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer or decimal string`)
    text = String(value)
  } else if (typeof value === 'string' && /^\d+$/.test(value)) {
    text = BigInt(value).toString()
  } else {
    fail(`${label} must be a non-negative safe integer or decimal string`)
  }
  const integer = BigInt(text)
  return { text, number: integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : null }
}

function decimalCount(value, label) {
  const exact = exactNonnegativeInteger(value, label)
  return { text: exact.text, value: BigInt(exact.text) }
}

function assertNotAhead(localValue, databaseValue, label) {
  const local = decimalCount(localValue ?? 0, `Local ${label}`)
  const database = decimalCount(databaseValue, `Database ${label}`)
  if (local.value > database.value) fail(`Local ${label} is ahead of authoritative database progress`)
}

function normalizeFreezeProgress(payload, label = 'Freeze') {
  const scanned = decimalCount(payload?.scannedCount ?? 0, `${label} scannedCount`)
  const captured = decimalCount(payload?.frozenCount ?? payload?.capturedCount ?? 0, `${label} frozenCount`)
  const skipped = decimalCount(payload?.skippedCount ?? 0, `${label} skippedCount`)
  if (captured.value + skipped.value !== scanned.value) fail(`${label} cumulative counts do not reconcile`)
  return {
    scanned: scanned.text,
    captured: captured.text,
    skipped: skipped.text,
    complete: payload?.freezeComplete === true,
  }
}

function freezeProgressOutput(freeze) {
  return {
    phase: 'freeze',
    batch: Number(freeze.batches ?? 0),
    scanned: freeze.scanned,
    captured: freeze.captured,
    skipped: freeze.skipped,
    complete: freeze.complete === true,
  }
}

function binaryTextCompare(left, right) {
  if (left === right) return 0
  return left > right ? 1 : -1
}

export async function runBackfillBatches({
  state, limit, interruptAfterBatches, callBatch, saveState, sleep, cleanup, onProgress = async () => {},
}) {
  assertCommandAllowed(state, 'backfill-run')
  let current = structuredClone(state)
  const initial = current.backfill?.pricing
  if (current.backfill?.phase !== 'pricing' || !initial) fail('Backfill pricing requires a finalized freeze')
  if (initial.limit !== undefined && initial.limit !== null && Number(initial.limit) !== limit) {
    fail('Backfill pricing must resume with the persisted limit')
  }
  let batchesThisRun = 0
  try {
    while (decimalCount(current.backfill.pricing.remaining, 'Persisted backfill remainingCount').value !== 0n) {
      const previous = current.backfill.pricing
      const previousProcessed = decimalCount(previous.processed, 'Persisted backfill processedCount')
      const previousRemaining = decimalCount(previous.remaining, 'Persisted backfill remainingCount')
      const target = decimalCount(previous.target, 'Persisted backfill targetCount')
      const result = await retryTransient(
        () => callBatch({ limit }),
        { maxRetries: 3, sleep },
      )
      const processedExact = exactNonnegativeInteger(result.processed ?? 0, 'Backfill processed')
      if (processedExact.number === null || processedExact.number > limit) fail('Backfill processed must be a safe integer no greater than the requested limit')
      const nextProcessed = decimalCount(result.processedCount, 'Backfill processedCount')
      const revisionCount = decimalCount(result.revisionCount, 'Backfill revisionCount')
      const nextRemaining = decimalCount(result.remainingCount, 'Backfill remainingCount')
      if (nextProcessed.value < previousProcessed.value || nextRemaining.value > previousRemaining.value) {
        fail('Backfill returned nonmonotonic progress')
      }
      if (nextProcessed.value !== revisionCount.value) fail('Backfill processedCount disagrees with revisionCount')
      if (nextProcessed.value + nextRemaining.value !== target.value) fail('Backfill processed and remaining counts do not equal targetCount')
      if (nextProcessed.value === previousProcessed.value && nextRemaining.value > 0n) fail('Backfill made no progress')
      current = {
        ...current,
        backfill: {
          ...(current.backfill ?? {}),
          pricing: {
            limit,
            processed: nextProcessed.text,
            target: target.text,
            remaining: nextRemaining.text,
            batches: Number(previous.batches ?? 0) + 1,
            complete: nextRemaining.value === 0n,
          },
        },
        transition: 'rollout-active',
      }
      await saveState(current)
      batchesThisRun += 1
      const progress = {
        phase: 'pricing',
        batch: current.backfill.pricing.batches,
        processed: nextProcessed.text,
        target: target.text,
        remaining: nextRemaining.text,
        percent: target.value === 0n ? 100 : Number((nextProcessed.value * 10000n) / target.value) / 100,
        complete: nextRemaining.value === 0n,
      }
      await onProgress(progress)
      if (interruptAfterBatches && batchesThisRun >= interruptAfterBatches && nextRemaining.value > 0n) {
        await onProgress({ ...progress, resumeRequired: true })
        throw new ExitCodeError('Backfill intentionally interrupted after persisted progress', 75, true)
      }
    }
    return current
  } catch (error) {
    if (!error?.intentional && cleanup) await cleanup()
    throw error
  }
}

export async function runActivationRehearsal({
  runId, callAdmin, inspectState, checkpoint = async () => {}, resume = null,
}) {
  let progress = structuredClone(resume ?? {})
  const persist = async (phase, values = {}) => {
    progress = { ...progress, ...values, phase }
    await checkpoint(progress)
  }
  let liveState = await inspectState()
  assertEnvelope(liveState.envelope, 'live activation fixture summary')
  if (!progress.beforeState) {
    if (liveState.pointers?.activeRun === runId || liveState.pointers?.previousRun === runId) {
      fail('Activation recovery requires the persisted pre-activation checkpoint')
    }
    await persist('before', { beforeState: liveState })
  }
  const beforeState = progress.beforeState
  assertEnvelope(beforeState.envelope, 'pre-activation fixture summary')

  const isActive = state => state?.pointers?.activeRun === runId
  const isRolledBack = state => state?.pointers?.previousRun === runId
    && state?.pointers?.activeCatalog === beforeState.pointers?.activeCatalog
    && state?.pointers?.activeRun === beforeState.pointers?.activeRun
  const isBase = state => ['activeCatalog', 'previousCatalog', 'activeRun', 'previousRun']
    .every(pointer => (state?.pointers?.[pointer] ?? null) === (beforeState.pointers?.[pointer] ?? null))

  if (isActive(liveState)) {
    if (['reactivating', 'reactivated'].includes(progress.phase)) {
      await persist('reactivated', { secondState: liveState })
    } else {
      await persist('activated', { firstState: progress.firstState ?? liveState })
    }
  } else if (isRolledBack(liveState)) {
    await persist('rolled_back', {
      rollbackState: liveState,
      secondState: null,
      finalActivation: null,
    })
  } else if (!isBase(liveState)) {
    fail('Live activation pointers do not match a recoverable rehearsal phase')
  }

  let first = progress.firstActivation ?? { runId, status: 'active', recovered: true }
  if (!progress.firstState) {
    await persist('activating')
    first = await callAdmin('tokend_pricing_activate', { runId })
    if (first.runId !== runId || first.status !== 'active') fail('Activation did not bind the requested run')
    liveState = await inspectState()
    if (!isActive(liveState)) fail('Activation did not publish the requested live pointers')
    await persist('activated', { firstActivation: first, firstState: liveState })
  }
  const firstState = progress.firstState

  let rollback = progress.rollback ?? { runId, status: 'rolled_back', recovered: true }
  if (!progress.rollbackState) {
    await persist('rolling_back')
    rollback = await callAdmin('tokend_pricing_rollback', { runId })
    if (rollback.runId !== runId || !['rolled_back', 'already_rolled_back'].includes(rollback.status)) fail('Paired rollback did not bind the requested run')
    liveState = await inspectState()
    if (!isRolledBack(liveState)) fail('Paired rollback did not restore the frozen base pointers')
    await persist('rolled_back', { rollback, rollbackState: liveState })
  }
  const rollbackState = progress.rollbackState

  let second = progress.finalActivation ?? { runId, status: 'active', recovered: true }
  if (!progress.secondState) {
    await persist('reactivating')
    second = await callAdmin('tokend_pricing_activate', { runId })
    if (second.runId !== runId || second.status !== 'active') fail('Reactivation did not use the same run')
    liveState = await inspectState()
    if (!isActive(liveState)) fail('Reactivation did not restore the requested live pointers')
    await persist('reactivated', { finalActivation: second, secondState: liveState })
  }
  const secondState = progress.secondState
  for (const [label, state] of [['first activation', firstState], ['rollback', rollbackState], ['second activation', secondState]]) {
    assertEnvelope(state.envelope, `${label} fixture summary`)
  }
  equalWithin(beforeState.envelope, rollbackState.envelope, 1e-9, 'pre-activation versus rollback fixture summary')
  equalWithin(firstState.envelope, secondState.envelope, 1e-9, 'first versus second activation fixture summary')
  if (Number(firstState.envelope.estimatedEventCount) <= Number(beforeState.envelope.estimatedEventCount)
    || Number(firstState.envelope.zeroRateEventCount) <= Number(beforeState.envelope.zeroRateEventCount)) {
    fail('Activation did not switch the isolated estimated and zero-rate fixture statuses')
  }
  const totals = { oldTotal: Number(beforeState.envelope.totalCost), newTotal: Number(secondState.envelope.totalCost) }
  if (!Number.isFinite(Number(totals.oldTotal)) || !Number.isFinite(Number(totals.newTotal))) fail('Activation rehearsal requires exact old/new totals')
  try { equalWithin(firstState.pointers, secondState.pointers, 0, 'reactivation pointers') } catch { fail('Reactivation did not restore the same four pointers') }
  if (rollbackState.pointers?.activeCatalog !== firstState.pointers?.previousCatalog
    || rollbackState.pointers?.activeRun !== firstState.pointers?.previousRun
    || rollbackState.pointers?.previousCatalog !== firstState.pointers?.activeCatalog
    || rollbackState.pointers?.previousRun !== firstState.pointers?.activeRun) fail('Paired rollback did not swap all four pointers')
  for (const pointer of ['activeCatalog', 'previousCatalog', 'activeRun', 'previousRun']) {
    if (secondState.pointers?.[pointer] === undefined) fail(`Activation is missing ${pointer}`)
  }
  return { pointers: secondState.pointers, totals, firstActivation: first, rollback, finalActivation: second }
}

export function validateReconciliation(report, expected) {
  for (const counter of ['missingRevisionCount', 'duplicateRevisionCount', 'breakdownInvalidCount', 'unexplainedMemberCount']) {
    if (Number(report[counter]) !== 0) fail(`Reconciliation ${counter} must be zero; received ${report[counter]}`)
  }
  if (Number(report.targetCount) !== Number(report.revisionCount)) fail('Reconciliation targetCount must equal revisionCount')
  if (typeof report.reconciliationHash !== 'string' || report.reconciliationHash.length === 0) fail('Reconciliation authoritative hash is missing')
  if (report.catalogHash !== expected.catalogHash) fail('Reconciliation catalog hash mismatch')
  try { equalWithin(report.pointers, expected.pointers, 0, 'reconciliation pointers') } catch { fail('Reconciliation pointer mismatch') }
  return { passed: true }
}

function validateMonitorSnapshot(snapshot, baselineGlobal, baselineRpc) {
  if (!snapshot.legacyHealthy || !snapshot.vNextHealthy) fail('Legacy/vNext monitor health failed')
  for (const [label, report] of [['legacy', snapshot.legacyRpc], ['vNext', snapshot.vNextRpc]]) {
    const count = exactNonnegativeInteger(report?.count, `${label} monitor RPC count`).number
    const httpErrors = exactNonnegativeInteger(report?.httpErrorCount, `${label} monitor HTTP errors`).number
    const jsonErrors = exactNonnegativeInteger(report?.jsonErrorCount, `${label} monitor JSON errors`).number
    if (count === null || count === 0 || httpErrors === null || jsonErrors === null
      || httpErrors > count || jsonErrors > count || !Number.isFinite(Number(report?.p95Seconds))
      || Number(report.p95Seconds) < 0) fail(`${label} monitor RPC report is invalid`)
    compareSampleReports(baselineRpc, report, {
      maxErrorRateDelta: 0.01,
      maxP95Multiplier: 2,
      // The production Supabase tier has a measured 3-5s p95 under normal
      // ingestion. Preserve the 2x regression bound while keeping an absolute
      // ceiling below the database statement timeout.
      maxP95Seconds: 8,
    })
  }
  if (snapshot.global?.coverageAuthoritative !== false) {
    const adjustedCount = Number(snapshot.global?.eligibleEventCount ?? 0) - Number(snapshot.global?.knownFixtureCount ?? 0)
    if (adjustedCount < Number(baselineGlobal.eligibleEventCount ?? 0)) fail('Adjusted global eligible event count regressed')
    const coverageRank = { unpriced: 0, partial: 1, legacy: 2, zero_rate: 3, complete: 4, no_usage: 4 }
    if (!Object.hasOwn(coverageRank, snapshot.global?.status) || !Object.hasOwn(coverageRank, baselineGlobal.status)
      || coverageRank[snapshot.global.status] < coverageRank[baselineGlobal.status]) fail('Global coverage status regressed')
    if (Number(snapshot.global?.unpricedShare ?? 0) > Number(baselineGlobal.maxUnpricedShare ?? 0)) fail('Global unpriced share exceeded baseline')
    if (Number(snapshot.global?.membersOver2x ?? 0) > Number(baselineGlobal.membersOver2x ?? 0)) fail('membersOver2x exceeded baseline')
  }
  const postSnapshotEventCount = exactNonnegativeInteger(snapshot.global?.postSnapshotEventCount, 'Monitor postSnapshotEventCount').number
  const knownLateCount = exactNonnegativeInteger(snapshot.global?.knownLateCount, 'Monitor known late count').number
  if (postSnapshotEventCount === null || knownLateCount === null || postSnapshotEventCount < knownLateCount
    || postSnapshotEventCount - knownLateCount < Number(baselineGlobal.postSnapshotEventCount ?? 0)) {
    fail('Adjusted postSnapshotEventCount regressed')
  }
  if (Object.values(snapshot.fixtureHealth ?? {}).some(value => value !== true)) fail('Fixture health failed')
  if (snapshot.reconciliationHash !== baselineRpc.reconciliationHash) fail('Reconciliation hash drift')
  try { equalWithin(snapshot.pointers, baselineRpc.pointers, 0, 'pricing pointers') } catch { fail('Pricing pointer drift') }
}

export async function runMonitorLoop({
  durationSeconds, intervalSeconds, lateUploadEverySeconds, baselineGlobal, baselineRpc,
  collectSnapshot, uploadLateFixture, sleep,
}) {
  const samples = []
  let elapsed = 0
  let nextLate = lateUploadEverySeconds
  let previousPostSnapshotEventCount = Number(baselineGlobal.postSnapshotEventCount ?? 0)
  let previousKnownLateCount = 0
  let previousAdjustedPostSnapshotEventCount = previousPostSnapshotEventCount
  while (true) {
    const snapshot = await collectSnapshot()
    validateMonitorSnapshot(snapshot, baselineGlobal, baselineRpc)
    const postSnapshotEventCount = Number(snapshot.global.postSnapshotEventCount)
    const knownLateCount = Number(snapshot.global.knownLateCount)
    const adjustedPostSnapshotEventCount = postSnapshotEventCount - knownLateCount
    if (postSnapshotEventCount < previousPostSnapshotEventCount
      || knownLateCount < previousKnownLateCount
      || postSnapshotEventCount - previousPostSnapshotEventCount < knownLateCount - previousKnownLateCount
      || adjustedPostSnapshotEventCount < previousAdjustedPostSnapshotEventCount) {
      fail('Monitor postSnapshotEventCount regressed relative to known late fixtures')
    }
    previousPostSnapshotEventCount = postSnapshotEventCount
    previousKnownLateCount = knownLateCount
    previousAdjustedPostSnapshotEventCount = adjustedPostSnapshotEventCount
    samples.push(sanitizeForOutput({ elapsedSeconds: elapsed, ...snapshot }))
    if (elapsed >= durationSeconds) break
    const step = Math.min(intervalSeconds, durationSeconds - elapsed)
    await sleep(step * 1000)
    elapsed += step
    while (elapsed >= nextLate) {
      await uploadLateFixture()
      nextLate += lateUploadEverySeconds
    }
  }
  return { passed: true, samples, fixtureHealth: samples.at(-1)?.fixtureHealth ?? {} }
}

function requireEnvironment(env, names) {
  const values = {}
  for (const name of names) {
    if (!env[name]) fail(`Missing required environment variable ${name}`)
    values[name] = env[name]
  }
  return values
}

function createHttpAdapter({ env, fetch: fetchImpl }) {
  const base = () => requireEnvironment(env, ['SUPABASE_URL']).SUPABASE_URL.replace(/\/$/, '')
  const key = role => requireEnvironment(env, [role === 'service' ? 'SUPABASE_SERVICE_KEY' : 'SUPABASE_ANON_KEY'])[
    role === 'service' ? 'SUPABASE_SERVICE_KEY' : 'SUPABASE_ANON_KEY'
  ]
  const headers = (role, extra = {}) => {
    const credential = key(role)
    return { apikey: credential, Authorization: `Bearer ${credential}`, 'content-type': 'application/json', ...extra }
  }
  const raw = async (resource, { role = 'anon', method = 'POST', body, extraHeaders } = {}) => {
    const response = await fetchImpl(`${base()}/rest/v1/${resource}`, {
      method,
      headers: headers(role, extraHeaders),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return response
  }
  const json = async (resource, options = {}) => {
    const response = await raw(resource, options)
    if (!response.ok) {
      const error = new ExitCodeError(`HTTP request failed with status ${response.status}`)
      error.status = response.status
      try {
        const failure = await response.json()
        error.sqlstate = failure?.sqlstate ?? failure?.code
      } catch {}
      throw error
    }
    if (response.status === 204) return null
    try { return await response.json() } catch { fail('HTTP response was not valid JSON') }
  }
  const rpc = (name, body, role = 'anon') => json(`rpc/${name}`, { role, body })
  return { base, key, headers, raw, json, rpc }
}

async function optionalPostgrestRpc(http, name, body, role) {
  const response = await http.raw(`rpc/${name}`, { role, body })
  if (response.ok) {
    try { return { present: true, value: await response.json() } } catch { fail('HTTP response was not valid JSON') }
  }
  if (response.status === 404) {
    try {
      const failure = await response.json()
      if (failure?.code === 'PGRST202') return { present: false, value: null }
    } catch {}
  }
  fail(`HTTP request failed with status ${response.status}`)
}

function fixtureEvent(id, model, timestamp, overrides = {}) {
  return {
    id,
    timestampMs: timestamp,
    sessionId: `rollout-${id}`,
    agent: 'rollout-contract',
    provider: 'openai',
    model,
    channel: 'rollout',
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 15,
    ...overrides,
  }
}

function uploadArguments(token, events) {
  return {
    p_token: token,
    p_events: events,
    p_sync_states: [],
  }
}

function rowBy(rows, key, value) {
  return rows.find(row => row[key] === value)
}

const BACKFILL_SNAPSHOT_SELECT = [
  'run_id', 'status', 'catalog_version', 'snapshot_at', 'target_count', 'target_hash',
  'base_catalog_version', 'base_backfill_run_id', 'input_tokens', 'output_tokens',
  'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens', 'before_total_cost',
  'reconciliation_hash',
].join(',')

async function fetchBackfillRunRow(http, runId) {
  const rows = await http.json(
    `tokend_pricing_backfill_runs?select=${BACKFILL_SNAPSHOT_SELECT}&run_id=eq.${encodeURIComponent(runId)}`,
    { role: 'service', method: 'GET' },
  )
  if (!Array.isArray(rows) || rows.length !== 1) fail('Authoritative backfill run lookup failed')
  return rows[0]
}

function snapshotFromBackfillRow(row, basePointers) {
  return {
    snapshotAt: row.snapshot_at,
    targetCount: exactNonnegativeInteger(row.target_count, 'Backfill targetCount').text,
    targetHash: row.target_hash,
    baseCatalogVersion: row.base_catalog_version ?? null,
    baseRunId: row.base_backfill_run_id ?? null,
    inputTokens: exactNonnegativeInteger(row.input_tokens, 'Backfill inputTokens').text,
    outputTokens: exactNonnegativeInteger(row.output_tokens, 'Backfill outputTokens').text,
    reasoningTokens: exactNonnegativeInteger(row.reasoning_tokens, 'Backfill reasoningTokens').text,
    cacheReadTokens: exactNonnegativeInteger(row.cache_read_tokens, 'Backfill cacheReadTokens').text,
    cacheWriteTokens: exactNonnegativeInteger(row.cache_write_tokens, 'Backfill cacheWriteTokens').text,
    ...(basePointers ? { basePointers } : {}),
  }
}

function assertSameBackfillSnapshot(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('Frozen backfill snapshot metadata changed')
}

async function verifySmokeRows(http, memberCode, ids) {
  const memberFilter = `member_code=eq.${encodeURIComponent(memberCode)}`
  const eventList = ids.map(encodeURIComponent).join(',')
  const baseRows = await http.json(
    `tokend_usage_events?select=id,pricing_status,input_cost,output_cost,reasoning_cost,cache_read_cost,cache_write_cost,total_cost&${memberFilter}&id=in.(${eventList})`,
    { role: 'service', method: 'GET' },
  )
  const revisionRows = await http.json(
    `tokend_event_cost_revisions?select=event_id,pricing_status,input_cost,output_cost,reasoning_cost,cache_read_cost,cache_write_cost,total_cost&${memberFilter}&event_id=in.(${eventList})`,
    { role: 'service', method: 'GET' },
  )
  if (!Array.isArray(baseRows) || !Array.isArray(revisionRows)) fail('Upload smoke verification queries returned invalid rows')
  const [legacyId, estimatedId, maliciousId] = ids
  const legacy = rowBy(baseRows, 'id', legacyId)
  const estimated = rowBy(baseRows, 'id', estimatedId)
  const malicious = rowBy(baseRows, 'id', maliciousId)
  const costFields = ['input_cost', 'output_cost', 'reasoning_cost', 'cache_read_cost', 'cache_write_cost', 'total_cost']
  if (legacy?.pricing_status !== 'legacy' || Number(legacy?.total_cost ?? 0) <= 0) fail('Legacy upload did not persist an authoritative nonzero base cost')
  if (estimated?.pricing_status !== 'unpriced' || costFields.some(key => Number(estimated?.[key] ?? -1) !== 0)) fail('Estimated fixture base row is not unpriced zero-cost')
  if (malicious?.pricing_status !== 'unpriced' || costFields.some(key => Number(malicious?.[key] ?? -1) !== 0)) fail('Client 999 entered the authoritative base row')
  for (const id of [estimatedId, maliciousId]) {
    const revision = rowBy(revisionRows, 'event_id', id)
    if (!revision) continue
    if (revision.pricing_status !== 'estimated' || costFields.some(key => Number(revision[key]) === 999)) fail('Server estimate revision proof failed')
  }
}

async function verifyLegacySmokeRow(http, memberCode, id) {
  const memberFilter = `member_code=eq.${encodeURIComponent(memberCode)}`
  const rows = await http.json(
    `tokend_usage_events?select=id,input_cost,output_cost,reasoning_cost,cache_read_cost,cache_write_cost,total_cost&${memberFilter}&id=eq.${encodeURIComponent(id)}`,
    { role: 'service', method: 'GET' },
  )
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].id !== id || Number(rows[0].total_cost ?? 0) <= 0) {
    fail('Legacy-only upload did not persist exactly one authoritative nonzero row')
  }
}

async function writeSanitized(file, value, adapters) {
  const clean = sanitizeForOutput(value)
  const encoded = JSON.stringify(clean)
  for (const forbidden of adapters.secretValues ?? []) {
    if (forbidden && encoded.includes(forbidden)) fail('Sanitized output contained a credential value')
  }
  await atomicWriteJson(file, clean, adapters)
  return clean
}

function aggregateEnvelopes(rows) {
  if (rows.length === 0) fail('Cannot aggregate an empty RPC child list')
  const result = {}
  const derived = new Set(['costAvailability', 'verifiedCostCoverage', 'coverageStatus', 'costDetailsAvailable'])
  for (const key of ENVELOPE_KEYS) {
    if (derived.has(key)) continue
    result[key] = rows.reduce((sum, row) => sum + Number(row[key] ?? 0), 0)
  }
  const eligible = Number(result.eligibleEventCount)
  const available = Number(result.reportedEventCount) + Number(result.estimatedEventCount)
    + Number(result.zeroRateEventCount) + Number(result.legacyEventCount)
  const verified = Number(result.reportedEventCount) + Number(result.estimatedEventCount)
    + Number(result.zeroRateEventCount)
  result.costAvailability = eligible === 0 ? 0 : Math.min(1, Math.max(0, available / eligible))
  result.verifiedCostCoverage = eligible === 0 ? 0 : Math.min(1, Math.max(0, verified / eligible))
  result.coverageStatus = eligible === 0 ? 'no_usage'
    : Number(result.unpricedEventCount) === eligible ? 'unpriced'
      : Number(result.zeroRateEventCount) === eligible ? 'zero_rate'
        : Number(result.unpricedEventCount) > 0 ? 'partial'
          : Number(result.legacyEventCount) > 0 ? 'legacy' : 'complete'
  result.costDetailsAvailable = rows[0].costDetailsAvailable
  return result
}

function coverageFromCounts(eventCount, counts) {
  const eligible = Number(eventCount ?? 0)
  const unpriced = Number(counts?.unpriced ?? 0)
  const zeroRate = Number(counts?.zero_rate ?? 0)
  const legacy = Number(counts?.legacy ?? 0)
  if (eligible === 0) return 'no_usage'
  if (unpriced === eligible) return 'unpriced'
  if (zeroRate === eligible) return 'zero_rate'
  if (unpriced > 0) return 'partial'
  if (legacy > 0) return 'legacy'
  return 'complete'
}

function pricingPointers(payload = {}) {
  return {
    activeCatalog: payload.activeCatalogVersion ?? payload.activeCatalog ?? null,
    activeRun: payload.activeRunId ?? payload.activeRun ?? null,
    previousCatalog: payload.previousCatalogVersion ?? payload.previousCatalog ?? null,
    previousRun: payload.previousRunId ?? payload.previousRun ?? null,
  }
}

function pricingPointerBindingHash(payload) {
  return sha256(JSON.stringify(pricingPointers(payload)))
}

function addCounts(left = {}, right = {}) {
  const result = { ...left }
  for (const [key, value] of Object.entries(right)) result[key] = Number(result[key] ?? 0) + Number(value ?? 0)
  return result
}

function subtractCounts(left = {}, right = {}) {
  const result = { ...left }
  for (const [key, value] of Object.entries(right)) result[key] = Math.max(0, Number(result[key] ?? 0) - Number(value ?? 0))
  return result
}

function envelopeFromPayload(payload) {
  if (!payload || typeof payload !== 'object') fail('RPC returned no JSON envelope')
  const envelope = {}
  for (const key of ENVELOPE_KEYS) envelope[key] = payload[key]
  assertEnvelope(envelope, 'RPC')
  return envelope
}

function childRows(payload, keys) {
  for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key]
  return []
}

async function deleteFixtureData({ state, http, includeMember, preserveBackfill = false, timestamp }) {
  const memberCode = state.fixture?.memberCode
    ?? (includeMember ? state.fixtureCandidate?.memberCode : null)
  if (!memberCode) {
    return state
  }
  const filter = `member_code=eq.${encodeURIComponent(memberCode)}`
  const optionalAdditive = async operation => {
    try { return await operation() } catch (error) {
      if (error?.status === 404 && ['PGRST205', '42P01'].includes(error?.sqlstate)) return null
      throw error
    }
  }
  const targets = await optionalAdditive(() => http.json(`tokend_pricing_backfill_targets?select=member_code&${filter}`, { role: 'service', method: 'GET' }))
  if (Array.isArray(targets) && targets.length > 0) fail('Fixture is part of an immutable backfill target; cleanup is unsafe')
  const tables = [
    ['tokend_event_cost_revisions', true],
    ['tokend_message_events', false], ['tokend_usage_events', false],
    ['tokend_sessions', false], ['tokend_sync_state', false],
  ]
  if (includeMember) tables.push(['tokend_members', false])
  for (const [table, additive] of tables) {
    const remove = () => http.json(`${table}?${filter}`, {
      role: 'service', method: 'DELETE', extraHeaders: { Prefer: 'return=representation' },
    })
    if (additive) await optionalAdditive(remove)
    else await remove()
  }
  const next = { ...state }
  delete next.fixtureStatusCounts
  delete next.lateFixtures
  delete next.lateFixtureBatches
  delete next.lateFixtureCount
  if (includeMember) {
    const remaining = await http.json(`tokend_members?select=member_code&${filter}`, { role: 'service', method: 'GET' })
    if (!Array.isArray(remaining) || remaining.length !== 0) fail('Fixture cleanup zero-row verification failed')
    delete next.fixture
    delete next.fixtureCandidate
    return next
  }
  return { ...next, fixture: { ...state.fixture, resetAt: timestamp } }
}

async function probe(http, name, role, body = {}) {
  const response = await http.raw(`rpc/${name}`, { role, body })
  return { present: ![404, 405].includes(response.status), allowed: ![401, 403, 404, 405].includes(response.status) }
}

function exactLateEvents(uuid, now) {
  return [
    fixtureEvent(`late-known-${uuid}`, 'gpt-5.6-sol', now, { expectedStatus: 'estimated' }),
    fixtureEvent(`late-zero-${uuid}`, 'codex-auto-review', now + 1, { expectedStatus: 'zero_rate' }),
    fixtureEvent(`late-unpriced-${uuid}`, 'unknown-rollout-model', now + 2, { expectedStatus: 'unpriced' }),
    fixtureEvent(`late-reported-${uuid}`, 'gpt-5.6-sol', now + 3, {
      pricingStatus: 'reported', inputCost: 0.005, outputCost: 0.005, reasoningCost: 0,
      cacheReadCost: 0, cacheWriteCost: 0, totalCost: 0.01, expectedStatus: 'reported',
    }),
    fixtureEvent(`late-legacy-${uuid}`, 'gpt-5.6-sol', now + 4, {
      inputCost: 0.005, outputCost: 0.005, reasoningCost: 0,
      cacheReadCost: 0, cacheWriteCost: 0, totalCost: 0.01, expectedStatus: 'legacy',
    }),
  ]
}

async function uploadLateFixtureSet(http, token, uuid, now) {
  const events = exactLateEvents(uuid, now)
  const staged = await http.rpc('tokend_upload_events_v2', uploadArguments(token, events.slice(0, 3)), 'anon')
  const authoritative = await http.rpc('tokend_upload_events', uploadArguments(token, events.slice(3)), 'anon')
  if (staged?.ok !== true || Number(staged.inserted) !== 3
    || authoritative?.ok !== true || Number(authoritative.inserted) !== 2) fail('Late fixture upload counts were not exact')
  return events
}

async function verifyLateRows(http, memberCode, events, catalogVersion) {
  if (!catalogVersion) fail('Late fixture verification requires an authoritative catalog version')
  const memberFilter = `member_code=eq.${encodeURIComponent(memberCode)}`
  const ids = events.map(event => event.id)
  const idList = ids.map(encodeURIComponent).join(',')
  const baseRows = await http.json(
    `tokend_usage_events?select=id,pricing_status,total_cost&${memberFilter}&id=in.(${idList})`,
    { role: 'service', method: 'GET' },
  )
  const revisionRows = await http.json(
    `tokend_event_cost_revisions?select=event_id,pricing_status,total_cost&${memberFilter}&version=eq.${encodeURIComponent(catalogVersion)}&event_id=in.(${idList})`,
    { role: 'service', method: 'GET' },
  )
  if (!Array.isArray(baseRows) || baseRows.length !== 5) fail('Late fixture base rows must match all five exact ids')
  const expectedBase = ['unpriced', 'unpriced', 'unpriced', 'reported', 'legacy']
  ids.forEach((id, index) => {
    if (rowBy(baseRows, 'id', id)?.pricing_status !== expectedBase[index]) fail('Late fixture base status mismatch')
  })
  const expectedRevision = ['estimated', 'zero_rate', 'unpriced']
  ids.slice(0, 3).forEach((id, index) => {
    if (rowBy(revisionRows, 'event_id', id)?.pricing_status !== expectedRevision[index]) fail('Late fixture revision status mismatch')
  })
  return { known: true, zero: true, unpriced: true, reported: true, legacy: true }
}

async function fixtureMembersOver2xContribution(http, memberCode, activeCatalog, previousCatalog) {
  if (!memberCode || !activeCatalog || !previousCatalog) return 0
  const memberFilter = `member_code=eq.${encodeURIComponent(memberCode)}`
  const versionFilter = [activeCatalog, previousCatalog].map(encodeURIComponent).join(',')
  const [baseRows, revisionRows] = await Promise.all([
    http.json(`tokend_usage_events?select=id,total_cost&${memberFilter}`, { role: 'service', method: 'GET' }),
    http.json(`tokend_event_cost_revisions?select=event_id,version,total_cost&${memberFilter}&version=in.(${versionFilter})`, { role: 'service', method: 'GET' }),
  ])
  if (!Array.isArray(baseRows) || !Array.isArray(revisionRows)) fail('Fixture membersOver2x verification returned invalid rows')
  const totalFor = version => baseRows.reduce((sum, row) => {
    const revision = revisionRows.find(candidate => candidate.event_id === row.id && candidate.version === version)
    return sum + Number(revision?.total_cost ?? row.total_cost ?? 0)
  }, 0)
  const activeTotal = totalFor(activeCatalog)
  const previousTotal = totalFor(previousCatalog)
  if (!Number.isFinite(activeTotal) || !Number.isFinite(previousTotal)) fail('Fixture membersOver2x verification returned invalid totals')
  return activeTotal > previousTotal * 2 ? 1 : 0
}

export function createRolloutRunner(dependencies = {}) {
  const env = dependencies.env ?? process.env
  const fs = dependencies.fs ?? nodeFs
  const sourceFetch = dependencies.fetch ?? globalThis.fetch
  const abortController = dependencies.abortController ?? new AbortController()
  const fetchImpl = (input, init = {}) => sourceFetch(input, {
    ...init,
    signal: init.signal ?? abortController.signal,
  })
  const clock = dependencies.clock ?? (() => new Date())
  const sourceSleep = dependencies.sleep
  const sleep = async ms => {
    if (abortController.signal.aborted) throw Object.assign(new Error('Rollout aborted'), { name: 'AbortError' })
    if (!sourceSleep) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          abortController.signal.removeEventListener('abort', onAbort)
          resolve()
        }, ms)
        const onAbort = () => {
          clearTimeout(timer)
          reject(Object.assign(new Error('Rollout aborted'), { name: 'AbortError' }))
        }
        abortController.signal.addEventListener('abort', onAbort, { once: true })
      })
    }
    let rejectAbort
    const aborted = new Promise((_resolve, reject) => { rejectAbort = reject })
    const onAbort = () => rejectAbort(Object.assign(new Error('Rollout aborted'), { name: 'AbortError' }))
    abortController.signal.addEventListener('abort', onAbort, { once: true })
    try { return await Promise.race([sourceSleep(ms), aborted]) } finally {
      abortController.signal.removeEventListener('abort', onAbort)
    }
  }
  const randomUUID = dependencies.randomUUID ?? nodeRandomUUID
  const onProgress = dependencies.onProgress ?? (entry => {
    process.stderr.write(`${JSON.stringify(sanitizeForOutput(entry))}\n`)
  })
  const dumpLinkedSchema = dependencies.dumpLinkedSchema ?? productionDumpLinkedSchema
  if (typeof sourceFetch !== 'function') fail('A fetch adapter is required')
  const adapters = {
    fs,
    randomUUID,
    secretValues: [env.SUPABASE_SERVICE_KEY, env.SUPABASE_ANON_KEY].filter(Boolean),
  }
  const http = createHttpAdapter({ env, fetch: fetchImpl })

  const loadState = async file => {
    try {
      const metadata = await fs.stat(file)
      if ((metadata.mode & 0o077) !== 0) fail('Private rollout state must have 0600 permissions')
    } catch (error) {
      if (error?.code === 'ENOENT') return {}
      if (error instanceof ExitCodeError) throw error
      fail('Private rollout state could not be read')
    }
    try { return await readJson(file, fs) } catch { fail('Private rollout state could not be read') }
  }
  const saveState = (file, state) => atomicWriteJson(file, state, adapters)

  async function execute(command, options) {
    if (!COMMAND_SPECS[command]) fail(`Unknown subcommand: ${command}`)

    if (command === 'wrapper-gate') {
      const [liveSql, reviewedSql] = await Promise.all([
        fs.readFile(options.liveSchema, 'utf8'), fs.readFile(options.rollbackSql, 'utf8'),
      ])
      const comparison = compareWrapperDefinitions(liveSql, reviewedSql)
      const output = { ...comparison, timestamp: clock().toISOString() }
      const existing = await loadState(options.state)
      await saveState(options.state, { ...existing, ...output, transition: 'pre-wrapper-gated' })
      return writeSanitized(options.out, output, adapters)
    }

    if (command === 'migration-manifest') {
      const state = await loadState(options.state)
      if (state.wrapperGatePassed !== true) fail('Wrapper gate is required before migration manifest')
      const manifest = await createMigrationManifest(options.files, { fs })
      const next = mergeMigrationManifestState(state, manifest)
      await saveState(options.state, next)
      return writeSanitized(options.out, {
        entries: manifest.entries,
        addedManifestHash: manifest.manifestHash,
        manifestHash: next.manifestHash,
        plannedMigrationHashes: next.plannedMigrationHashes,
      }, adapters)
    }

    if (command === 'migration-gate') {
      const state = await loadState(options.state)
      const migrationList = await fs.readFile(options.migrationList, 'utf8')
      const next = await validateMigrationGate({
        state, migrationList, migrationsDir: options.migrationsDir, phase: options.phase, fs,
        allowEmptyHistory: options.allowEmptyHistory === true,
        now: () => clock().toISOString(),
      })
      await saveState(options.state, next)
      return writeSanitized(options.out, {
        phase: options.phase,
        transition: next.transition,
        emptyHistoryAccepted: next.emptyHistoryAccepted === true,
        forwardRecoveryRequired: next.forwardRecoveryRequired === true,
        appliedMigrationHashes: next.appliedMigrationHashes,
        timestamp: clock().toISOString(),
      }, adapters)
    }

    if (command === 'preflight') {
      requireEnvironment(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'])
      const adminProbe = await optionalPostgrestRpc(http, PREFLIGHT_RPC_NAME, {}, 'service')
      if (!adminProbe.present) {
        const bounded = await collectLegacyBoundedPreflight({ fetch: fetchImpl, http, clock })
        return writeSanitized(options.out, bounded, adapters)
      }
      const adminBaseline = adminProbe.value
      if (adminBaseline?.authoritative !== true) fail('Admin preflight is present but not authoritative')
      if (adminBaseline.source !== 'frozen_reconciled_run') {
        fail('Authoritative admin preflight source must be frozen_reconciled_run')
      }
      if (typeof adminBaseline?.catalogHash !== 'string' || adminBaseline.catalogHash.length === 0) {
        fail('Authoritative admin preflight is missing catalog hash')
      }
      const eventCount = Number(adminBaseline?.eventCount ?? 0)
      const eligibleEventCount = Number(adminBaseline?.eligibleEventCount ?? 0)
      const effectiveStatusCounts = adminBaseline?.statusCounts ?? {}
      const effectiveEligibleZeroCount = Number(adminBaseline?.eligibleZeroCostEventCount ?? 0)
      const effectiveUnpricedCount = Number(adminBaseline?.unpricedEventCount ?? 0)
      const output = {
        evidenceMode: 'admin_authoritative',
        authoritative: true,
        source: adminBaseline.source,
        catalogHash: adminBaseline.catalogHash,
        pointerBindingHash: pricingPointerBindingHash(adminBaseline),
        exactCountAttempted: false,
        eventCount,
        eligibleEventCount,
        eligibleZeroCostEventCount: effectiveEligibleZeroCount,
        totalCost: Number(adminBaseline?.totalCost ?? 0),
        unpricedEventCount: effectiveUnpricedCount,
        unpricedShare: eligibleEventCount > 0 ? effectiveUnpricedCount / eligibleEventCount : 0,
        maxUnpricedShare: eligibleEventCount > 0 ? effectiveUnpricedCount / eligibleEventCount : 0,
        status: coverageFromCounts(eligibleEventCount, effectiveStatusCounts),
        statusCounts: effectiveStatusCounts,
        zeroCostByModel: adminBaseline?.zeroCostByModel ?? [],
        legacyPriceRowCount: Number(adminBaseline?.legacyPriceRowCount ?? 0),
        activeCatalogVersion: adminBaseline?.activeCatalogVersion ?? null,
        activeRunId: adminBaseline?.activeRunId ?? null,
        previousCatalogVersion: adminBaseline?.previousCatalogVersion ?? null,
        previousRunId: adminBaseline?.previousRunId ?? null,
        membersOver2x: Number(adminBaseline?.membersOver2xCount ?? 0),
        reconciliationHash: adminBaseline?.activeReconciliationHash ?? null,
        timestamp: clock().toISOString(),
      }
      return writeSanitized(options.out, output, adapters)
    }

    if (command === 'compare-samples') {
      const [baseline, candidate] = await Promise.all([readJson(options.baseline, fs), readJson(options.candidate, fs)])
      return sanitizeForOutput(compareSampleReports(baseline, candidate, {
        maxErrorRateDelta: options.maxErrorRateDelta,
        maxP95Multiplier: options.maxP95Multiplier,
        maxP95Seconds: options.maxP95Seconds,
      }))
    }

    if (command === 'sample') {
      if (![...CLIENT_RPC_NAMES, ...LEGACY_RPC_NAMES].includes(options.rpc)) fail('Sample RPC is not in the reviewed client surface')
      const sampleState = options.state ? await loadState(options.state) : {}
      const sampleToken = sampleState.fixture?.memberToken ?? 'rollout-sample-invalid'
      const latencies = []
      let httpErrorCount = 0
      let jsonErrorCount = 0
      for (let index = 0; index < options.count; index += 1) {
        const started = clock().getTime()
        const response = await http.raw(`rpc/${options.rpc}`, { role: 'anon', body: { p_token: sampleToken } })
        latencies.push(Math.max(0, clock().getTime() - started) / 1000)
        if (!response.ok) { httpErrorCount += 1; continue }
        try { await response.json() } catch { jsonErrorCount += 1 }
      }
      return writeSanitized(options.out, {
        rpc: options.rpc,
        count: options.count,
        httpErrorCount,
        jsonErrorCount,
        p95Seconds: percentile95(latencies),
      }, adapters)
    }

    const state = options.state ? await loadState(options.state) : {}
    assertCommandAllowed(state, command)

    if (command === 'fixture-create') {
      if (state.fixture) return state
      const existingCandidate = state.fixtureCandidate
      const suffix = existingCandidate?.suffix ?? randomUUID().replace(/-/g, '')
      const fixture = existingCandidate ?? {
        suffix,
        memberCode: `ROLL_${suffix}`,
        memberToken: `roll_${sha256(`${suffix}:${clock().toISOString()}`).slice(0, 32)}`,
        phone: `tokend-rollout-${suffix}`,
        createdAt: clock().toISOString(),
      }
      if (!existingCandidate) {
        await saveState(options.state, {
          ...state,
          fixtureCandidate: fixture,
          transition: 'rollout-active',
        })
      }
      let existingRows = []
      if (existingCandidate) {
        existingRows = await http.json(
          `tokend_members?select=member_code,token&member_code=eq.${encodeURIComponent(fixture.memberCode)}&limit=2`,
          { role: 'service', method: 'GET' },
        )
        if (!Array.isArray(existingRows) || existingRows.length > 1) fail('Fixture recovery did not find a unique rollout member')
        if (existingRows.length === 1 && existingRows[0].token !== fixture.memberToken) {
          fail('Fixture recovery token disagrees with the persisted candidate')
        }
      }
      if (existingRows.length === 0) {
        await http.json('tokend_members', {
          role: 'service', method: 'POST',
          body: [{
            member_code: fixture.memberCode,
            phone: fixture.phone,
            token: fixture.memberToken,
          }],
          extraHeaders: { Prefer: 'return=representation' },
        })
      }
      const next = { ...state, fixture, transition: 'rollout-active' }
      delete next.fixtureCandidate
      delete next.fixture.suffix
      delete next.fixture.phone
      await saveState(options.state, next)
      return next
    }

    if (command === 'fixture-reset') {
      const next = await deleteFixtureData({ state, http, includeMember: false, timestamp: clock().toISOString() })
      await saveState(options.state, next)
      return sanitizeForOutput({ reset: true, timestamp: clock().toISOString() })
    }

    if (command === 'upload-smoke') {
      if (!state.fixture?.memberToken) fail('Isolated fixture must exist before upload smoke')
      const suffix = randomUUID()
      const timestamp = clock().getTime()
      const legacyEvent = fixtureEvent(`legacy-${suffix}`, 'gpt-5.6-sol', timestamp, {
        inputCost: 0.01, outputCost: 0.01, reasoningCost: 0,
        cacheReadCost: 0, cacheWriteCost: 0, totalCost: 0.02,
      })
      const legacy = await http.rpc('tokend_upload_events', uploadArguments(state.fixture.memberToken, [legacyEvent]), 'anon')
      if (legacy?.ok !== true || Number(legacy?.inserted ?? 0) !== 1) fail('Legacy upload smoke did not insert exactly one event')
      if (options.legacyOnly) {
        await verifyLegacySmokeRow(http, state.fixture.memberCode, legacyEvent.id)
        const next = {
          ...state,
          fixtureStatusCounts: addCounts(state.fixtureStatusCounts, { legacy: 1 }),
          uploadSmokeAt: clock().toISOString(),
        }
        await saveState(options.state, next)
        return sanitizeForOutput({ passed: true, legacyOnly: true, timestamp: next.uploadSmokeAt })
      }
      const estimatedEvent = fixtureEvent(`estimated-${suffix}`, 'gpt-5.6-sol', timestamp)
      const estimated = await http.rpc('tokend_upload_events_v2', uploadArguments(state.fixture.memberToken, [estimatedEvent]), 'anon')
      if (estimated?.ok !== true || Number(estimated?.inserted ?? 0) !== 1) fail('v2 upload smoke did not insert exactly one event')
      const maliciousEvent = fixtureEvent(`client-cost-${suffix}`, 'gpt-5.6-sol', timestamp, {
        pricingStatus: 'estimated', inputCost: 999, outputCost: 999, reasoningCost: 999,
        cacheReadCost: 999, cacheWriteCost: 999, totalCost: 999,
      })
      const malicious = await http.rpc('tokend_upload_events_v2', uploadArguments(state.fixture.memberToken, [maliciousEvent]), 'anon')
      if (malicious?.ok !== true || Number(malicious?.inserted ?? 0) !== 1) fail('v2 client-cost smoke did not insert exactly one event')
      await verifySmokeRows(http, state.fixture.memberCode, [legacyEvent.id, estimatedEvent.id, maliciousEvent.id])
      const next = {
        ...state,
        fixtureStatusCounts: addCounts(state.fixtureStatusCounts, { legacy: 1, estimated: 2 }),
        uploadSmokeAt: clock().toISOString(),
      }
      await saveState(options.state, next)
      return sanitizeForOutput({ passed: true, timestamp: next.uploadSmokeAt })
    }

    if (command === 'verify-rpcs') {
      if (!state.fixture?.memberToken) fail('Isolated fixture must exist before RPC verification')
      const token = state.fixture.memberToken
      const adminExpected = Boolean(state.appliedMigrationHashes?.['202607100004'])
      const liveAccess = await probeLiveRpcAccess({
        fetch: fetchImpl,
        url: http.base(),
        anonKey: http.key('anon'),
        serviceKey: http.key('service'),
        expectAdmin: adminExpected,
      })
      const report = await collectRpcVerification({
        token,
        liveAccess,
        adminExpected,
        callClient: (name, body) => http.rpc(name, body, 'anon'),
        callLegacy: (name, body) => http.rpc(name, body, 'anon'),
      })
      validateRpcVerification(report, 1e-9)
      return writeSanitized(options.out, { passed: true, rpcCount: CLIENT_RPC_NAMES.length, timestamp: clock().toISOString() }, adapters)
    }

    if (command === 'backfill-create') {
      const existingAttempt = state.backfillCreateAttempt
      if (existingAttempt?.catalogVersion && existingAttempt.catalogVersion !== options.catalog) {
        fail('Backfill create recovery catalog disagrees with the requested catalog')
      }
      const attempt = existingAttempt ?? {
        catalogVersion: options.catalog,
        requestId: randomUUID(),
        attemptedAt: clock().toISOString(),
      }
      if (!attempt.requestId) fail('Backfill create recovery request id is missing')
      if (!existingAttempt) {
        await saveState(options.state, {
          ...state,
          backfillCreateAttempt: attempt,
          transition: 'rollout-active',
        })
      }

      let created
      let createdNew = false
      if (state.backfill?.runId && state.backfill?.phase === 'freezing'
        && state.catalogVersion === options.catalog) {
        created = {
          runId: state.backfill.runId,
          status: 'freezing',
          catalogVersion: options.catalog,
          snapshotAt: state.backfill.snapshotAt,
          baseCatalogVersion: state.backfill.basePointers?.activeCatalog ?? null,
          baseRunId: state.backfill.basePointers?.activeRun ?? null,
          previousCatalogVersion: state.backfill.basePointers?.previousCatalog ?? null,
          previousRunId: state.backfill.basePointers?.previousRun ?? null,
        }
      }
      if (!created) {
        created = await http.rpc('tokend_pricing_create_backfill', {
          p_catalog_version: options.catalog,
          p_create_request_id: attempt.requestId,
        }, 'service')
        createdNew = !existingAttempt
      }
      const runId = created?.runId ?? created?.run_id
      if (!runId) fail('Backfill create returned no run id')
      if (created?.status !== 'freezing' || created?.catalogVersion !== options.catalog
        || typeof created?.snapshotAt !== 'string' || created.snapshotAt.length === 0) {
        fail('Backfill create did not enter the freezing phase')
      }
      const checkpoint = {
        ...state,
        backfillCreateAttempt: attempt,
        catalogVersion: options.catalog,
        backfill: {
          runId,
          phase: 'freezing',
          snapshotAt: created.snapshotAt,
          basePointers: {
            activeCatalog: created.baseCatalogVersion ?? null,
            activeRun: created.baseRunId ?? null,
            previousCatalog: created.previousCatalogVersion ?? null,
            previousRun: created.previousRunId ?? null,
          },
          freeze: {
            limit: null,
            batches: 0,
            scanned: '0',
            captured: '0',
            skipped: '0',
            complete: false,
          },
        },
        transition: 'rollout-active',
      }
      await saveState(options.state, checkpoint)
      const [catalogs, health] = await Promise.all([
        http.json(
          `tokend_pricing_catalogs?select=hash&version=eq.${encodeURIComponent(options.catalog)}`,
          { role: 'service', method: 'GET' },
        ),
        http.rpc('tokend_pricing_health', {}, 'service'),
      ])
      if (!Array.isArray(catalogs) || catalogs.length !== 1 || !catalogs[0].hash) fail('Backfill catalog hash lookup failed')
      if ((health?.activeCatalogVersion ?? null) !== (created.baseCatalogVersion ?? null)
        || (health?.activeRunId ?? null) !== (created.baseRunId ?? null)) {
        fail('Backfill create base pair disagrees with authoritative health')
      }
      const basePointers = {
        activeCatalog: health?.activeCatalogVersion ?? null,
        activeRun: health?.activeRunId ?? null,
        previousCatalog: health?.previousCatalogVersion ?? null,
        previousRun: health?.previousRunId ?? null,
      }
      const next = {
        ...checkpoint,
        catalogVersion: options.catalog,
        catalogHash: catalogs[0].hash,
        backfill: {
          runId,
          phase: 'freezing',
          snapshotAt: created.snapshotAt,
          basePointers,
          freeze: {
            limit: null,
            batches: 0,
            scanned: '0',
            captured: '0',
            skipped: '0',
            complete: false,
          },
        },
        transition: 'rollout-active',
      }
      delete next.backfillCreateAttempt
      await saveState(options.state, next)
      return { phase: 'freezing', status: 'freezing', created: createdNew }
    }

    if (command === 'backfill-freeze') {
      const runId = state.backfill?.runId
      if (!runId) fail('Backfill freeze state is missing')
      const localFreeze = state.backfill?.freeze ?? {}
      if (localFreeze.limit !== undefined && localFreeze.limit !== null && Number(localFreeze.limit) !== options.limit) {
        fail('Backfill freeze must resume with the persisted limit')
      }
      const authoritative = await http.rpc('tokend_pricing_get_backfill', { p_run_id: runId }, 'service')
      if (!['freezing', 'staging'].includes(authoritative?.status)) fail('Backfill freeze database phase is invalid')
      const hydrated = normalizeFreezeProgress(authoritative, 'Authoritative freeze')
      assertNotAhead(localFreeze.scanned ?? 0, hydrated.scanned, 'freeze scannedCount')
      assertNotAhead(localFreeze.captured ?? 0, hydrated.captured, 'freeze frozenCount')
      assertNotAhead(localFreeze.skipped ?? 0, hydrated.skipped, 'freeze skippedCount')
      let current = {
        ...state,
        backfill: {
          ...state.backfill,
          phase: 'freezing',
          freeze: {
            limit: options.limit,
            batches: Number(localFreeze.batches ?? 0),
            ...hydrated,
            updatedAt: clock().toISOString(),
          },
        },
        transition: 'rollout-active',
      }
      await saveState(options.state, current)
      let batchesThisRun = 0
      while (current.backfill.freeze.complete !== true) {
        const previous = current.backfill.freeze
        const response = await retryTransient(
          () => http.rpc('tokend_pricing_freeze_batch', { p_run_id: runId, p_limit: options.limit }, 'service'),
          { maxRetries: 3, sleep },
        )
        const nextProgress = normalizeFreezeProgress(response)
        const previousScanned = decimalCount(previous.scanned, 'Previous freeze scannedCount')
        const previousCaptured = decimalCount(previous.captured, 'Previous freeze frozenCount')
        const previousSkipped = decimalCount(previous.skipped, 'Previous freeze skippedCount')
        const nextScanned = decimalCount(nextProgress.scanned, 'Next freeze scannedCount')
        const nextCaptured = decimalCount(nextProgress.captured, 'Next freeze frozenCount')
        const nextSkipped = decimalCount(nextProgress.skipped, 'Next freeze skippedCount')
        if (nextScanned.value < previousScanned.value
          || nextCaptured.value < previousCaptured.value
          || nextSkipped.value < previousSkipped.value) fail('Backfill freeze returned nonmonotonic progress')
        const scannedThisBatch = nextScanned.value - previousScanned.value
        if (scannedThisBatch > BigInt(options.limit)) fail('Backfill freeze scanned more than the requested limit')
        if (scannedThisBatch === 0n && nextProgress.complete !== true) fail('Backfill freeze made no progress')
        if (response?.scanned !== undefined
          && decimalCount(response.scanned, 'Freeze batch scanned').value > BigInt(options.limit)) {
          fail('Backfill freeze batch scanned more than the requested limit')
        }
        current = {
          ...current,
          backfill: {
            ...current.backfill,
            freeze: {
              limit: options.limit,
              batches: Number(previous.batches ?? 0) + 1,
              ...nextProgress,
              updatedAt: clock().toISOString(),
            },
          },
        }
        await saveState(options.state, current)
        batchesThisRun += 1
        const progress = freezeProgressOutput(current.backfill.freeze)
        await onProgress(progress)
        if (options.interruptAfterBatches && batchesThisRun >= options.interruptAfterBatches
          && current.backfill.freeze.complete !== true) {
          await onProgress({ ...progress, resumeRequired: true })
          throw new ExitCodeError('Backfill freeze intentionally interrupted after persisted progress', 75, true)
        }
      }

      const finalized = await http.rpc('tokend_pricing_finalize_backfill', { p_run_id: runId }, 'service')
      if (finalized?.status !== 'staging') fail('Backfill finalize did not enter staging')
      if (finalized?.catalogVersion !== state.catalogVersion) fail('Backfill finalize catalog changed')
      const targetCount = decimalCount(finalized?.targetCount, 'Finalized targetCount').text
      if (targetCount !== current.backfill.freeze.captured) fail('Backfill finalize targetCount disagrees with frozenCount')
      if (typeof finalized?.targetHash !== 'string' || finalized.targetHash.length === 0) fail('Backfill finalize returned no target hash')
      const basePointers = {
        activeCatalog: finalized.baseCatalogVersion ?? null,
        activeRun: finalized.baseRunId ?? null,
        previousCatalog: state.backfill?.basePointers?.previousCatalog ?? null,
        previousRun: state.backfill?.basePointers?.previousRun ?? null,
      }
      const backfillSnapshot = {
        snapshotAt: finalized.snapshotAt,
        targetCount,
        targetHash: finalized.targetHash,
        baseCatalogVersion: finalized.baseCatalogVersion ?? null,
        baseRunId: finalized.baseRunId ?? null,
        inputTokens: decimalCount(finalized.inputTokens, 'Finalized inputTokens').text,
        outputTokens: decimalCount(finalized.outputTokens, 'Finalized outputTokens').text,
        reasoningTokens: decimalCount(finalized.reasoningTokens, 'Finalized reasoningTokens').text,
        cacheReadTokens: decimalCount(finalized.cacheReadTokens, 'Finalized cacheReadTokens').text,
        cacheWriteTokens: decimalCount(finalized.cacheWriteTokens, 'Finalized cacheWriteTokens').text,
        basePointers,
      }
      current = {
        ...current,
        targetHash: finalized.targetHash,
        backfillSnapshot,
        backfill: {
          ...current.backfill,
          phase: 'pricing',
          freeze: { ...current.backfill.freeze, complete: true },
          pricing: {
            limit: null,
            batches: 0,
            processed: '0',
            target: targetCount,
            remaining: targetCount,
            complete: targetCount === '0',
          },
        },
      }
      await saveState(options.state, current)
      return {
        phase: 'freeze',
        status: 'staging',
        complete: true,
        batchesThisRun,
        scanned: current.backfill.freeze.scanned,
        captured: current.backfill.freeze.captured,
        skipped: current.backfill.freeze.skipped,
        targetCount,
      }
    }

    if (command === 'backfill-run') {
      const runId = state.backfill?.runId
      const localPricing = state.backfill?.pricing
      if (!runId || state.backfill?.phase !== 'pricing' || state.backfill?.freeze?.complete !== true || !localPricing) {
        fail('Backfill pricing requires a finalized freeze')
      }
      if (localPricing.limit !== undefined && localPricing.limit !== null && Number(localPricing.limit) !== options.limit) {
        fail('Backfill pricing must resume with the persisted limit')
      }
      const authoritative = await http.rpc('tokend_pricing_get_backfill', { p_run_id: runId }, 'service')
      if (authoritative?.status !== 'staging' || authoritative?.freezeComplete !== true) {
        fail('Backfill pricing database phase is invalid')
      }
      const target = decimalCount(authoritative.targetCount, 'Authoritative backfill targetCount')
      const processed = decimalCount(authoritative.processedCount ?? authoritative.revisionCount, 'Authoritative backfill processedCount')
      const revisionCount = decimalCount(authoritative.revisionCount, 'Authoritative backfill revisionCount')
      const remaining = decimalCount(authoritative.remainingCount, 'Authoritative backfill remainingCount')
      if (processed.value !== revisionCount.value || processed.value + remaining.value !== target.value) {
        fail('Authoritative backfill counts do not reconcile')
      }
      assertNotAhead(localPricing.processed ?? 0, processed.text, 'backfill processedCount')
      if (localPricing.target !== undefined
        && decimalCount(localPricing.target, 'Local backfill targetCount').value !== target.value) {
        fail('Local backfill targetCount disagrees with authoritative database progress')
      }
      const hydrated = {
        ...state,
        backfill: {
          ...state.backfill,
          pricing: {
            limit: options.limit,
            batches: Number(localPricing.batches ?? 0),
            processed: processed.text,
            target: target.text,
            remaining: remaining.text,
            complete: remaining.value === 0n,
          },
        },
      }
      await saveState(options.state, hydrated)
      const startingBatches = hydrated.backfill.pricing.batches
      const completed = await runBackfillBatches({
        state: hydrated,
        limit: options.limit,
        interruptAfterBatches: options.interruptAfterBatches,
        callBatch: async ({ limit }) => http.rpc('tokend_pricing_backfill_batch', {
          p_run_id: runId,
          p_after_member: '',
          p_after_event: '',
          p_limit: limit,
        }, 'service'),
        saveState: next => saveState(options.state, next),
        sleep,
        onProgress,
      })
      const finalPricing = completed.backfill.pricing
      const finalProcessed = decimalCount(finalPricing.processed, 'Completed backfill processedCount')
      const finalTarget = decimalCount(finalPricing.target, 'Completed backfill targetCount')
      return {
        phase: 'pricing',
        status: authoritative.status,
        complete: finalPricing.complete === true,
        batchesThisRun: finalPricing.batches - startingBatches,
        processed: finalProcessed.text,
        target: finalTarget.text,
        remaining: finalPricing.remaining,
        percent: finalTarget.value === 0n ? 100 : Number((finalProcessed.value * 10000n) / finalTarget.value) / 100,
      }
    }

    if (command === 'late-fixtures') {
      if (!state.fixture?.memberToken) fail('Isolated fixture must exist before late fixtures')
      const catalogVersion = state.catalogVersion ?? state.pointers?.activeCatalog
      if (!catalogVersion) fail('Late fixtures require a staged or active catalog')
      const events = await uploadLateFixtureSet(http, state.fixture.memberToken, randomUUID(), clock().getTime())
      await verifyLateRows(http, state.fixture.memberCode, events, catalogVersion)
      const next = {
        ...state,
        lateFixtureCount: 5,
        lateFixtures: events.map(event => ({ id: event.id, expectedStatus: event.expectedStatus })),
        lateFixtureBatches: [
          ...(state.lateFixtureBatches ?? []),
          { catalogVersion, events: events.map(event => ({ id: event.id, expectedStatus: event.expectedStatus })) },
        ],
        fixtureStatusCounts: addCounts(state.fixtureStatusCounts, {
          estimated: 1, zero_rate: 1, unpriced: 1, reported: 1, legacy: 1,
        }),
        lateFixtureAt: clock().toISOString(),
      }
      await saveState(options.state, next)
      return sanitizeForOutput({ passed: true, lateFixtureCount: 5, statuses: ['known', 'zero', 'unpriced', 'reported', 'legacy'] })
    }

    if (command === 'reconcile') {
      if (!state.backfillSnapshot) fail('Reconcile requires frozen backfill snapshot metadata')
      const report = await http.rpc('tokend_pricing_reconcile', { p_run_id: state.backfill?.runId }, 'service')
      const repeated = await http.rpc('tokend_pricing_reconcile', { p_run_id: state.backfill?.runId }, 'service')
      if (!report?.reconciliationHash || repeated?.reconciliationHash !== report.reconciliationHash) fail('Repeated reconciliation hash is not stable')
      const [backfill, preflight, runRow, catalogs] = await Promise.all([
        http.rpc('tokend_pricing_get_backfill', { p_run_id: state.backfill?.runId }, 'service'),
        http.rpc('tokend_pricing_health', {}, 'service'),
        fetchBackfillRunRow(http, state.backfill?.runId),
        http.json(`tokend_pricing_catalogs?select=hash&version=eq.${encodeURIComponent(state.catalogVersion)}`, { role: 'service', method: 'GET' }),
      ])
      if (!Array.isArray(catalogs) || catalogs.length !== 1 || catalogs[0].hash !== state.catalogHash) fail('Reconciliation catalog hash changed after backfill creation')
      const pointers = {
        activeCatalog: preflight.activeCatalogVersion,
        previousCatalog: preflight.previousCatalogVersion,
        activeRun: preflight.activeRunId,
        previousRun: preflight.previousRunId,
      }
      const authoritative = { ...report, catalogHash: catalogs[0].hash, pointers }
      validateReconciliation(authoritative, { catalogHash: state.catalogHash, pointers })
      if (backfill?.status !== 'reconciled' || runRow.status !== 'reconciled') fail('Backfill did not persist reconciled status')
      assertSameBackfillSnapshot(snapshotFromBackfillRow(runRow, state.backfillSnapshot.basePointers), state.backfillSnapshot)
      if (runRow.reconciliation_hash !== report.reconciliationHash
        || runRow.reconciliation_hash !== repeated.reconciliationHash) fail('Reconciliation hash disagrees with the persisted backfill run')
      if (backfill.catalogVersion !== state.catalogVersion
        || backfill.snapshotAt !== state.backfillSnapshot.snapshotAt
        || exactNonnegativeInteger(backfill.targetCount, 'Backfill status targetCount').text !== state.backfillSnapshot.targetCount
        || exactNonnegativeInteger(backfill.revisionCount, 'Backfill status revisionCount').text !== state.backfillSnapshot.targetCount
        || exactNonnegativeInteger(backfill.remainingCount, 'Backfill status remainingCount').text !== '0') fail('Backfill status disagrees with frozen snapshot')
      if (['activeCatalog', 'activeRun', 'previousCatalog', 'previousRun']
        .some(key => (pointers[key] ?? null) !== (state.backfillSnapshot.basePointers?.[key] ?? null))) {
        fail('Base pricing pointers changed before activation')
      }
      const next = {
        ...state,
        pointers,
        reconciliation: authoritative,
        reconciliationHash: report.reconciliationHash,
        reconciliationAt: clock().toISOString(),
      }
      await saveState(options.state, next)
      return writeSanitized(options.out, { ...authoritative, passed: true }, adapters)
    }

    if (command === 'activation-rehearsal') {
      if (!state.backfill?.runId) fail('Activation rehearsal requires a backfill run')
      if (!state.fixture?.memberToken) fail('Activation rehearsal requires the isolated fixture')
      const result = await runActivationRehearsal({
        runId: state.backfill.runId,
        resume: state.activationRehearsal ?? null,
        checkpoint: activationRehearsal => saveState(options.state, {
          ...state,
          activationRehearsal,
          transition: 'rollout-active',
        }),
        callAdmin: (name, body) => http.rpc(name, { p_run_id: body.runId }, 'service'),
        inspectState: async () => {
          const [preflight, summary] = await Promise.all([
            http.rpc('tokend_pricing_health', {}, 'service'),
            http.rpc('tokend_get_summary_v5', { p_token: state.fixture.memberToken, p_period: 'all', p_timezone: 'Asia/Shanghai' }, 'anon'),
          ])
          return {
            pointers: {
              activeCatalog: preflight.activeCatalogVersion,
              previousCatalog: preflight.previousCatalogVersion,
              activeRun: preflight.activeRunId,
              previousRun: preflight.previousRunId,
            },
            envelope: envelopeFromPayload(summary),
          }
        },
      })
      const persisted = await loadState(options.state)
      const next = {
        ...persisted,
        pointers: result.pointers,
        activationTotals: result.totals,
        activationAt: clock().toISOString(),
      }
      await saveState(options.state, next)
      return writeSanitized(options.out, { passed: true, pointers: result.pointers, totals: result.totals }, adapters)
    }

    if (command === 'rollback-active') {
      const runId = state.backfill?.runId ?? state.pointers?.activeRun
      if (!runId || !state.pointers) fail('Rollback requires the active run and four saved pointers')
      const rolledBack = await http.rpc('tokend_pricing_rollback', { p_run_id: runId }, 'service')
      if (rolledBack?.runId !== runId || !['rolled_back', 'already_rolled_back'].includes(rolledBack?.status)) fail('Rollback did not bind the same run')
      const preflight = await http.rpc('tokend_pricing_health', {}, 'service')
      const pointers = {
        activeCatalog: preflight.activeCatalogVersion,
        previousCatalog: preflight.previousCatalogVersion,
        activeRun: preflight.activeRunId,
        previousRun: preflight.previousRunId,
      }
      const expectedPointers = {
        activeCatalog: state.pointers.previousCatalog,
        previousCatalog: state.pointers.activeCatalog,
        activeRun: state.pointers.previousRun,
        previousRun: state.pointers.activeRun,
      }
      try { equalWithin(pointers, expectedPointers, 0, 'rollback pointers') } catch { fail('Rollback did not swap all four live pointers') }
      const next = { ...state, pointers, rollbackAt: clock().toISOString() }
      await saveState(options.state, next)
      return writeSanitized(options.out, { passed: true, pointers: next.pointers, timestamp: next.rollbackAt }, adapters)
    }

    if (command === 'verify-emergency') {
      const migrationList = await fs.readFile(options.migrationList, 'utf8')
      const legacyProbes = await Promise.all(LEGACY_RPC_NAMES.map(name => probe(http, name, 'anon', accessProbeBody(name))))
      const v2 = await probe(http, 'tokend_upload_events_v2', 'anon', accessProbeBody('tokend_upload_events_v2'))
      const client = await Promise.all(CLIENT_RPC_NAMES.map(async name => ({ name, ...(await probe(http, name, 'anon', accessProbeBody(name))) })))
      const adminNames = [PREFLIGHT_RPC_NAME, ...ADMIN_RPC_NAMES]
      const admin = await Promise.all(adminNames.map(async name => ({ name, ...(await probe(http, name, 'service', accessProbeBody(name))) })))
      const wrapper = await probe(http, 'tokend_upload_events', 'anon', accessProbeBody('tokend_upload_events'))
      const next = validateEmergencySurface({
        state,
        migrationList,
        surface: {
          legacyWrapperPresent: wrapper.present,
          legacyWrapperAllowed: wrapper.allowed,
          legacyRpcNames: LEGACY_RPC_NAMES.filter((_name, index) => legacyProbes[index].present),
          legacyAllowedRpcNames: LEGACY_RPC_NAMES.filter((_name, index) => legacyProbes[index].allowed),
          v2UploadPresent: v2.present,
          vNextRpcNames: client.filter(item => item.present).map(item => item.name),
          adminRpcNames: admin.filter(item => item.present).map(item => item.name),
        },
        now: () => clock().toISOString(),
      })
      await saveState(options.state, next)
      return writeSanitized(options.out, { emergencyVerified: true, forwardRecoveryRequired: true, timestamp: next.emergencyVerifiedAt }, adapters)
    }

    if (command === 'forward-recover') {
      const [migrationList, approval, postSchema, livePostSchema] = await Promise.all([
        fs.readFile(options.migrationList, 'utf8'), readJson(options.approval, fs), fs.readFile(options.postSchema, 'utf8'),
        Promise.resolve().then(() => dumpLinkedSchema()).catch(() => fail('Linked production schema dump failed')),
      ])
      const { reviewedSchema: reviewedSurface } = validateLinkedPostSchema(postSchema, livePostSchema)
      if (!state.fixture?.memberToken) fail('Forward recovery requires the isolated verification fixture')
      const liveAccess = await probeLiveRpcAccess({
        fetch: fetchImpl,
        url: http.base(),
        anonKey: http.key('anon'),
        serviceKey: http.key('service'),
        expectAdmin: true,
      })
      const rpcReport = await collectRpcVerification({
        token: state.fixture.memberToken,
        liveAccess,
        adminExpected: true,
        callClient: (name, body) => http.rpc(name, body, 'anon'),
        callLegacy: (name, body) => http.rpc(name, body, 'anon'),
      })
      validateRpcVerification(rpcReport, 1e-9)
      const liveSurface = {
        legacyWrapperPresent: liveAccess.anonAllowed.includes('tokend_upload_events'),
        v2UploadPresent: liveAccess.anonAllowed.includes('tokend_upload_events_v2'),
        clientRpcNames: liveAccess.anonAllowed.filter(name => CLIENT_RPC_NAMES.includes(name)),
        adminRpcNames: liveAccess.serviceAllowed.filter(name => ADMIN_RPC_NAMES.includes(name)),
        securityDefinerNames: reviewedSurface.securityDefinerNames,
        searchPathNames: reviewedSurface.searchPathNames,
        anonExecuteNames: liveAccess.anonAllowed.filter(name => name !== 'tokend_upload_events'),
        serviceExecuteNames: liveAccess.serviceAllowed,
      }
      const next = await validateForwardRecovery({
        state, migrationList, migrationsDir: options.migrationsDir, migrationFile: options.migrationFile,
        approval, postSchema, livePostSchema, liveSurface, fs, now: () => clock().toISOString(),
      })
      await saveState(options.state, next)
      return writeSanitized(options.out, {
        forwardRecoveryRequired: false,
        recoveryVersion: next.recoveryVersion,
        recoveryHash: next.recoveryHash,
        recoveryTime: next.recoveryTime,
        transition: next.transition,
      }, adapters)
    }

    if (command === 'monitor') {
      const [baselineGlobal, baselineRpc] = await Promise.all([
        readJson(options.globalBaseline, fs), readJson(options.rpcBaseline, fs),
      ])
      if (baselineGlobal?.authoritative !== true) fail('Monitor requires an authoritative global baseline')
      if (baselineGlobal.source !== 'frozen_reconciled_run') fail('Monitor baseline source must be frozen_reconciled_run')
      if (!state.pointers || baselineGlobal.activeCatalogVersion !== (state.pointers.activeCatalog ?? null)) {
        fail('Monitor baseline active catalog does not match private state')
      }
      if (!state.catalogHash || baselineGlobal.catalogHash !== state.catalogHash) {
        fail('Monitor baseline catalog hash does not match private state')
      }
      if (!state.reconciliationHash || baselineGlobal.reconciliationHash !== state.reconciliationHash) {
        fail('Monitor baseline reconciliation hash does not match private state')
      }
      if (baselineGlobal.pointerBindingHash !== pricingPointerBindingHash(state.pointers)) {
        fail('Monitor baseline pointer binding does not match private state')
      }
      if (!Number.isSafeInteger(Number(baselineGlobal.eligibleEventCount))
        || Number(baselineGlobal.eligibleEventCount) < 0) {
        fail('Monitor baseline eligible event count is invalid')
      }
      const token = state.fixture?.memberToken
      if (!token) fail('Monitor requires an isolated fixture')
      let fixtureStatusCounts = { ...(state.fixtureStatusCounts ?? {}) }
      let fixtureEventCount = Object.values(fixtureStatusCounts).reduce((sum, value) => sum + Number(value), 0)
      const activeCatalogVersion = state.pointers?.activeCatalog ?? state.catalogVersion
      if (!activeCatalogVersion) fail('Monitor requires the active pricing catalog')
      const monitoredBatches = structuredClone(state.lateFixtureBatches ?? (
        state.lateFixtures?.length === 5
          ? [{ catalogVersion: activeCatalogVersion, events: state.lateFixtures }]
          : []
      ))
      const monitorRpcBaseline = {
        ...baselineRpc,
        reconciliationHash: state.reconciliationHash ?? state.reconciliation?.reconciliationHash,
        pointers: state.pointers,
      }
      if (!monitorRpcBaseline.reconciliationHash || !monitorRpcBaseline.pointers) fail('Monitor requires the current reconciled hash and pricing pointers in private state')
      const baselineCount = exactNonnegativeInteger(monitorRpcBaseline.count, 'Monitor RPC baseline count').number
      const baselineHttpErrors = exactNonnegativeInteger(monitorRpcBaseline.httpErrorCount, 'Monitor RPC baseline HTTP errors').number
      const baselineJsonErrors = exactNonnegativeInteger(monitorRpcBaseline.jsonErrorCount, 'Monitor RPC baseline JSON errors').number
      if (baselineCount === null || baselineCount === 0 || baselineHttpErrors === null || baselineJsonErrors === null
        || baselineHttpErrors > baselineCount || baselineJsonErrors > baselineCount
        || !Number.isFinite(Number(monitorRpcBaseline.p95Seconds)) || Number(monitorRpcBaseline.p95Seconds) < 0) {
        fail('Monitor RPC baseline is invalid')
      }
      const rpcSamples = {
        legacy: { count: 0, httpErrorCount: 0, jsonErrorCount: 0, latencies: [] },
        vNext: { count: 0, httpErrorCount: 0, jsonErrorCount: 0, latencies: [] },
      }
      const sampleMonitorRpc = async (generation, name) => {
        const report = rpcSamples[generation]
        const started = clock().getTime()
        const response = await http.raw(`rpc/${name}`, { role: 'anon', body: { p_token: token } })
        report.latencies.push(Math.max(0, clock().getTime() - started) / 1000)
        report.count += 1
        if (!response.ok) report.httpErrorCount += 1
        else {
          try {
            const payload = await response.json()
            if (payload?.ok !== true) report.jsonErrorCount += 1
          } catch {
            report.jsonErrorCount += 1
          }
        }
        return {
          count: report.count,
          httpErrorCount: report.httpErrorCount,
          jsonErrorCount: report.jsonErrorCount,
          p95Seconds: percentile95(report.latencies),
        }
      }
      let knownLateCount = monitoredBatches.reduce((sum, batch) => sum + batch.events.length, 0)
      const startingGlobal = await http.rpc(PREFLIGHT_RPC_NAME, {}, 'service')
      if (startingGlobal?.authoritative !== true) fail('Monitor starting preflight is not authoritative')
      const result = await runMonitorLoop({
        durationSeconds: options.duration,
        intervalSeconds: options.interval,
        lateUploadEverySeconds: options.lateUploadEvery,
        baselineGlobal,
        baselineRpc: monitorRpcBaseline,
        collectSnapshot: async () => {
          // Match the production dashboard scheduler: keep expensive summary
          // reads sequential so the monitor measures live health without
          // creating an artificial burst on the shared usage relation.
          const legacyRpc = await sampleMonitorRpc('legacy', 'tokend_get_summary_v4')
          const vNextRpc = await sampleMonitorRpc('vNext', 'tokend_get_summary_v5')
          const health = await http.rpc('tokend_pricing_health', {}, 'service')
          const startingPostSnapshot = Number(startingGlobal.postSnapshotEventCount ?? 0)
          const healthPostSnapshot = Number(health?.postSnapshotEventCount ?? startingPostSnapshot)
          if (healthPostSnapshot < startingPostSnapshot) fail('Monitor health postSnapshotEventCount regressed')
          const global = {
            postSnapshotEventCount: healthPostSnapshot,
            activeReconciliationHash: health?.activeReconciliationHash ?? startingGlobal.activeReconciliationHash,
            activeCatalogVersion: health?.activeCatalogVersion ?? startingGlobal.activeCatalogVersion,
            activeRunId: health?.activeRunId ?? startingGlobal.activeRunId,
            previousCatalogVersion: health?.previousCatalogVersion ?? startingGlobal.previousCatalogVersion,
            previousRunId: health?.previousRunId ?? startingGlobal.previousRunId,
          }
          let fixtureHealth = { known: true, zero: true, unpriced: true, reported: true, legacy: true }
          for (const batch of monitoredBatches) {
            const health = await verifyLateRows(http, state.fixture.memberCode, batch.events, batch.catalogVersion)
            fixtureHealth = Object.fromEntries(Object.keys(fixtureHealth).map(key => [key, fixtureHealth[key] && health[key]]))
          }
          const pointers = {
            activeCatalog: global.activeCatalogVersion ?? null,
            activeRun: global.activeRunId ?? null,
            previousCatalog: global.previousCatalogVersion ?? null,
            previousRun: global.previousRunId ?? null,
          }
          return {
            legacyHealthy: true,
            vNextHealthy: true,
            legacyRpc,
            vNextRpc,
            global: {
              coverageAuthoritative: false,
              eligibleEventCount: Number(baselineGlobal.eligibleEventCount ?? 0) + fixtureEventCount,
              knownFixtureCount: fixtureEventCount,
              status: baselineGlobal.status,
              unpricedShare: Number(baselineGlobal.maxUnpricedShare ?? 0),
              membersOver2x: Number(baselineGlobal.membersOver2x ?? 0),
              postSnapshotEventCount: Number(global.postSnapshotEventCount ?? 0),
              knownLateCount,
            },
            fixtureHealth,
            reconciliationHash: global.activeReconciliationHash ?? 'not_present',
            pointers,
          }
        },
        uploadLateFixture: async () => {
          const events = await uploadLateFixtureSet(http, token, randomUUID(), clock().getTime())
          monitoredBatches.push({
            catalogVersion: activeCatalogVersion,
            events: events.map(event => ({ id: event.id, expectedStatus: event.expectedStatus })),
          })
          fixtureStatusCounts = addCounts(fixtureStatusCounts, {
            estimated: 1, zero_rate: 1, unpriced: 1, reported: 1, legacy: 1,
          })
          fixtureEventCount += 5
          knownLateCount += 5
          await saveState(options.state, {
            ...state,
            fixtureStatusCounts,
            lateFixtureCount: monitoredBatches.reduce((sum, batch) => sum + batch.events.length, 0),
            lateFixtures: monitoredBatches.at(-1).events,
            lateFixtureBatches: monitoredBatches,
            monitorUpdatedAt: clock().toISOString(),
          })
        },
        sleep,
      })
      const endingGlobal = await http.rpc(PREFLIGHT_RPC_NAME, {}, 'service')
      if (endingGlobal?.authoritative !== true) fail('Monitor ending preflight is not authoritative')
      const lastSample = result.samples.at(-1)
      if (!lastSample) fail('Monitor produced no health samples')
      const finalAdjustedCount = Math.max(0, Number(endingGlobal.eligibleEventCount ?? 0) - fixtureEventCount)
      const finalAdjustedCounts = subtractCounts(endingGlobal.statusCounts, fixtureStatusCounts)
      const finalPointers = {
        activeCatalog: endingGlobal.activeCatalogVersion ?? null,
        activeRun: endingGlobal.activeRunId ?? null,
        previousCatalog: endingGlobal.previousCatalogVersion ?? null,
        previousRun: endingGlobal.previousRunId ?? null,
      }
      const finalFixtureMembersOver2x = await fixtureMembersOver2xContribution(
        http, state.fixture.memberCode, finalPointers.activeCatalog, finalPointers.previousCatalog,
      )
      validateMonitorSnapshot({
        legacyHealthy: true,
        vNextHealthy: true,
        legacyRpc: lastSample.legacyRpc,
        vNextRpc: lastSample.vNextRpc,
        global: {
          eligibleEventCount: Number(endingGlobal.eligibleEventCount ?? 0),
          knownFixtureCount: fixtureEventCount,
          status: coverageFromCounts(finalAdjustedCount, finalAdjustedCounts),
          unpricedShare: finalAdjustedCount > 0 ? Number(finalAdjustedCounts.unpriced ?? 0) / finalAdjustedCount : 0,
          membersOver2x: Number(endingGlobal.membersOver2xCount ?? 0) - finalFixtureMembersOver2x,
          postSnapshotEventCount: Number(endingGlobal.postSnapshotEventCount ?? 0),
          knownLateCount,
        },
        fixtureHealth: lastSample.fixtureHealth,
        reconciliationHash: endingGlobal.activeReconciliationHash ?? 'not_present',
        pointers: finalPointers,
      }, baselineGlobal, monitorRpcBaseline)
      return writeSanitized(options.out, result, adapters)
    }

    if (command === 'cleanup') {
      const next = await deleteFixtureData({ state, http, includeMember: true, timestamp: clock().toISOString() })
      await saveState(options.state, next)
      return sanitizeForOutput({ cleaned: true, timestamp: clock().toISOString() })
    }

    fail(`Subcommand is not implemented: ${command}`)
  }

  return {
    execute,
    abort() {
      abortController.abort()
    },
    async cleanupOnFailure(stateFile) {
      if (!stateFile) return
      const state = await loadState(stateFile)
      if (state.fixtureCandidate || state.backfillCreateAttempt || state.backfill?.runId || (
        state.activationRehearsal?.phase && state.activationRehearsal.phase !== 'reactivated'
      )) return
      const next = await deleteFixtureData({
        state, http, includeMember: true, preserveBackfill: true, timestamp: clock().toISOString(),
      })
      await saveState(stateFile, next)
    },
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const parsed = parseCli(argv)
  const runner = createRolloutRunner(dependencies)
  let shuttingDown = false
  const cleanupAndExit = async (reason, exitCode) => {
    if (shuttingDown) return
    shuttingDown = true
    try { await runner.cleanupOnFailure(parsed.options.state) } catch {}
    if (reason) process.stderr.write(`${reason}\n`)
    process.exitCode = exitCode
  }
  const signal = name => {
    if (shuttingDown) return
    shuttingDown = true
    runner.abort()
    process.stderr.write(`Rollout interrupted by ${name}\n`)
    process.exitCode = 130
  }
  const exception = error => {
    if (error?.intentional && error?.exitCode === 75) { process.exitCode = 75; return }
    runner.abort()
    void cleanupAndExit('Rollout terminated by an unexpected error', 1)
  }
  process.once('SIGINT', () => signal('SIGINT'))
  process.once('SIGTERM', () => signal('SIGTERM'))
  process.once('uncaughtException', exception)
  process.once('unhandledRejection', exception)
  try {
    const result = await runner.execute(parsed.command, parsed.options)
    if (shuttingDown) return
    if (result !== undefined) process.stdout.write(`${JSON.stringify(sanitizeForOutput(result))}\n`)
  } catch (error) {
    if (shuttingDown) return
    if (error?.intentional && error?.exitCode === 75) {
      process.exitCode = 75
      return
    }
    await cleanupAndExit(error instanceof ExitCodeError ? error.message : 'Rollout command failed', error?.exitCode ?? 1)
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) void main()
