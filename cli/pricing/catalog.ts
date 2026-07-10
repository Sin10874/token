import { createHash } from 'node:crypto'
import type { CatalogSnapshot, PriceVersion, TokenRates } from './types.ts'

export const CATALOG_VERSION = '2026-07-10'

const OFFICIAL_CHECKED_AT = '2026-07-10'
const LEGACY_VALID_FROM = '2026-06-12T00:00:00Z'
const LEGACY_CHECKED_AT = '2026-06-12'
const LEGACY_SOURCE_URL = 'legacy:tokend-cli-2.4.0'

type LegacyPriceTuple = readonly [
  modelId: string,
  provider: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
]

const LEGACY_MODEL_PRICES: LegacyPriceTuple[] = [
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
  ['kimi-k2.6', 'moonshot', 0.95, 4, 0.16, 0],
  ['kimi-k2.5', 'moonshot', 0.6, 3, 0.1, 0],
  ['kimi-k2-thinking', 'moonshot', 0.6, 2.5, 0.15, 0],
  ['glm-5.2', 'zhipu', 1.4, 4.4, 0.26, 0],
  ['glm-5.1', 'zhipu', 1.4, 4.4, 0.26, 0],
  ['glm-5', 'zhipu', 1, 3.2, 0.2, 0],
  ['glm-5-turbo', 'zhipu', 1.2, 4, 0.24, 0],
  ['glm-4.7', 'zhipu', 0.6, 2.2, 0.11, 0],
  ['glm-4.7-flashx', 'zhipu', 0.07, 0.4, 0.01, 0],
  ['glm-4.5-air', 'zhipu', 0.2, 1.1, 0.03, 0],
  ['glm-4.7-free', 'zhipu', 0, 0, 0, 0],
  ['MiniMax-M3', 'minimax', 0.3, 1.2, 0.06, 0.375],
  ['MiniMax-M2.7', 'minimax', 0.3, 1.2, 0.06, 0.375],
  ['minimax-m2.1-free', 'minimax', 0, 0, 0, 0],
  ['grok-code', 'xai', 0.2, 1.5, 0.02, 0],
]

function rates(input: number, output: number, cacheRead: number, cacheWrite: number): TokenRates {
  return { input, output, cacheRead, cacheWrite }
}

const officialRows: PriceVersion[] = [
  {
    modelId: 'claude-fable-5',
    provider: 'anthropic',
    catalogVersion: CATALOG_VERSION,
    validFrom: '2026-06-09T00:00:00Z',
    standard: rates(10, 50, 1, 12.5),
    sourceCheckedAt: OFFICIAL_CHECKED_AT,
    sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
  },
  {
    modelId: 'gpt-5.6-sol',
    provider: 'openai',
    catalogVersion: CATALOG_VERSION,
    validFrom: '2026-06-26T00:00:00Z',
    standard: rates(5, 30, 0.5, 6.25),
    longContext: rates(10, 45, 1, 12.5),
    longContextThreshold: 272_000,
    sourceCheckedAt: OFFICIAL_CHECKED_AT,
    sourceUrl: 'https://developers.openai.com/api/docs/pricing',
  },
  {
    modelId: 'gpt-5.6-terra',
    provider: 'openai',
    catalogVersion: CATALOG_VERSION,
    validFrom: '2026-06-26T00:00:00Z',
    standard: rates(2.5, 15, 0.25, 3.125),
    longContext: rates(5, 22.5, 0.5, 6.25),
    longContextThreshold: 272_000,
    sourceCheckedAt: OFFICIAL_CHECKED_AT,
    sourceUrl: 'https://developers.openai.com/api/docs/pricing',
  },
  {
    modelId: 'gpt-5.6-luna',
    provider: 'openai',
    catalogVersion: CATALOG_VERSION,
    validFrom: '2026-06-26T00:00:00Z',
    standard: rates(1, 6, 0.1, 1.25),
    longContext: rates(2, 9, 0.2, 2.5),
    longContextThreshold: 272_000,
    sourceCheckedAt: OFFICIAL_CHECKED_AT,
    sourceUrl: 'https://developers.openai.com/api/docs/pricing',
  },
]

const legacyRows: PriceVersion[] = LEGACY_MODEL_PRICES.map(
  ([modelId, provider, input, output, cacheRead, cacheWrite]) => ({
    modelId,
    provider,
    catalogVersion: CATALOG_VERSION,
    validFrom: LEGACY_VALID_FROM,
    standard: rates(input, output, cacheRead, cacheWrite),
    sourceCheckedAt: LEGACY_CHECKED_AT,
    sourceUrl: LEGACY_SOURCE_URL,
  }),
)

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

export const CATALOG_ROWS: PriceVersion[] = deepFreeze(
  [...officialRows, ...legacyRows].sort((left, right) =>
    compareText(left.modelId, right.modelId) || compareText(left.validFrom, right.validFrom),
  ),
)

