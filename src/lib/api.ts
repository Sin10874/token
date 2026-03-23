const BASE = '/api'

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`)
  return res.json()
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`)
  return res.json()
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`)
  return res.json()
}

export const api = {
  summary: (period?: string) => get<SummaryData>(period ? `/summary?period=${period}` : '/summary'),
  daily: (days = 30) => get<DailyRow[]>(`/daily?days=${days}`),
  models: () => get<ModelRow[]>('/models'),
  modelDetail: (id: string, days = 30) => get<ModelDetail>(`/models/${encodeURIComponent(id)}?days=${days}`),
  channels: (period?: string) => get<ChannelRow[]>(period ? `/channels?period=${period}` : '/channels'),
  channelDetail: (ch: string, days = 30) => get<ChannelDetail>(`/channels/${encodeURIComponent(ch)}?days=${days}`),
  sessions: (params?: SessionsParams) => {
    const q = new URLSearchParams()
    if (params?.channel) q.set('channel', params.channel)
    if (params?.model) q.set('model', params.model)
    if (params?.from) q.set('from', params.from)
    if (params?.to) q.set('to', params.to)
    if (params?.sort) q.set('sort', params.sort)
    if (params?.limit) q.set('limit', String(params.limit))
    if (params?.offset) q.set('offset', String(params.offset))
    if (params?.period) q.set('period', params.period)
    return get<SessionsResponse>(`/sessions?${q}`)
  },
  sessionDetail: (id: string) => get<SessionDetail>(`/sessions/${encodeURIComponent(id)}`),
  prices: () => get<PriceRow[]>('/settings/prices'),
  updatePrice: (modelId: string, prices: PriceUpdate) => put('/settings/prices/' + encodeURIComponent(modelId), prices),
  health: () => get<HealthData>('/health'),
  ingest: () => post<{ ok: boolean; stats: IngestionStats }>('/ingest'),
  fullIngest: () => post<{ ok: boolean; stats: IngestionStats }>('/ingest/full'),
  claudeCodeSummary: () => get<ClaudeCodeSummary>('/claude-code/summary'),
  claudeCodeConfig: () => get<ClaudeCodeConfig>('/claude-code/config'),
  updateClaudeCodeConfig: (config: Partial<ClaudeCodeConfig>) => put<{ ok: boolean }>('/claude-code/config', config),
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProductStats {
  totalTokens: number; totalCost: number; callCount: number; sessions: number
}

export interface SummaryData {
  today: { totalTokens: number; totalCost: number; sessions: number; channels: number; callCount: number }
  yesterday: { totalTokens: number; totalCost: number; callCount: number }
  modelDistribution: Array<{ model: string; provider: string; tokens: number; cost: number; calls: number }>
  channelDistribution: Array<{ channel: string; tokens: number; cost: number; sessions: number }>
  topSessions: Array<{ session_id: string; channel: string; model: string; agent: string; tokens: number; cost: number; calls: number; firstAt: number; lastAt: number }>
  trend7: Array<{ day: string; tokens: number; cost: number }>
  productBreakdown: {
    claudeCode: { today: ProductStats; cost7d: number; tokens7d: number }
    openClaw: { today: ProductStats; cost7d: number; tokens7d: number }
  }
}

export interface DailyRow {
  day: string
  tokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  calls: number
  sessions: number
}

export interface ModelRow {
  model: string
  provider: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalCost: number
  callCount: number
  sessionCount: number
  firstSeen: number
  lastSeen: number
}

export interface ModelDetail {
  summary: ModelRow & { avgTokensPerCall: number }
  dailyTrend: Array<{ day: string; tokens: number; cost: number; calls: number }>
  channelMix: Array<{ channel: string; calls: number; tokens: number }>
}

export interface ChannelRow {
  channel: string
  messageCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  totalCost: number
  callCount: number
  sessionCount: number
  modelCount: number
  firstSeen: number
  lastSeen: number
}

export interface ChannelDetail {
  summary: ChannelRow
  dailyTrend: Array<{ day: string; tokens: number; cost: number; calls: number }>
  modelMix: Array<{ model: string; calls: number; tokens: number }>
  topSessions: Array<{ session_id: string; model: string; tokens: number; cost: number; calls: number }>
}

export interface SessionsParams {
  channel?: string
  model?: string
  from?: string
  to?: string
  sort?: string
  limit?: number
  offset?: number
  period?: string
}

export interface SessionRow {
  session_id: string
  channel: string
  agent: string
  models: string
  tokens: number
  cost: number
  calls: number
  firstAt: number
  lastAt: number
}

export interface SessionsResponse {
  sessions: SessionRow[]
  total: number
}

export interface SessionDetail {
  session: { session_id: string; channel: string; agent: string; current_model: string; source_path: string } | null
  summary: { totalTokens: number; totalCost: number; callCount: number; firstAt: number; lastAt: number; channel: string; agent: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | null
  events: Array<{ id: string; timestamp_ms: number; model: string; provider: string; total_tokens: number; total_cost: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; stop_reason: string }>
  modelHistory: Array<{ model: string; firstAt: number; calls: number }>
}

export interface PriceRow {
  model_id: string
  provider: string
  input_price: number
  output_price: number
  cache_read_price: number
  cache_write_price: number
  per_tokens: number
  source: string
  updated_at: number
}

export interface PriceUpdate {
  inputPrice: number
  outputPrice: number
  cacheReadPrice: number
  cacheWritePrice: number
}

export interface HealthData {
  states: Array<{ source_path: string; last_processed_lines: number; last_scan_at: number; event_count: number }>
  warnings: Array<{ id: number; source_path: string; warning: string; created_at: number }>
  totalEvents: number
  totalSessions: number
  lastScanAt: number | null
}

export interface IngestionStats {
  filesProcessed: number
  eventsInserted: number
  sessionsUpdated: number
  warnings: string[]
  duration: number
}

export interface ClaudeCodeConfig {
  monthly_quota_usd: string
  billing_cycle_day: string
  plan_name: string
}

export interface ClaudeCodeSummary {
  config: { monthlyQuota: number; billingDay: number; planName: string }
  period: { startMs: number; endMs: number; daysLeft: number; daysTotal: number }
  periodUsage: {
    totalTokens: number; inputTokens: number; outputTokens: number
    cacheReadTokens: number; cacheWriteTokens: number
    totalCost: number; callCount: number; sessions: number
  }
  today: { totalTokens: number; totalCost: number; callCount: number; sessions: number }
  yesterday: { totalTokens: number; totalCost: number; callCount: number }
  week: { totalTokens: number; totalCost: number; callCount: number; sessions: number }
  modelDistribution: Array<{ model: string; tokens: number; cost: number; calls: number }>
  dailyTrend: Array<DailyRow>
  topProjects: Array<{ project: string; tokens: number; cost: number; calls: number; sessions: number; lastAt: number }>
}
