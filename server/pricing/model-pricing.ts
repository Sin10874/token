export type CacheSemantics = 'anthropic' | 'hit_miss' | 'generic'

export interface FlatModelPriceRow {
  model_id: string
  provider?: string | null
  input_price: number
  output_price: number
  cache_read_price: number
  cache_write_price: number
  per_tokens?: number | null
  source?: string | null
}

export interface VersionedModelPriceRow {
  model_id: string
  provider: string
  valid_from_ms: number
  valid_to_ms: number | null
  input_price: number
  output_price: number
  cache_read_price: number
  cache_write_price: number | null
  per_tokens: number
  cache_semantics: CacheSemantics
}

interface ResolvedModelPrice {
  inputPrice: number
  outputPrice: number
  cacheReadPrice: number
  cacheWritePrice: number | null
  perTokens: number
  cacheSemantics: CacheSemantics
}

export interface PriceableUsageEvent {
  timestampMs: number
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  inputCost: number
  outputCost: number
  cacheReadCost: number
  cacheWriteCost: number
  totalCost: number
}

export type ModelPriceResolver = (model: string, timestampMs: number) => ResolvedModelPrice | null
export type PricingResult = 'reported' | 'priced' | 'unpriced'

function asVersionedPrice(row: VersionedModelPriceRow): ResolvedModelPrice {
  return {
    inputPrice: Number(row.input_price),
    outputPrice: Number(row.output_price),
    cacheReadPrice: Number(row.cache_read_price),
    cacheWritePrice: row.cache_write_price == null ? null : Number(row.cache_write_price),
    perTokens: Number(row.per_tokens) || 1_000_000,
    cacheSemantics: row.cache_semantics,
  }
}

function asFlatPrice(row: FlatModelPriceRow, cacheSemantics: CacheSemantics = 'generic'): ResolvedModelPrice {
  return {
    inputPrice: Number(row.input_price),
    outputPrice: Number(row.output_price),
    cacheReadPrice: Number(row.cache_read_price),
    cacheWritePrice: Number(row.cache_write_price),
    perTokens: Number(row.per_tokens) || 1_000_000,
    cacheSemantics,
  }
}

export function buildModelPriceResolver(
  flatRows: FlatModelPriceRow[],
  versionRows: VersionedModelPriceRow[],
): ModelPriceResolver {
  const flatByModel = new Map(flatRows.map((row) => [row.model_id, row]))
  const versionsByModel = new Map<string, VersionedModelPriceRow[]>()

  for (const row of versionRows) {
    const rows = versionsByModel.get(row.model_id) || []
    rows.push(row)
    versionsByModel.set(row.model_id, rows)
  }
  for (const rows of versionsByModel.values()) {
    rows.sort((a, b) => a.valid_from_ms - b.valid_from_ms)
  }

  return (model: string, timestampMs: number) => {
    const exactFlat = flatByModel.get(model)
    const exactVersions = versionsByModel.get(model)

    // An explicit user override stays authoritative, including for versioned models.
    if (exactFlat?.source === 'manual') {
      const activeVersion = exactVersions?.find((row) => (
        timestampMs >= row.valid_from_ms
        && (row.valid_to_ms == null || timestampMs < row.valid_to_ms)
      ))
      return asFlatPrice(exactFlat, activeVersion?.cache_semantics || 'generic')
    }

    if (exactVersions) {
      const activeVersion = exactVersions.find((row) => (
        timestampMs >= row.valid_from_ms
        && (row.valid_to_ms == null || timestampMs < row.valid_to_ms)
      ))
      return activeVersion ? asVersionedPrice(activeVersion) : null
    }

    if (exactFlat) return asFlatPrice(exactFlat)

    // Preserve main's legacy dated-Claude fallback, but never manufacture aliases
    // for the versioned catalog added here.
    const stripped = model.replace(/-\d{8,}$/, '')
    if (stripped === model || versionsByModel.has(stripped)) return null
    const strippedFlat = flatByModel.get(stripped)
    return strippedFlat ? asFlatPrice(strippedFlat) : null
  }
}

export function priceUsageEvent(
  event: PriceableUsageEvent,
  resolvePrice: ModelPriceResolver,
): PricingResult {
  if (event.totalCost !== 0) return 'reported'

  const price = resolvePrice(event.model, event.timestampMs)
  if (!price) return 'unpriced'

  // Kimi exposes cache-hit and cache-miss input prices. A cache-write bucket is
  // not equivalent to cache-miss input, so any non-zero write remains unpriced.
  if (price.cacheSemantics === 'hit_miss' && event.cacheWriteTokens !== 0) {
    return 'unpriced'
  }

  const components = [
    [event.inputTokens, price.inputPrice],
    [event.outputTokens, price.outputPrice],
    [event.cacheReadTokens, price.cacheReadPrice],
    [event.cacheWriteTokens, price.cacheWritePrice],
  ] as const

  if (components.some(([tokens, componentPrice]) => tokens > 0 && componentPrice == null)) {
    return 'unpriced'
  }

  const perTokens = price.perTokens || 1_000_000
  const inputCost = (event.inputTokens * price.inputPrice) / perTokens
  const outputCost = (event.outputTokens * price.outputPrice) / perTokens
  const cacheReadCost = (event.cacheReadTokens * price.cacheReadPrice) / perTokens
  const cacheWriteCost = price.cacheWritePrice == null
    ? 0
    : (event.cacheWriteTokens * price.cacheWritePrice) / perTokens

  event.inputCost = inputCost
  event.outputCost = outputCost
  event.cacheReadCost = cacheReadCost
  event.cacheWriteCost = cacheWriteCost
  event.totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost
  return 'priced'
}
