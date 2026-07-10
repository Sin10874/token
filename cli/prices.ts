import type { RawUsageEvent } from '../server/ingestion/parser.js'
import { estimateCost } from './pricing/estimate.ts'

export function applyEstimatedCosts(event: RawUsageEvent): RawUsageEvent {
  const estimate = estimateCost(event)

  event.inputCost = estimate.inputCost
  event.outputCost = estimate.outputCost
  event.reasoningCost = estimate.reasoningCost
  event.cacheReadCost = estimate.cacheReadCost
  event.cacheWriteCost = estimate.cacheWriteCost
  event.unallocatedCost = estimate.unallocatedCost
  event.totalCost = estimate.totalCost
  event.pricingStatus = estimate.status
  event.pricingTier = estimate.tier
  event.priceVersion = estimate.priceVersion
  event.matchedModelId = estimate.matchedModelId
  event.breakdownStatus = estimate.breakdownStatus

  return event
}
