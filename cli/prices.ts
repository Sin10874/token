export type CacheSemantics = 'anthropic' | 'hit_miss' | 'generic'

interface ModelPrice {
  modelId: string
  provider: string
  inputPrice: number
  outputPrice: number
  cacheReadPrice: number
  cacheWritePrice: number | null
  perTokens: number
  cacheSemantics: CacheSemantics
}

export interface OfficialModelPriceVersion extends ModelPrice {
  validFromMs: number
  validToMs: number | null
  contextWindow: number
  sourceUrl: string
  sourceCheckedAt: string
}

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

export interface PriceableUsageEvent {
  timestampMs: number
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  inputCost: number
  outputCost: number
  reasoningCost: number
  cacheReadCost: number
  cacheWriteCost: number
  totalCost: number
}

export type ModelPriceResolver = (model: string, timestampMs: number) => ModelPrice | null
export type PricingResult = 'reported' | 'priced' | 'unpriced'

export const OFFICIAL_MODEL_CATALOG_EVIDENCE = {
  claudeModels: 'https://platform.claude.com/docs/en/about-claude/models/overview',
  claudePricing: 'https://platform.claude.com/docs/en/about-claude/pricing',
  claudeReleases: 'https://platform.claude.com/docs/en/release-notes/overview',
  deepseekPricing: 'https://api-docs.deepseek.com/quick_start/pricing',
  deepseekReleases: 'https://api-docs.deepseek.com/updates/',
  mimoPricing: 'https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go',
  mimoReleases: 'https://mimo.mi.com/docs/zh-CN/news/latest/v2.5-price-update',
  glmPricing: 'https://bigmodel.cn/pricing',
  glmReleases: 'https://docs.bigmodel.cn/cn/update/new-releases',
  minimaxPricing: 'https://platform.minimaxi.com/docs/guides/pricing-paygo',
  minimaxReleases: 'https://minimaxi.com/models/text/m3',
  kimiK3Pricing: 'https://platform.kimi.ai/docs/pricing/chat-k3.md',
  kimiK27CodePricing: 'https://platform.kimi.ai/docs/pricing/chat-k27-code.md',
  kimiChatPricing: 'https://platform.kimi.ai/docs/pricing/chat',
  moonshotReleases: 'https://www.moonshot.ai/',
  checkedAt: '2026-08-02',
} as const

export const MODEL_ID_ALIASES: Record<string, string> = {
  'k2p5': 'kimi-k2.5',
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-flash',
  'kimi-code/kimi-for-coding': 'kimi-k2.5',
  'kimi-for-coding': 'kimi-k2.5',
  'kimi-k2-thinking': 'kimi-k2.5',
  'mimo-v2-flash': 'mimo-v2.5',
  'mimo-v2-omni': 'mimo-v2.5',
  'mimo-v2-pro': 'mimo-v2.5-pro',
  'GLM-5.2': 'glm-5.2',
  'GLM-5.1': 'glm-5.1',
  'GLM-5-Turbo': 'glm-5-turbo',
  'GLM-5': 'glm-5',
  'GLM-4.7': 'glm-4.7',
  'GLM-4.5-Air': 'glm-4.5-air',
  'Pro/zai-org/GLM-5': 'glm-5',
  'zhanlu/glm-4.7': 'glm-4.7',
  'Pro/MiniMaxAI/MiniMax-M2.5': 'MiniMax-M2.5',
  'minimax-m2.5': 'MiniMax-M2.5',
  'minimax-m2.5-highspeed': 'MiniMax-M2.5-highspeed',
  'minimax-m2.7': 'MiniMax-M2.7',
  'minimax-m2.7-highspeed': 'MiniMax-M2.7-highspeed',
  'zhanlu/minimax-2.7': 'MiniMax-M2.7',
  'M-3': 'MiniMax-M3',
  'M-2.7': 'MiniMax-M2.7',
}

