#!/usr/bin/env node

import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto'
import * as nodeFs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const MANAGED_MIGRATION_VERSIONS = Object.freeze([
  '202607100001', '202607100002', '202607100003', '202607100004',
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
  'tokend_pricing_backfill_batch',
  'tokend_pricing_reconcile',
  'tokend_pricing_activate',
  'tokend_pricing_rollback',
  'tokend_pricing_get_backfill',
])
export const ADMIN_RPC_SIGNATURES = Object.freeze({
  tokend_pricing_create_backfill: 'TEXT',
  tokend_pricing_backfill_batch: 'UUID, TEXT, TEXT, INTEGER',
  tokend_pricing_reconcile: 'UUID',
  tokend_pricing_activate: 'UUID',
  tokend_pricing_rollback: 'UUID',
  tokend_pricing_get_backfill: 'UUID',
})
export const PREFLIGHT_RPC_NAME = 'tokend_pricing_preflight'

const spec = (required, optional = [], numeric = [], array = [], boolean = []) => ({ required, optional, numeric, array, boolean })
export const COMMAND_SPECS = Object.freeze({
  'wrapper-gate': spec(['live-schema', 'rollback-sql', 'state', 'out']),
  'migration-manifest': spec(['files', 'state', 'out'], [], [], ['files']),
  'migration-gate': spec(['migration-list', 'migrations-dir', 'state', 'phase', 'out']),
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
  if (command === 'backfill-run' && options.limit > 5000) fail('--limit must be at most 5000')
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
  const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))
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

function signatureTypes(parameterText) {
  return parameterText.split(',').map(parameter => {
    const withoutDefault = parameter.replace(/\s+DEFAULT[\s\S]*$/i, '')
    const words = withoutDefault.trim().toLowerCase().replace(/\bpg_catalog\./g, '').split(/\s+/)
    return words.at(-1)
  })
}

const WRAPPER_SIGNATURE = 'public.tokend_upload_events(text,jsonb,jsonb)'

export function extractExactUploadWrapper(sql) {
  const statements = []
  scanSql(sql, statement => statements.push(canonicalizeSql(statement)))
  const wrappers = []
  const aclTuples = []
  for (const statement of statements) {
    const header = /^CREATE(?: OR REPLACE)? FUNCTION\s+public\.tokend_upload_events\s*\(([\s\S]*?)\)\s*RETURNS\b/i.exec(statement)
    if (header && signatureTypes(header[1]).join(',') === 'text,jsonb,jsonb') wrappers.push(statement)
    const acl = /^(GRANT\s+EXECUTE|REVOKE\s+(?:ALL|EXECUTE))\s+ON\s+FUNCTION\s+public\.tokend_upload_events\s*\(([^)]*)\)\s+(TO|FROM)\s+([^;]+);?$/i.exec(statement)
    if (acl && signatureTypes(acl[2]).join(',') === 'text,jsonb,jsonb') {
      const action = acl[1].toUpperCase().startsWith('GRANT') ? 'GRANT' : 'REVOKE'
      for (const rawRole of acl[4].split(',')) {
        const role = rawRole.trim().replace(/^"|"$/g, '')
        aclTuples.push(`${action}:${/^public$/i.test(role) ? 'PUBLIC' : role}`)
      }
    }
  }
  if (wrappers.length === 0) fail('Exact wrapper definition missing')
  if (wrappers.length !== 1) fail('Exact wrapper definition is ambiguous')
  const definition = wrappers[0]
  return {
    signature: WRAPPER_SIGNATURE,
    definition,
    hash: sha256(definition),
    aclTuples: aclTuples.sort(),
    aclHash: sha256(JSON.stringify(aclTuples.sort())),
  }
}

export function compareWrapperDefinitions(liveSql, reviewedSql) {
  const live = extractExactUploadWrapper(liveSql)
  const reviewed = extractExactUploadWrapper(reviewedSql)
  if (live.hash !== reviewed.hash) fail('Wrapper definition hash mismatch')
  if (JSON.stringify(live.aclTuples) !== JSON.stringify(reviewed.aclTuples)) fail('Wrapper ACL mismatch')
  return {
    wrapperGatePassed: true,
    wrapperHash: live.hash,
    aclHash: live.aclHash,
    roleNames: [...new Set(live.aclTuples.map(tuple => tuple.slice(tuple.indexOf(':') + 1)))].sort(),
  }
}

