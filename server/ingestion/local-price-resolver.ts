import { resolveModelPrice } from '../../cli/pricing/catalog.js'

export interface LocalModelPriceRow {
  model_id: string
  input_price: number
  output_price: number
  cache_read_price: number
  cache_write_price: number
  per_tokens: number
  source: string
}

function isUsablePriceRow(row: LocalModelPriceRow): boolean {
  if (row.source !== 'openclaw.json') return true
  return row.input_price !== 0
    || row.output_price !== 0
    || row.cache_read_price !== 0
    || row.cache_write_price !== 0
}

export function createLocalPriceResolver(
  rows: readonly LocalModelPriceRow[],
): (model: string) => LocalModelPriceRow | null {
  const pricesByModel = new Map(rows.map(row => [row.model_id, row]))

  return model => {
    const exact = pricesByModel.get(model)
    if (exact && exact.source !== 'default' && isUsablePriceRow(exact)) return exact

    const canonicalModel = resolveModelPrice(model)
    if (!canonicalModel) return null
    const canonical = pricesByModel.get(canonicalModel)
    return canonical && isUsablePriceRow(canonical) ? canonical : null
  }
}