export const CATALOG_ALIASES: Record<string, string> = deepFreeze(
  Object.fromEntries(Object.entries({
    'M-2.7': 'MiniMax-M2.7',
    'M-3': 'MiniMax-M3',
    'anthropic/claude-fable-5': 'claude-fable-5',
    'claude-fable-5-thinking': 'claude-fable-5',
    'fable-5': 'claude-fable-5',
    'gpt-5.6': 'gpt-5.6-sol',
    'k2p5': 'kimi-k2.5',
    'k2p6': 'kimi-k2.6',
    'k2p7': 'kimi-k2.7',
    'kimi-code/kimi-for-coding': 'kimi-k2.5',
    'kimi-for-coding': 'kimi-k2.5',
  }).sort(([left], [right]) => compareText(left, right))),
)

export const PRICE_VERSIONS = CATALOG_ROWS
export const MODEL_ALIASES = CATALOG_ALIASES

type DefaultSeedRow = [string, string, number, number, number, number]

export function getDefaultSeedRows(
  atMs = Date.parse('2026-07-10T00:00:00Z'),
): readonly DefaultSeedRow[] {
  if (!Number.isFinite(atMs)) {
    throw new RangeError('atMs must be a finite timestamp')
  }

  const modelIds = [...new Set(PRICE_VERSIONS.map(row => row.modelId))].sort(compareText)
  const seedRows: DefaultSeedRow[] = modelIds.map(modelId => {
    const effectiveRows = PRICE_VERSIONS.filter(row => {
      if (row.modelId !== modelId) return false
      const validFromMs = Date.parse(row.validFrom)
      const validToMs = row.validTo === undefined
        ? Number.POSITIVE_INFINITY
        : Date.parse(row.validTo)
      return validFromMs <= atMs && atMs < validToMs
    })

    if (effectiveRows.length !== 1) {
      throw new Error(
        `Expected exactly one effective price version for ${modelId} at ${atMs}; found ${effectiveRows.length}`,
      )
    }

    const row = effectiveRows[0]
    return [
      row.modelId,
      row.provider,
      row.standard.input,
      row.standard.output,
      row.standard.cacheRead,
      row.standard.cacheWrite,
    ]
  })

  return deepFreeze(seedRows)
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isStrictCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return false

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

function parseStrictUtcTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/,
  )
  if (!match) return null

  const datePart = `${match[1]}-${match[2]}-${match[3]}`
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  if (!isStrictCalendarDate(datePart) || hour > 23 || minute > 59 || second > 59) return null

  const timestampMs = Date.parse(value)
  return Number.isFinite(timestampMs) ? timestampMs : null
}

function isValidSourceUrl(value: unknown): value is string {
  if (!isNonBlankString(value) || value !== value.trim()) return false
  if (/^legacy:[^\s]+$/.test(value)) return true

  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0
  } catch {
    return false
  }
}

function validateRates(modelId: string, tier: string, tokenRates: TokenRates): void {
  for (const [bucket, rate] of Object.entries(tokenRates ?? {})) {
    if (!Number.isFinite(rate) || rate < 0) {
      throw new Error(`Invalid ${tier} rate for ${modelId}.${bucket}`)
    }
  }

  for (const bucket of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    if (!Number.isFinite(tokenRates?.[bucket]) || tokenRates[bucket] < 0) {
      throw new Error(`Invalid ${tier} rate for ${modelId}.${bucket}`)
    }
  }
}