const sensitiveKey = key => /(?:secret|prompt|payload|^raw|provider.*url)|^(?:authorization|apiKey|apikey|serviceKey|anonKey|token|memberToken|memberCode|memberId|eventId|sessionId|body|id|ids|members?|events?|sessions?|fixtures?|(?:member|event|session|fixture)Ids)$/i.test(key)

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
  'fixture-create', 'fixture-reset', 'upload-smoke', 'backfill-create', 'backfill-run',
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

export function parseMigrationList(text) {
  const rows = []
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.includes('|') || /^\s*(?:Local|-)/i.test(line)) continue
    const [local = '', remote = ''] = line.split('|').map(part => part.trim())
    if (!local && !remote) continue
    if ((local && !/^\d{12,14}$/.test(local)) || (remote && !/^\d{12,14}$/.test(remote))) fail('Migration list contains an invalid local/remote row')
    rows.push({ local, remote })
  }
  if (rows.length === 0) fail('Migration list contains no version rows')
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

export async function validateMigrationGate({ state, migrationList, migrationsDir, phase, fs = nodeFs, now = () => new Date().toISOString() }) {
  if (!['pre', 'post'].includes(phase)) fail('Migration gate phase must be pre or post')
  const rows = parseMigrationList(migrationList)
  for (const row of rows) {
    if (!row.local || !row.remote || row.local !== row.remote) fail(`Migration local/remote mismatch at ${row.local || row.remote}`)
  }
  const listed = rows.map(row => row.local)
  const history = [...(state.migrationGateHistory ?? [])]
  if (phase === 'pre') {
    if (listed.includes(EMERGENCY_VERSION)) fail('Emergency migration cannot be part of a normal pre baseline')
    history.push({
      phase: 'pre',
      versions: listed,
      historyHash: sha256(JSON.stringify(listed)),
      timestamp: now(),
    })
    return {
      ...state,
      migrationBaselineVersions: listed,
      migrationBaselineHash: sha256(JSON.stringify(listed)),
      migrationGateHistory: history,
      transition: 'migrations-consistent',
    }
  }
  const baseline = state.migrationBaselineVersions
  if (!Array.isArray(baseline)) fail('Post migration gate requires a recorded pre baseline')
  for (const version of baseline) if (!listed.includes(version)) fail(`Migration history lost baseline version ${version}`)
  const staged = await filesByVersion(migrationsDir, fs)
  const appliedMigrationHashes = { ...(state.appliedMigrationHashes ?? {}) }
  for (const version of Object.keys(appliedMigrationHashes)) if (!listed.includes(version)) fail(`Migration history lost applied version ${version}`)
  const rolloutVersions = listed.filter(version => !baseline.includes(version))
  for (const version of rolloutVersions) {
    const planned = state.plannedMigrationHashes?.[version]
    if (!planned) fail(`Migration ${version} was not preplanned in a manifest`)
    const file = staged.get(version)
    if (!file) fail(`Staged migration file missing for ${version}`)
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
  const sticky = state.forwardRecoveryRequired === true || listed.includes(EMERGENCY_VERSION)
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
  for (const name of surfaceNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const definitions = statements.filter(statement => new RegExp(`^CREATE(?: OR REPLACE)? FUNCTION public\\.${escaped}\\s*\\(`, 'i').test(statement))
    if (definitions.length !== 1 || !/\bSECURITY DEFINER\b/i.test(definitions[0])
      || !/\bSET search_path (?:=|TO) '?public'?, '?pg_temp'?(?:\s|$)/i.test(definitions[0])) {
      fail(`Post schema is missing exact security/search_path for ${name}`)
    }
    const header = new RegExp(`^CREATE(?: OR REPLACE)? FUNCTION public\\.${escaped}\\s*\\(([\\s\\S]*?)\\)\\s*RETURNS`, 'i').exec(definitions[0])
    const actualTypes = header?.[1].trim() ? signatureTypes(header[1]).join(',') : ''
    const expectedTypes = signatures[name].trim() ? signatureTypes(signatures[name]).join(',') : ''
    if (actualTypes !== expectedTypes) fail(`Post schema signature mismatch for ${name}`)
    const grants = []
    for (const statement of statements) {
      const match = new RegExp(`^GRANT EXECUTE ON FUNCTION public\\.${escaped}\\s*\\(([^)]*)\\) TO ([^;]+);?$`, 'i').exec(statement)
      if (match) {
        const aclTypes = match[1].trim() ? signatureTypes(match[1]).join(',') : ''
        if (aclTypes !== expectedTypes) fail(`Post schema grant signature mismatch for ${name}`)
        grants.push(...match[2].split(',').map(role => role.trim()))
      }
    }
    const expected = ADMIN_RPC_NAMES.includes(name) || name === PREFLIGHT_RPC_NAME ? ['service_role'] : ['anon', 'authenticated']
    if (!sameSet(grants, expected)) fail(`Post schema grant mismatch for ${name}`)
    const revokedRoles = []
    for (const statement of statements) {
      const match = new RegExp(`^REVOKE ALL ON FUNCTION public\\.${escaped}\\s*\\(([^)]*)\\) FROM ([^;]+);?$`, 'i').exec(statement)
      if (!match) continue
      const aclTypes = match[1].trim() ? signatureTypes(match[1]).join(',') : ''
      if (aclTypes !== expectedTypes) fail(`Post schema revoke signature mismatch for ${name}`)
      revokedRoles.push(...match[2].split(',').map(role => role.trim()))
    }
    if (!sameSet(revokedRoles, ['PUBLIC', 'anon', 'authenticated', 'service_role'])) fail(`Post schema grant revocation is missing for ${name}`)
  }
  return {
    securityDefinerNames: surfaceNames,
    searchPathNames: surfaceNames,
  }
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
  state, migrationList, migrationsDir, migrationFile, approval, postSchema, liveSurface,
  fs = nodeFs, now = () => new Date().toISOString(),
}) {
  if (state.forwardRecoveryRequired !== true) fail('Forward recovery is not currently required')
  if (state.emergencyVerified !== true) fail('Emergency verification must complete first')
  const rows = parseMigrationList(migrationList)
  const versions = rows.map(row => {
    if (row.local !== row.remote) fail('Recovery migration local/remote mismatch')
    return row.local
  })
  for (const version of MANAGED_MIGRATION_VERSIONS) if (!versions.includes(version)) fail('Recovery history must retain managed migration 001 through 004')
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
  validateReviewedPostSchema(postSchema)
  validateRecoveredLiveSurface(liveSurface)
  return {
    ...state,
    forwardRecoveryRequired: false,
    recoveryVersion: version,
    recoveryHash: hash,
    recoveryTime: now(),
    transition: 'newly-reviewed-forward-recovered',
  }
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
  if (name === 'tokend_pricing_create_backfill') return { p_catalog_version: '__rollout_acl_probe__' }
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

export async function runBackfillBatches({
  state, limit, interruptAfterBatches, callBatch, saveState, sleep, cleanup,
}) {
  assertCommandAllowed(state, 'backfill-run')
  let current = structuredClone(state)
  let batchesThisRun = 0
  try {
    while (current.backfill?.remaining !== 0) {
      const previousMember = String(current.backfill?.cursorMember ?? '')
      const previousEvent = String(current.backfill?.cursorEvent ?? '')
      const previousRemaining = Number(current.backfill?.remaining ?? Number.MAX_SAFE_INTEGER)
      const result = await retryTransient(
        () => callBatch({ afterMember: previousMember, afterEvent: previousEvent, limit }),
        { maxRetries: 3, sleep },
      )
      const processed = Number(result.processed ?? 0)
      const nextMember = result.nextMember ?? previousMember
      const nextEvent = result.nextEvent ?? previousEvent
      const nextRemaining = Number(result.remainingCount)
      const tupleOrder = String(nextMember).localeCompare(previousMember) || String(nextEvent).localeCompare(previousEvent)
      if ((processed > 0 && tupleOrder <= 0) || (processed === 0 && nextRemaining > 0)) fail('Backfill returned a nonmonotonic cursor')
      if (!Number.isFinite(nextRemaining) || nextRemaining < 0 || nextRemaining > previousRemaining) fail('Backfill returned nonmonotonic remaining work')
      current = {
        ...current,
        backfill: {
          ...(current.backfill ?? {}),
          cursorMember: String(nextMember),
          cursorEvent: String(nextEvent),
          remaining: nextRemaining,
          batches: Number(current.backfill?.batches ?? 0) + 1,
          processed: Number(current.backfill?.processed ?? 0) + processed,
        },
        transition: 'rollout-active',
      }
      await saveState(current)
      batchesThisRun += 1
      if (interruptAfterBatches && batchesThisRun >= interruptAfterBatches && nextRemaining > 0) {
        throw new ExitCodeError('Backfill intentionally interrupted after persisted cursor', 75, true)
      }
    }
    return current
  } catch (error) {
    if (!error?.intentional && cleanup) await cleanup()
    throw error
  }
}

export async function runActivationRehearsal({ runId, callAdmin, inspectState }) {
  const beforeState = await inspectState()
  assertEnvelope(beforeState.envelope, 'pre-activation fixture summary')
  const first = await callAdmin('tokend_pricing_activate', { runId })
  if (first.runId !== runId || first.status !== 'active') fail('Activation did not bind the requested run')
  const firstState = await inspectState()
  const rollback = await callAdmin('tokend_pricing_rollback', { runId })
  if (rollback.runId !== runId || !['rolled_back', 'already_rolled_back'].includes(rollback.status)) fail('Paired rollback did not bind the requested run')
  const rollbackState = await inspectState()
  const second = await callAdmin('tokend_pricing_activate', { runId })
  if (second.runId !== runId || second.status !== 'active') fail('Reactivation did not use the same run')
  const secondState = await inspectState()
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
    if (Number(report[counter]) !== 0) fail(`Reconciliation ${counter} must be zero`)
  }
  if (Number(report.targetCount) !== Number(report.revisionCount)) fail('Reconciliation targetCount must equal revisionCount')
  if (typeof report.reconciliationHash !== 'string' || report.reconciliationHash.length === 0) fail('Reconciliation authoritative hash is missing')
  if (report.catalogHash !== expected.catalogHash) fail('Reconciliation catalog hash mismatch')
  try { equalWithin(report.pointers, expected.pointers, 0, 'reconciliation pointers') } catch { fail('Reconciliation pointer mismatch') }
  return { passed: true }
}