export const OFFICIAL_MODEL_PRICE_VERSIONS: OfficialModelPriceVersion[] = [
  {
    modelId: 'deepseek-v4-flash', provider: 'deepseek',
    validFromMs: Date.parse('2026-04-24T00:00:00.000Z'), validToMs: null,
    inputPrice: 0.14, outputPrice: 0.28, cacheReadPrice: 0.0028, cacheWritePrice: null,
    perTokens: 1_000_000, cacheSemantics: 'hit_miss', contextWindow: 1_000_000,
    sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing', sourceCheckedAt: '2026-08-02',
  },
  {
    modelId: 'deepseek-v4-pro', provider: 'deepseek',
    validFromMs: Date.parse('2026-04-24T00:00:00.000Z'), validToMs: null,
    inputPrice: 0.435, outputPrice: 0.87, cacheReadPrice: 0.003625, cacheWritePrice: null,
    perTokens: 1_000_000, cacheSemantics: 'hit_miss', contextWindow: 1_000_000,
    sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing', sourceCheckedAt: '2026-08-02',
  },
  {
    modelId: 'mimo-v2.5', provider: 'xiaomi',
    validFromMs: Date.parse('2026-05-27T00:00:00+08:00'), validToMs: null,
    inputPrice: 0.14, outputPrice: 0.28, cacheReadPrice: 0.0028, cacheWritePrice: null,
    perTokens: 1_000_000, cacheSemantics: 'hit_miss', contextWindow: 1_000_000,
    sourceUrl: 'https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go', sourceCheckedAt: '2026-08-02',
  },
  {
    modelId: 'mimo-v2.5-pro', provider: 'xiaomi',
    validFromMs: Date.parse('2026-05-27T00:00:00+08:00'), validToMs: null,
    inputPrice: 0.435, outputPrice: 0.87, cacheReadPrice: 0.0036, cacheWritePrice: null,
    perTokens: 1_000_000, cacheSemantics: 'hit_miss', contextWindow: 1_000_000,
    sourceUrl: 'https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go', sourceCheckedAt: '2026-08-02',
  },
  {
    modelId: 'claude-opus-5', provider: 'anthropic',
    validFromMs: Date.parse('2026-07-24T00:00:00.000Z'), validToMs: null,
    inputPrice: 5, outputPrice: 25, cacheReadPrice: 0.5, cacheWritePrice: 6.25,
    perTokens: 1_000_000, cacheSemantics: 'anthropic', contextWindow: 1_000_000,
    sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing', sourceCheckedAt: '2026-08-02',
  },
  {
    modelId: 'claude-sonnet-5', provider: 'anthropic',
    validFromMs: Date.parse('2026-06-30T00:00:00.000Z'), validToMs: Date.parse('2026-09-01T00:00:00.000Z'),
    inputPrice: 2, outputPrice: 10, cacheReadPrice: 0.2, cacheWritePrice: 2.5,
    perTokens: 1_000_000, cacheSemantics: 'anthropic', contextWindow: 1_000_000,
    sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing', sourceCheckedAt: '2026-08-02',
  },
  {
    modelId: 'claude-sonnet-5', provider: 'anthropic',
    validFromMs: Date.parse('2026-09-01T00:00:00.000Z'), validToMs: null,
    inputPrice: 3, outputPrice: 15, cacheReadPrice: 0.3, cacheWritePrice: 3.75,
    perTokens: 1_000_000, cacheSemantics: 'anthropic', contextWindow: 1_000_000,
    sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing', sourceCheckedAt: '2026-08-02',
  },
  {
    modelId: 'kimi-k2.7-code', provider: 'moonshot',
    validFromMs: Date.parse('2026-06-12T00:00:00.000Z'), validToMs: null,
    inputPrice: 0.95, outputPrice: 4, cacheReadPrice: 0.19, cacheWritePrice: null,
    perTokens: 1_000_000, cacheSemantics: 'hit_miss', contextWindow: 262_144,
    sourceUrl: 'https://platform.kimi.ai/docs/pricing/chat-k27-code.md', sourceCheckedAt: '2026-08-02',
  },
  {
    modelId: 'kimi-k3', provider: 'moonshot',
    validFromMs: Date.parse('2026-07-16T00:00:00.000Z'), validToMs: null,
    inputPrice: 3, outputPrice: 15, cacheReadPrice: 0.3, cacheWritePrice: null,
    perTokens: 1_000_000, cacheSemantics: 'hit_miss', contextWindow: 1_048_576,
    sourceUrl: 'https://platform.kimi.ai/docs/pricing/chat-k3.md', sourceCheckedAt: '2026-08-02',
  },
]

