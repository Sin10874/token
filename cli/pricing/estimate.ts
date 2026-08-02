import {
  assertCatalogSnapshotHash,
  CACHE_MISS_INPUT_MODEL_IDS,
  CATALOG_SNAPSHOT,
  resolveModelPrice,
} from './catalog.ts'
import type {
  CatalogSnapshot,
  CostEstimate,
  PriceVersion,
  PricingEvent,
  PricingStatus,
  PricingTier,
  TokenRates,
} from './types.ts'

const PER_MILLION = 1_000_000
const AMOUNT_FIELDS = [
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'inputCost',
  'outputCost',
  'reasoningCost',
  'cacheReadCost',
  'cacheWriteCost',
  'totalCost',
] as const
const COST_FIELDS = [
  'inputCost',
  'outputCost',
  'reasoningCost',
  'cacheReadCost',
  'cacheWriteCost',
  'totalCost',
] as const

function emptyEstimate(
  snapshot: CatalogSnapshot,
  matchedModelId: string | null,
  warnings: string[],
): CostEstimate {
  return {
    matchedModelId,
    status: 'unpriced',
    tier: 'standard',
    priceVersion: null,
    catalogHash: snapshot.hash,
    inputCost: 0,
    outputCost: 0,
    reasoningCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    unallocatedCost: 0,
    totalCost: 0,
    breakdownStatus: 'reconciled',
    warnings,
  }
}

function effectiveRow(modelId: string, timestampMs: number, snapshot: CatalogSnapshot): PriceVersion | null {
  const candidates = snapshot.rows
    .filter(row => row.modelId === modelId)
    .filter(row => {
      const startsAt = Date.parse(row.validFrom)
      const endsAt = row.validTo === undefined ? Number.POSITIVE_INFINITY : Date.parse(row.validTo)
      return startsAt <= timestampMs && timestampMs < endsAt
    })
    .sort((left, right) => Date.parse(right.validFrom) - Date.parse(left.validFrom))
  return candidates[0] ?? null
}

function rowStatus(row: PriceVersion, tokenRates: TokenRates): PricingStatus {
  if (Object.values(tokenRates).every(rate => rate === 0)) return 'zero_rate'
  if (row.sourceUrl.startsWith('legacy:')) return 'legacy'
  return 'estimated'
}

function validateEventAmounts(event: PricingEvent): void {
  for (const field of AMOUNT_FIELDS) {
    const amount = event[field]
    if (!Number.isFinite(amount) || amount < 0) {
      throw new RangeError(`${field} must be a finite non-negative number`)
    }
  }
}

function hasReportedCosts(event: PricingEvent): boolean {
  if (event.pricingStatus === 'reported') return true
  if (event.pricingStatus !== undefined) return false
  return COST_FIELDS.some(field => event[field] !== 0)
}

function reportedEstimate(event: PricingEvent, snapshot: CatalogSnapshot): CostEstimate {
  const components = [
    event.inputCost,
    event.outputCost,
    event.reasoningCost,
    event.cacheReadCost,
    event.cacheWriteCost,
  ]
  let componentTotal = 0
  let componentsExceedTotal = false
  for (const component of components) {
    const remaining = event.totalCost - componentTotal
    if (component > remaining) {
      componentsExceedTotal = true
      break
    }
    componentTotal += component
    if (!Number.isFinite(componentTotal) || componentTotal > event.totalCost) {
      componentsExceedTotal = true
      break
    }
  }
  const difference = event.totalCost - componentTotal
  const unallocatedCost = !componentsExceedTotal && difference > 0 ? difference : 0
  const hasUnallocatedCost = unallocatedCost > 0

  return {
    matchedModelId: resolveModelPrice(event.model, snapshot),
    status: 'reported',
    tier: 'standard',
    priceVersion: null,
    catalogHash: snapshot.hash,
    inputCost: event.inputCost,
    outputCost: event.outputCost,
    reasoningCost: event.reasoningCost,
    cacheReadCost: event.cacheReadCost,
    cacheWriteCost: event.cacheWriteCost,
    unallocatedCost,
    totalCost: event.totalCost,
    breakdownStatus: componentsExceedTotal
      ? 'invalid'
      : hasUnallocatedCost
        ? 'unallocated'
        : 'reconciled',
    warnings: componentsExceedTotal
      ? ['reported_cost_components_exceed_total']
      : [],
  }
}