function validateMonitorSnapshot(snapshot, baselineGlobal, baselineRpc) {
  if (!snapshot.legacyHealthy || !snapshot.vNextHealthy) fail('Legacy/vNext monitor health failed')
  const adjustedCount = Number(snapshot.global?.eventCount ?? 0) - Number(snapshot.global?.knownFixtureCount ?? 0)
  if (adjustedCount < Number(baselineGlobal.eventCount ?? 0)) fail('Adjusted global event count regressed')
  const coverageRank = { unpriced: 0, partial: 1, legacy: 2, zero_rate: 3, complete: 4, no_usage: 4 }
  if (!Object.hasOwn(coverageRank, snapshot.global?.status) || !Object.hasOwn(coverageRank, baselineGlobal.status)
    || coverageRank[snapshot.global.status] < coverageRank[baselineGlobal.status]) fail('Global coverage status regressed')
  if (Number(snapshot.global?.unpricedShare ?? 0) > Number(baselineGlobal.maxUnpricedShare ?? 0)) fail('Global unpriced share exceeded baseline')
  if (Number(snapshot.global?.membersOver2x ?? 0) > Number(baselineGlobal.membersOver2x ?? 0)) fail('membersOver2x exceeded baseline')
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
  while (true) {
    const snapshot = await collectSnapshot()
    validateMonitorSnapshot(snapshot, baselineGlobal, baselineRpc)
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
    try { return await response.json() } catch { fail('HTTP response was not valid JSON') }
  }
  if (response.status === 404) {
    try {
      const failure = await response.json()
      if (failure?.code === 'PGRST202') return null
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
].join(',')

async function fetchBackfillRunRow(http, runId) {
  const rows = await http.json(
    `tokend_pricing_backfill_runs?select=${BACKFILL_SNAPSHOT_SELECT}&run_id=eq.${encodeURIComponent(runId)}`,
    { role: 'service', method: 'GET' },
  )
  if (!Array.isArray(rows) || rows.length !== 1) fail('Authoritative backfill run lookup failed')
  return rows[0]
}

function snapshotFromBackfillRow(row) {
  return {
    snapshotAt: row.snapshot_at,
    targetCount: Number(row.target_count),
    targetHash: row.target_hash,
    baseCatalogVersion: row.base_catalog_version ?? null,
    baseRunId: row.base_backfill_run_id ?? null,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    reasoningTokens: Number(row.reasoning_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
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

async function deleteFixtureData({ state, http, includeMember, timestamp }) {
  const memberCode = state.fixture?.memberCode
  if (!memberCode) return state
  const filter = `member_code=eq.${encodeURIComponent(memberCode)}`
  const optionalAdditive = async operation => {
    try { return await operation() } catch (error) {
      if (error?.status === 404 && error?.sqlstate === 'PGRST202') return null
      throw error
    }
  }
  const targets = await optionalAdditive(() => http.json(`tokend_pricing_backfill_targets?select=member_code&${filter}`, { role: 'service', method: 'GET' }))
  if (Array.isArray(targets) && targets.length > 0) fail('Fixture is part of an immutable backfill target; cleanup is unsafe')
  const tables = [
    ['tokend_event_cost_revisions', true], ['tokend_pricing_shadow_sessions', true],
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
    delete next.backfill
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

export function createRolloutRunner(dependencies = {}) {
  const env = dependencies.env ?? process.env
  const fs = dependencies.fs ?? nodeFs
  const fetchImpl = dependencies.fetch ?? globalThis.fetch
  const clock = dependencies.clock ?? (() => new Date())
  const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const randomUUID = dependencies.randomUUID ?? nodeRandomUUID
  if (typeof fetchImpl !== 'function') fail('A fetch adapter is required')
  const adapters = {
    fs,
    randomUUID,
    secretValues: [env.SUPABASE_SERVICE_KEY, env.SUPABASE_ANON_KEY].filter(Boolean),
  }
  const http = createHttpAdapter({ env, fetch: fetchImpl })

  const loadState = async file => {
    try { return await readJson(file, fs) } catch (error) {
      if (error?.code === 'ENOENT') return {}
      fail('Private rollout state could not be read')
    }
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
        now: () => clock().toISOString(),
      })
      await saveState(options.state, next)
      return writeSanitized(options.out, {
        phase: options.phase,
        transition: next.transition,
        forwardRecoveryRequired: next.forwardRecoveryRequired === true,
        appliedMigrationHashes: next.appliedMigrationHashes,
        timestamp: clock().toISOString(),
      }, adapters)
    }

    if (command === 'preflight') {
      const { SUPABASE_URL } = requireEnvironment(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'])
      const [rows, legacyPriceRows, adminBaseline] = await Promise.all([fetchAllPages({
        fetch: fetchImpl,
        url: `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/tokend_usage_events?select=model,total_tokens,total_cost,member_code`,
        headers: http.headers('service'),
        pageSize: 1000,
      }), fetchAllPages({
        fetch: fetchImpl,
        url: `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/tokend_model_prices?select=model_id,input_price,output_price,cache_read_price,cache_write_price`,
        headers: http.headers('service'),
        pageSize: 1000,
      }), optionalPostgrestRpc(http, PREFLIGHT_RPC_NAME, {}, 'service')])
      const eligibleRows = rows.filter(row => Number(row.total_tokens ?? 0) > 0)
      const zeroCostRows = eligibleRows.filter(row => Number(row.total_cost ?? 0) === 0)
      const zeroCostRollup = new Map()
      for (const row of zeroCostRows) {
        const model = row.model ?? 'unknown'
        const current = zeroCostRollup.get(model) ?? { model, eventCount: 0, totalTokens: 0 }
        current.eventCount += 1
        current.totalTokens += Number(row.total_tokens ?? 0)
        zeroCostRollup.set(model, current)
      }
      const zeroCostByModel = [...zeroCostRollup.values()].sort((left, right) => right.eventCount - left.eventCount || left.model.localeCompare(right.model))
      const statusCounts = { legacy: eligibleRows.length - zeroCostRows.length, unpriced: zeroCostRows.length }
      const pointer = value => value ?? 'not_present'
      if (adminBaseline?.eventCount !== undefined && Number(adminBaseline.eventCount) !== rows.length) fail('Paginated event count disagrees with preflight')
      if (adminBaseline?.legacyPriceRowCount !== undefined && Number(adminBaseline.legacyPriceRowCount) !== legacyPriceRows.length) fail('Paginated legacy price count disagrees with preflight')
      if (adminBaseline?.eligibleEventCount !== undefined && Number(adminBaseline.eligibleEventCount) !== eligibleRows.length) fail('Paginated eligible event count disagrees with preflight')
      if (adminBaseline?.eligibleZeroCostEventCount !== undefined && Number(adminBaseline.eligibleZeroCostEventCount) !== zeroCostRows.length) fail('Paginated eligible zero-cost count disagrees with preflight')
      const effectiveStatusCounts = adminBaseline?.statusCounts ?? statusCounts
      const effectiveUnpricedCount = Number(adminBaseline?.unpricedEventCount ?? zeroCostRows.length)
      const output = {
        eventCount: rows.length,
        eligibleEventCount: eligibleRows.length,
        eligibleZeroCostEventCount: zeroCostRows.length,
        totalCost: rows.reduce((sum, row) => sum + Number(row.total_cost ?? 0), 0),
        unpricedEventCount: effectiveUnpricedCount,
        unpricedShare: eligibleRows.length > 0 ? effectiveUnpricedCount / eligibleRows.length : 0,
        maxUnpricedShare: eligibleRows.length > 0 ? effectiveUnpricedCount / eligibleRows.length : 0,
        status: coverageFromCounts(eligibleRows.length, effectiveStatusCounts),
        statusCounts: effectiveStatusCounts,
        zeroCostByModel: adminBaseline?.zeroCostByModel ?? zeroCostByModel,
        legacyPriceRowCount: legacyPriceRows.length,
        activeCatalogVersion: pointer(adminBaseline?.activeCatalogVersion),
        activeRunId: pointer(adminBaseline?.activeRunId),
        previousCatalogVersion: pointer(adminBaseline?.previousCatalogVersion),
        previousRunId: pointer(adminBaseline?.previousRunId),
        membersOver2x: Number(adminBaseline?.membersOver2xCount ?? 0),
        reconciliationHash: adminBaseline?.activeReconciliationHash ?? 'not_present',
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
      const suffix = randomUUID().replace(/-/g, '')
      const fixture = {
        memberCode: `ROLL_${suffix}`,
        memberToken: `roll_${sha256(`${suffix}:${clock().toISOString()}`).slice(0, 32)}`,
        createdAt: clock().toISOString(),
      }
      await http.json('tokend_members', {
        role: 'service', method: 'POST',
        body: [{ member_code: fixture.memberCode, token: fixture.memberToken }],
        extraHeaders: { Prefer: 'return=representation' },
      })
      const next = { ...state, fixture, transition: 'rollout-active' }
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
      const created = await http.rpc('tokend_pricing_create_backfill', { p_catalog_version: options.catalog }, 'service')
      const runId = created?.runId ?? created?.run_id
      if (!runId) fail('Backfill create returned no run id')
      const [catalogs, runRow] = await Promise.all([
        http.json(`tokend_pricing_catalogs?select=hash&version=eq.${encodeURIComponent(options.catalog)}`, { role: 'service', method: 'GET' }),
        fetchBackfillRunRow(http, runId),
      ])
      if (!Array.isArray(catalogs) || catalogs.length !== 1 || !catalogs[0].hash) fail('Backfill catalog hash lookup failed')
      const backfillSnapshot = snapshotFromBackfillRow(runRow)
      if (runRow.status !== 'staging' || runRow.catalog_version !== options.catalog
        || created.status !== 'staging' || created.catalogVersion !== options.catalog
        || created.snapshotAt !== backfillSnapshot.snapshotAt
        || Number(created.targetCount) !== backfillSnapshot.targetCount
        || created.targetHash !== backfillSnapshot.targetHash
        || (created.baseCatalogVersion ?? null) !== backfillSnapshot.baseCatalogVersion
        || (created.baseRunId ?? null) !== backfillSnapshot.baseRunId) fail('Backfill create response disagrees with authoritative frozen run')
      const next = {
        ...state,
        catalogVersion: options.catalog,
        catalogHash: catalogs[0].hash,
        targetHash: backfillSnapshot.targetHash,
        backfillSnapshot,
        backfill: {
          runId, cursorMember: '', cursorEvent: '',
          remaining: backfillSnapshot.targetCount, batches: 0,
        },
        transition: 'rollout-active',
      }
      await saveState(options.state, next)
      return sanitizeForOutput({ created: true, targetCount: next.backfill.remaining })
    }

    if (command === 'backfill-run') {
      if (!state.backfill?.runId) fail('Backfill run state is missing')
      return runBackfillBatches({
        state,
        limit: options.limit,
        interruptAfterBatches: options.interruptAfterBatches,
        callBatch: async ({ afterMember, afterEvent, limit }) => http.rpc('tokend_pricing_backfill_batch', {
          p_run_id: state.backfill.runId,
          p_after_member: afterMember,
          p_after_event: afterEvent,
          p_limit: limit,
        }, 'service'),
        saveState: next => saveState(options.state, next),
        sleep,
      })
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
        http.rpc(PREFLIGHT_RPC_NAME, {}, 'service'),
        fetchBackfillRunRow(http, state.backfill?.runId),
        http.json(`tokend_pricing_catalogs?select=hash&version=eq.${encodeURIComponent(state.catalogVersion)}`, { role: 'service', method: 'GET' }),
      ])
      if (!Array.isArray(catalogs) || catalogs.length !== 1 || catalogs[0].hash !== state.catalogHash) fail('Reconciliation catalog hash changed after backfill creation')
      if (backfill?.status !== 'reconciled' || runRow.status !== 'reconciled') fail('Backfill did not persist reconciled status')
      assertSameBackfillSnapshot(snapshotFromBackfillRow(runRow), state.backfillSnapshot)
      if (backfill.catalogVersion !== state.catalogVersion
        || backfill.snapshotAt !== state.backfillSnapshot.snapshotAt
        || Number(backfill.targetCount) !== state.backfillSnapshot.targetCount
        || Number(backfill.revisionCount) !== state.backfillSnapshot.targetCount
        || Number(backfill.remainingCount) !== 0) fail('Backfill status disagrees with frozen snapshot')
      const pointers = {
        activeCatalog: preflight.activeCatalogVersion,
        previousCatalog: preflight.previousCatalogVersion,
        activeRun: preflight.activeRunId,
        previousRun: preflight.previousRunId,
      }
      if ((pointers.activeCatalog ?? null) !== state.backfillSnapshot.baseCatalogVersion
        || (pointers.activeRun ?? null) !== state.backfillSnapshot.baseRunId) fail('Base pricing pointers changed before activation')
      const authoritative = { ...report, catalogHash: catalogs[0].hash, pointers }
      validateReconciliation(authoritative, { catalogHash: state.catalogHash, pointers })
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
        callAdmin: (name, body) => http.rpc(name, { p_run_id: body.runId }, 'service'),
        inspectState: async () => {
          const [preflight, summary] = await Promise.all([
            http.rpc(PREFLIGHT_RPC_NAME, {}, 'service'),
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
      const next = { ...state, pointers: result.pointers, activationTotals: result.totals, activationAt: clock().toISOString() }
      await saveState(options.state, next)
      return writeSanitized(options.out, { passed: true, pointers: result.pointers, totals: result.totals }, adapters)
    }

    if (command === 'rollback-active') {
      const runId = state.backfill?.runId
      if (!runId || !state.pointers) fail('Rollback requires the active run and four saved pointers')
      const rolledBack = await http.rpc('tokend_pricing_rollback', { p_run_id: runId }, 'service')
      if (rolledBack?.runId !== runId || !['rolled_back', 'already_rolled_back'].includes(rolledBack?.status)) fail('Rollback did not bind the same run')
      const preflight = await http.rpc(PREFLIGHT_RPC_NAME, {}, 'service')
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
          legacyRpcNames: LEGACY_RPC_NAMES.filter((_name, index) => legacyProbes[index].present),
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
      const [migrationList, approval, postSchema] = await Promise.all([
        fs.readFile(options.migrationList, 'utf8'), readJson(options.approval, fs), fs.readFile(options.postSchema, 'utf8'),
      ])
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
      const reviewedSurface = validateReviewedPostSchema(postSchema)
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
        approval, postSchema, liveSurface, fs, now: () => clock().toISOString(),
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
      const result = await runMonitorLoop({
        durationSeconds: options.duration,
        intervalSeconds: options.interval,
        lateUploadEverySeconds: options.lateUploadEvery,
        baselineGlobal,
        baselineRpc: monitorRpcBaseline,
        collectSnapshot: async () => {
          const [legacy, vNext, global] = await Promise.all([
            http.rpc('tokend_get_summary_v4', { p_token: token }, 'anon'),
            http.rpc('tokend_get_summary_v5', { p_token: token }, 'anon'),
            http.rpc(PREFLIGHT_RPC_NAME, {}, 'service'),
          ])
          let fixtureHealth = { known: true, zero: true, unpriced: true, reported: true, legacy: true }
          for (const batch of monitoredBatches) {
            const health = await verifyLateRows(http, state.fixture.memberCode, batch.events, batch.catalogVersion)
            fixtureHealth = Object.fromEntries(Object.keys(fixtureHealth).map(key => [key, fixtureHealth[key] && health[key]]))
          }
          const adjustedCount = Math.max(0, Number(global.eventCount ?? 0) - fixtureEventCount)
          const adjustedCounts = subtractCounts(global.statusCounts, fixtureStatusCounts)
          const pointer = value => value ?? 'not_present'
          return {
            legacyHealthy: Boolean(legacy),
            vNextHealthy: Boolean(vNext),
            global: {
              eventCount: Number(global.eventCount ?? 0),
              knownFixtureCount: fixtureEventCount,
              status: coverageFromCounts(adjustedCount, adjustedCounts),
              unpricedShare: adjustedCount > 0 ? Number(adjustedCounts.unpriced ?? 0) / adjustedCount : 0,
              membersOver2x: Number(global.membersOver2xCount ?? 0),
            },
            fixtureHealth,
            reconciliationHash: global.activeReconciliationHash ?? 'not_present',
            pointers: {
              activeCatalog: pointer(global.activeCatalogVersion),
              activeRun: pointer(global.activeRunId),
              previousCatalog: pointer(global.previousCatalogVersion),
              previousRun: pointer(global.previousRunId),
            },
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
    async cleanupOnFailure(stateFile) {
      if (!stateFile) return
      const state = await loadState(stateFile)
      const next = await deleteFixtureData({ state, http, includeMember: true, timestamp: clock().toISOString() })
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
  const signal = name => { void cleanupAndExit(`Rollout interrupted by ${name}`, 130) }
  const exception = error => {
    if (error?.intentional && error?.exitCode === 75) { process.exitCode = 75; return }
    void cleanupAndExit('Rollout terminated by an unexpected error', 1)
  }
  process.once('SIGINT', () => signal('SIGINT'))
  process.once('SIGTERM', () => signal('SIGTERM'))
  process.once('uncaughtException', exception)
  process.once('unhandledRejection', exception)
  try {
    const result = await runner.execute(parsed.command, parsed.options)
    if (result !== undefined) process.stdout.write(`${JSON.stringify(sanitizeForOutput(result))}\n`)
  } catch (error) {
    if (error?.intentional && error?.exitCode === 75) {
      process.exitCode = 75
      return
    }
    await cleanupAndExit(error instanceof ExitCodeError ? error.message : 'Rollout command failed', error?.exitCode ?? 1)
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) void main()