export function validateCatalog(rows: PriceVersion[], aliases: Record<string, string>): void {
  const seenVersions = new Set<string>()
  const intervalsByModel = new Map<string, Array<{ start: number; end: number }>>()

  for (const row of rows) {
    if (!isNonBlankString(row.modelId)) {
      throw new Error('Invalid modelId')
    }
    if (!isNonBlankString(row.provider)) {
      throw new Error(`Invalid provider for ${row.modelId}`)
    }
    if (!isNonBlankString(row.catalogVersion)) {
      throw new Error(`Invalid catalogVersion for ${row.modelId}`)
    }
    if (!isStrictCalendarDate(row.sourceCheckedAt)) {
      throw new Error(`Invalid sourceCheckedAt for ${row.modelId}`)
    }
    if (!isValidSourceUrl(row.sourceUrl)) {
      throw new Error(`Invalid sourceUrl for ${row.modelId}`)
    }

    const validFromMs = parseStrictUtcTimestamp(row.validFrom)
    if (validFromMs === null) {
      throw new Error(`Invalid validFrom for ${row.modelId}`)
    }
    const parsedValidToMs = row.validTo === undefined ? null : parseStrictUtcTimestamp(row.validTo)
    if (row.validTo !== undefined && parsedValidToMs === null) {
      throw new Error(`Invalid validTo for ${row.modelId}`)
    }
    const validToMs = parsedValidToMs ?? Number.POSITIVE_INFINITY
    if (validToMs <= validFromMs) {
      throw new Error(`Invalid interval for ${row.modelId}`)
    }

    const versionKey = `${row.modelId}\u0000${row.validFrom}`
    if (seenVersions.has(versionKey)) {
      throw new Error(`Duplicate price version for ${row.modelId} at ${row.validFrom}`)
    }
    seenVersions.add(versionKey)

    validateRates(row.modelId, 'standard', row.standard)
    const hasLongContext = row.longContext !== undefined
    const hasLongContextThreshold = row.longContextThreshold !== undefined
    if (hasLongContext !== hasLongContextThreshold) {
      throw new Error(`longContext and longContextThreshold must be provided together for ${row.modelId}`)
    }
    if (row.longContext !== undefined) validateRates(row.modelId, 'long-context', row.longContext)
    if (row.longContextThreshold !== undefined
      && (!Number.isInteger(row.longContextThreshold) || row.longContextThreshold <= 0)) {
      throw new Error(`Invalid long-context threshold for ${row.modelId}`)
    }

    const intervals = intervalsByModel.get(row.modelId) ?? []
    intervals.push({ start: validFromMs, end: validToMs })
    intervalsByModel.set(row.modelId, intervals)
  }

  for (const [modelId, intervals] of intervalsByModel) {
    intervals.sort((left, right) => left.start - right.start)
    for (let index = 1; index < intervals.length; index += 1) {
      if (intervals[index].start < intervals[index - 1].end) {
        throw new Error(`Overlapping price intervals for ${modelId}`)
      }
    }
  }

  const canonicalIds = new Set(rows.map(row => row.modelId))
  for (const alias of Object.keys(aliases)) {
    if (canonicalIds.has(alias)) {
      throw new Error(`Alias/canonical collision for ${alias}`)
    }

    const visited = new Set<string>()
    let candidate = alias
    while (Object.prototype.hasOwnProperty.call(aliases, candidate)) {
      if (visited.has(candidate)) {
        throw new Error(`Alias cycle involving ${candidate}`)
      }
      visited.add(candidate)
      candidate = aliases[candidate]
    }
    if (!canonicalIds.has(candidate)) {
      throw new Error(`Alias target does not exist for ${alias}: ${candidate}`)
    }
  }
}

function sortKeysRecursively(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysRecursively)
  if (value === null || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => [key, sortKeysRecursively(child)]),
  )
}

export function computeCatalogHash(snapshot: Pick<CatalogSnapshot, 'version' | 'rows' | 'aliases'>): string {
  const payload = {
    version: snapshot.version,
    rows: [...snapshot.rows].sort((left, right) =>
      compareText(left.modelId, right.modelId) || compareText(left.validFrom, right.validFrom),
    ),
    aliases: Object.fromEntries(
      Object.entries(snapshot.aliases).sort(([left], [right]) => compareText(left, right)),
    ),
  }
  return createHash('sha256').update(JSON.stringify(sortKeysRecursively(payload))).digest('hex')
}

export class CatalogHashMismatchError extends Error {
  readonly declaredHash: string
  readonly computedHash: string

  constructor(declaredHash: string, computedHash: string) {
    super(`Catalog snapshot hash mismatch: declared ${declaredHash}, computed ${computedHash}`)
    this.name = 'CatalogHashMismatchError'
    this.declaredHash = declaredHash
    this.computedHash = computedHash
  }
}

export function assertCatalogSnapshotHash(snapshot: CatalogSnapshot): void {
  const computedHash = computeCatalogHash(snapshot)
  if (snapshot.hash !== computedHash) {
    throw new CatalogHashMismatchError(snapshot.hash, computedHash)
  }
}

validateCatalog(CATALOG_ROWS, CATALOG_ALIASES)

export const CATALOG_HASH = computeCatalogHash({
  version: CATALOG_VERSION,
  rows: CATALOG_ROWS,
  aliases: CATALOG_ALIASES,
})

export const CATALOG_SNAPSHOT: CatalogSnapshot = deepFreeze({
  version: CATALOG_VERSION,
  hash: CATALOG_HASH,
  rows: CATALOG_ROWS,
  aliases: CATALOG_ALIASES,
})

function resolveExact(rawModel: string, snapshot: CatalogSnapshot): string | null {
  const canonicalIds = new Set(snapshot.rows.map(row => row.modelId))
  if (canonicalIds.has(rawModel)) return rawModel

  const visited = new Set<string>()
  let candidate = rawModel
  while (Object.prototype.hasOwnProperty.call(snapshot.aliases, candidate) && !visited.has(candidate)) {
    visited.add(candidate)
    candidate = snapshot.aliases[candidate]
    if (canonicalIds.has(candidate)) return candidate
  }
  return null
}

function hasValidDateSuffix(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(4, 6))
  const day = Number(value.slice(6, 8))
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

export function resolveModelPrice(rawModel: string, snapshot: CatalogSnapshot = CATALOG_SNAPSHOT): string | null {
  assertCatalogSnapshotHash(snapshot)
  const exact = resolveExact(rawModel, snapshot)
  if (exact) return exact

  const suffixMatch = rawModel.match(/^(.*)-(\d{8})$/)
  if (!suffixMatch || !hasValidDateSuffix(suffixMatch[2])) return null
  return resolveExact(suffixMatch[1], snapshot)
}