export function estimateCost(
  event: PricingEvent,
  snapshot: CatalogSnapshot = CATALOG_SNAPSHOT,
): CostEstimate {
  assertCatalogSnapshotHash(snapshot)
  validateEventAmounts(event)
  if (hasReportedCosts(event)) return reportedEstimate(event, snapshot)

  const matchedModelId = resolveModelPrice(event.model, snapshot)
  if (!matchedModelId) {
    return emptyEstimate(snapshot, null, [`No pricing catalog match for model: ${event.model}`])
  }

  if (!Number.isFinite(event.timestampMs)) {
    return emptyEstimate(snapshot, matchedModelId, [
      'Invalid or missing timestampMs; pricing requires an event timestamp.',
    ])
  }

  const row = effectiveRow(matchedModelId, event.timestampMs!, snapshot)
  if (!row) {
    return emptyEstimate(snapshot, matchedModelId, [
      `No effective price version for ${matchedModelId} at the event timestamp.`,
    ])
  }

  // Kimi K3 publishes cache-hit and cache-miss input rates, not a separate
  // cache-write rate. Only price it when the parser proves that inputTokens is
  // the uncached bucket and no cache-write bucket needs an invented mapping.
  if (CACHE_MISS_INPUT_MODEL_IDS.has(matchedModelId)) {
    if (event.tokenSemantics !== 'disjoint') {
      return emptyEstimate(snapshot, matchedModelId, [
        `${matchedModelId} cache-miss input pricing requires proven disjoint token semantics.`,
      ])
    }
    if (event.cacheWriteTokens !== 0) {
      return emptyEstimate(snapshot, matchedModelId, [
        `${matchedModelId} has no verified cache-write mapping; event remains unpriced.`,
      ])
    }
  }

  let tier: PricingTier = 'standard'
  let tokenRates = row.standard
  const warnings: string[] = []
  const promptTokens = event.inputTokens + event.cacheReadTokens + event.cacheWriteTokens
  if (event.tokenSemantics === 'unknown' && row.longContext) {
    warnings.push('Unknown token semantics; long-context tier selection is disabled.')
  } else if (event.tokenSemantics === 'disjoint'
    && row.longContext
    && row.longContextThreshold !== undefined
    && promptTokens > row.longContextThreshold) {
    tier = 'long_context'
    tokenRates = row.longContext
  }
  const inputCost = event.inputTokens * tokenRates.input / PER_MILLION
  const outputCost = event.outputTokens * tokenRates.output / PER_MILLION
  const reasoningCost = event.reasoningTokens * tokenRates.output / PER_MILLION
  const cacheReadCost = event.cacheReadTokens * tokenRates.cacheRead / PER_MILLION
  const cacheWriteCost = event.cacheWriteTokens * tokenRates.cacheWrite / PER_MILLION
  const derivedCosts = { inputCost, outputCost, reasoningCost, cacheReadCost, cacheWriteCost }
  let totalCost = 0
  for (const [bucket, cost] of Object.entries(derivedCosts)) {
    if (!Number.isFinite(cost) || cost < 0) {
      throw new RangeError(`${bucket} must produce a finite non-negative cost`)
    }
    totalCost += cost
    if (!Number.isFinite(totalCost)) {
      throw new RangeError('Estimated totalCost must be a finite non-negative cost')
    }
  }

  return {
    matchedModelId,
    status: rowStatus(row, tokenRates),
    tier,
    priceVersion: `${row.catalogVersion}/${row.modelId}/${row.validFrom}`,
    catalogHash: snapshot.hash,
    inputCost,
    outputCost,
    reasoningCost,
    cacheReadCost,
    cacheWriteCost,
    unallocatedCost: 0,
    totalCost,
    breakdownStatus: 'reconciled',
    warnings,
  }
}
