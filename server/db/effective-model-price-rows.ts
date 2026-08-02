import { getDefaultSeedRows } from '../../cli/pricing/catalog.js'
import type { LocalModelPriceRow } from '../ingestion/local-price-resolver.js'

export function withEffectiveDefaultPrices<T extends LocalModelPriceRow>(
  rows: readonly T[],
  atMs = Date.now(),
): T[] {
  const effective = new Map(
    getDefaultSeedRows(atMs).map(([modelId, provider, input, output, cacheRead, cacheWrite]) => [
      modelId,
      { provider, input, output, cacheRead, cacheWrite },
    ]),
  )

  return rows.map(row => {
    if (row.source !== 'default') return row
    const price = effective.get(row.model_id)
    if (!price) return row
    return {
      ...row,
      provider: price.provider,
      input_price: price.input,
      output_price: price.output,
      cache_read_price: price.cacheRead,
      cache_write_price: price.cacheWrite,
    }
  })
}