const DEFAULT_MODEL_PRICES: Array<[string, string, number, number, number, number]> = [
  ['claude-fable-5', 'anthropic', 10, 50, 1, 12.5],
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
  ['deepseek-v4-flash', 'deepseek', 0.14, 0.28, 0.0028, 0],
  ['deepseek-v4-pro', 'deepseek', 0.435, 0.87, 0.003625, 0],
  ['mimo-v2.5', 'xiaomi', 0.14, 0.28, 0.0028, 0],
  ['mimo-v2.5-pro', 'xiaomi', 0.435, 0.87, 0.0036, 0],
  ['MiniMax-M2.5', 'minimax', 0.3, 1.2, 0.03, 0.375],
  ['MiniMax-M2.5-highspeed', 'minimax', 0.6, 2.4, 0.03, 0.375],
  ['MiniMax-M2.7-highspeed', 'minimax', 0.6, 2.4, 0.06, 0.375],
  ['glm-5.2', 'zhipu', 1.4, 4.4, 0.26, 0],
  ['glm-5.1', 'zhipu', 1.4, 4.4, 0.26, 0],
  ['glm-5', 'zhipu', 1, 3.2, 0.2, 0],
  ['glm-5-turbo', 'zhipu', 1.2, 4, 0.24, 0],
  ['glm-4.7', 'zhipu', 0.6, 2.2, 0.11, 0],
  ['glm-4.7-flashx', 'zhipu', 0.07, 0.4, 0.01, 0],
  ['glm-4.5-air', 'zhipu', 0.2, 1.1, 0.03, 0],
  ['glm-4.7-free', 'zhipu', 0, 0, 0, 0],
  // MiniMax M3 缓存写未公布，按 M2.7 同款 1.25x input 估算
  ['MiniMax-M3', 'minimax', 0.3, 1.2, 0.06, 0.375],
  ['MiniMax-M2.7', 'minimax', 0.3, 1.2, 0.06, 0.375],
  ['minimax-m2.1-free', 'minimax', 0, 0, 0, 0],
  ['grok-code', 'xai', 0.2, 1.5, 0.02, 0],
]

// 注意：alias 优先于精确匹配——有专属价格行的模型不要放进来
const priceMap = new Map<string, ModelPrice>()
for (const [modelId, provider, inp, out, cr, cw] of DEFAULT_MODEL_PRICES) {
  priceMap.set(modelId, {
    modelId, provider,
    inputPrice: inp, outputPrice: out,
    cacheReadPrice: cr, cacheWritePrice: cw,
    perTokens: 1_000_000,
    cacheSemantics: provider === 'moonshot' ? 'hit_miss' : 'generic',
  })
}

const officialVersionsByModel = new Map<string, OfficialModelPriceVersion[]>()
for (const row of OFFICIAL_MODEL_PRICE_VERSIONS) {
  const rows = officialVersionsByModel.get(row.modelId) || []
  rows.push(row)
  officialVersionsByModel.set(row.modelId, rows)
}

