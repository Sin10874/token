import { applyEstimatedCosts } from '../../cli/prices.js'
import {
  CACHE_MISS_INPUT_MODEL_IDS,
  resolveModelPrice,
} from '../../cli/pricing/catalog.js'
import type { RawUsageEvent } from './parser.js'
import type { LocalModelPriceRow } from './local-price-resolver.js'

export type LocalPriceLookup = (model: string) => LocalModelPriceRow | null

function hasReportedCosts(event: RawUsageEvent): boolean {
  return event.pricingStatus === 'reported'
    || event.inputCost !== 0
    || event.outputCost !== 0
    || event.reasoningCost !== 0
    || event.cacheReadCost !== 0
    || event.cacheWriteCost !== 0
    || event.totalCost !== 0
}

function applyExplicitLocalOverride(
  event: RawUsageEvent,
  price: LocalModelPriceRow,
): RawUsageEvent {
  const perTokens = price.per_tokens || 1_000_000
  event.inputCost = event.inputTokens * price.input_price / perTokens
  event.outputCost = event.outputTokens * price.output_price / perTokens
  event.reasoningCost = event.reasoningTokens * price.output_price / perTokens
  event.cacheReadCost = event.cacheReadTokens * price.cache_read_price / perTokens
  event.cacheWriteCost = event.cacheWriteTokens * price.cache_write_price / perTokens
  event.totalCost = event.inputCost
    + event.outputCost
    + event.reasoningCost
    + event.cacheReadCost
    + event.cacheWriteCost
  event.pricingStatus = Object.values({
    input: price.input_price,
    output: price.output_price,
    cacheRead: price.cache_read_price,
    cacheWrite: price.cache_write_price,
  }).every(rate => rate === 0) ? 'zero_rate' : 'estimated'
  event.pricingTier = 'standard'
  event.priceVersion = `local/${price.source}/${price.model_id}`
  event.matchedModelId = price.model_id
  event.unallocatedCost = 0
  event.breakdownStatus = 'reconciled'
  return event
}

export function applyLocalCosts(
  event: RawUsageEvent,
  findPrice: LocalPriceLookup,
): RawUsageEvent {
  if (hasReportedCosts(event)) return applyEstimatedCosts(event)

  // A model-only local override cannot prove how K3's cache-miss input maps to
  // Tokend buckets, so it must not bypass the shared fail-closed estimator.
  const canonicalModel = resolveModelPrice(event.model)
  if (canonicalModel && CACHE_MISS_INPUT_MODEL_IDS.has(canonicalModel)) {
    return applyEstimatedCosts(event)
  }

  const localPrice = findPrice(event.model)
  if (localPrice && localPrice.source !== 'default') {
    return applyExplicitLocalOverride(event, localPrice)
  }

  return applyEstimatedCosts(event)
}
