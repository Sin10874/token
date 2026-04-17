export interface ModelPriceValues {
  input_price: number
  output_price: number
  cache_read_price: number
  cache_write_price: number
}

// Authoritative overrides for models whose official launch pricing is known
// to differ from provider config or older seeded defaults.
const OFFICIAL_PRICE_OVERRIDES: Record<string, ModelPriceValues> = {
  'claude-opus-4-6': {
    input_price: 5,
    output_price: 25,
    cache_read_price: 0.5,
    cache_write_price: 6.25,
  },
}

export function resolveOfficialPriceOverride(modelId: string, prices: ModelPriceValues): ModelPriceValues {
  return OFFICIAL_PRICE_OVERRIDES[modelId] || prices
}