function resolveBundledPrice(model: string, timestampMs: number): ModelPrice | null {
  const exactVersions = officialVersionsByModel.get(model)
  if (exactVersions) {
    return exactVersions.find((row) => (
      timestampMs >= row.validFromMs
      && (row.validToMs == null || timestampMs < row.validToMs)
    )) || null
  }

  const canonical = MODEL_ID_ALIASES[model] || model
  let p = priceMap.get(canonical)
  if (p) return p
  const stripped = canonical.replace(/-\d{8,}$/, '')
  if (officialVersionsByModel.has(stripped)) return null
  if (stripped !== canonical) p = priceMap.get(stripped)
  return p || null
}

function flatRowToPrice(row: FlatModelPriceRow, semantics?: CacheSemantics): ModelPrice {
  return {
    modelId: row.model_id,
    provider: row.provider || 'unknown',
    inputPrice: Number(row.input_price),
    outputPrice: Number(row.output_price),
    cacheReadPrice: Number(row.cache_read_price),
    cacheWritePrice: Number(row.cache_write_price),
    perTokens: Number(row.per_tokens) || 1_000_000,
    cacheSemantics: semantics || (row.provider === 'moonshot' ? 'hit_miss' : 'generic'),
  }
}

function versionRowToPrice(row: VersionedModelPriceRow): ModelPrice {
  return {
    modelId: row.model_id,
    provider: row.provider,
    inputPrice: Number(row.input_price),
    outputPrice: Number(row.output_price),
    cacheReadPrice: Number(row.cache_read_price),
    cacheWritePrice: row.cache_write_price == null ? null : Number(row.cache_write_price),
    perTokens: Number(row.per_tokens) || 1_000_000,
    cacheSemantics: row.cache_semantics,
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

  return (model: string, timestampMs: number) => {
    const exactFlat = flatByModel.get(model)
    const exactVersions = versionsByModel.get(model)
    const activeVersion = exactVersions?.find((row) => (
      timestampMs >= row.valid_from_ms
      && (row.valid_to_ms == null || timestampMs < row.valid_to_ms)
    ))

    if (exactVersions) {
      if (!activeVersion) return null
      if (exactFlat?.source === 'manual') {
        return flatRowToPrice(exactFlat, activeVersion.cache_semantics)
      }
      return versionRowToPrice(activeVersion)
    }
    if (exactFlat) return flatRowToPrice(exactFlat)

    const stripped = model.replace(/-\d{8,}$/, '')
    if (stripped === model || versionsByModel.has(stripped)) return null
    const strippedFlat = flatByModel.get(stripped)
    return strippedFlat ? flatRowToPrice(strippedFlat) : null
  }
}

export function priceUsageEvent(
  event: PriceableUsageEvent,
  resolvePrice: ModelPriceResolver,
): PricingResult {
  if (event.totalCost !== 0) return 'reported'
  if (event.totalTokens <= 0) return 'unpriced'

  const price = resolvePrice(event.model, event.timestampMs)
  if (!price) return 'unpriced'
  if (price.cacheSemantics === 'hit_miss' && event.cacheWriteTokens !== 0) return 'unpriced'
  if (event.cacheWriteTokens > 0 && price.cacheWritePrice == null) return 'unpriced'

  const pt = price.perTokens
  const inputCost = (event.inputTokens * price.inputPrice) / pt
  const outputCost = (event.outputTokens * price.outputPrice) / pt
  const reasoningCost = (event.reasoningTokens * price.outputPrice) / pt
  const cacheReadCost = (event.cacheReadTokens * price.cacheReadPrice) / pt
  const cacheWriteCost = price.cacheWritePrice == null
    ? 0
    : (event.cacheWriteTokens * price.cacheWritePrice) / pt

  event.inputCost = inputCost
  event.outputCost = outputCost
  event.reasoningCost = reasoningCost
  event.cacheReadCost = cacheReadCost
  event.cacheWriteCost = cacheWriteCost
  event.totalCost = inputCost + outputCost + reasoningCost + cacheReadCost + cacheWriteCost
  return 'priced'
}

export function applyEstimatedCosts(event: PriceableUsageEvent): PricingResult {
  return priceUsageEvent(event, resolveBundledPrice)
}
