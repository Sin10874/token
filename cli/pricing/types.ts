export type PricingStatus = 'reported' | 'estimated' | 'zero_rate' | 'unpriced' | 'legacy'
export type PricingTier = 'standard' | 'long_context'
export type TokenSemantics = 'disjoint' | 'unknown'
export type BreakdownStatus = 'reconciled' | 'unallocated' | 'invalid'

export interface TokenRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface PriceVersion {
  modelId: string
  provider: string
  catalogVersion: string
  validFrom: string
  validTo?: string
  standard: TokenRates
  longContext?: TokenRates
  longContextThreshold?: number
  sourceCheckedAt: string
  sourceUrl: string
}

export interface CostEstimate {
  matchedModelId: string | null
  status: PricingStatus
  tier: PricingTier
  priceVersion: string | null
  catalogHash: string
  inputCost: number
  outputCost: number
  reasoningCost: number
  cacheReadCost: number
  cacheWriteCost: number
  unallocatedCost: number
  totalCost: number
  breakdownStatus: BreakdownStatus
  warnings: string[]
}

export interface PricingEvent {
  model: string
  timestampMs?: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  inputCost: number
  outputCost: number
  reasoningCost: number
  cacheReadCost: number
  cacheWriteCost: number
  totalCost: number
  pricingStatus?: PricingStatus
  tokenSemantics: TokenSemantics
}

export interface CatalogSnapshot {
  version: string
  hash: string
  rows: PriceVersion[]
  aliases: Record<string, string>
}
