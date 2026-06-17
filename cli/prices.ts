interface ModelPrice {
  modelId: string
  provider: string
  inputPrice: number
  outputPrice: number
  cacheReadPrice: number
  cacheWritePrice: number
  perTokens: number
}

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
const MODEL_PRICE_ALIASES: Record<string, string> = {
  'k2p7': 'kimi-k2.7',
  'k2p6': 'kimi-k2.6',
  'k2p5': 'kimi-k2.5',
  'kimi-for-coding': 'kimi-k2.5',
  'kimi-code/kimi-for-coding': 'kimi-k2.5',
  'M-3': 'MiniMax-M3',
  'M-2.7': 'MiniMax-M2.7',
}

const priceMap = new Map<string, ModelPrice>()
for (const [modelId, provider, inp, out, cr, cw] of DEFAULT_MODEL_PRICES) {
  priceMap.set(modelId, {
    modelId, provider,
    inputPrice: inp, outputPrice: out,
    cacheReadPrice: cr, cacheWritePrice: cw,
    perTokens: 1_000_000,
  })
}

function findPrice(model: string): ModelPrice | null {
  const canonical = MODEL_PRICE_ALIASES[model] || model
  let p = priceMap.get(canonical)
  if (p) return p
  const stripped = canonical.replace(/-\d{8,}$/, '')
  if (stripped !== canonical) p = priceMap.get(stripped)
  return p || null
}

export function applyEstimatedCosts(event: {
  model: string
  totalTokens: number; totalCost: number
  inputTokens: number; outputTokens: number; reasoningTokens: number
  cacheReadTokens: number; cacheWriteTokens: number
  inputCost: number; outputCost: number; reasoningCost: number
  cacheReadCost: number; cacheWriteCost: number
}) {
  if (event.totalTokens <= 0 || event.totalCost !== 0) return
  const price = findPrice(event.model)
  if (!price) return
  const pt = price.perTokens
  event.inputCost = (event.inputTokens * price.inputPrice) / pt
  event.outputCost = (event.outputTokens * price.outputPrice) / pt
  event.reasoningCost = (event.reasoningTokens * price.outputPrice) / pt
  event.cacheReadCost = (event.cacheReadTokens * price.cacheReadPrice) / pt
  event.cacheWriteCost = (event.cacheWriteTokens * price.cacheWritePrice) / pt
  event.totalCost = event.inputCost + event.outputCost + event.reasoningCost + event.cacheReadCost + event.cacheWriteCost
}
