import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, AreaChart, Area, Line, ComposedChart
} from 'recharts'
import { api, SummaryData, DailyRow, ClaudeCodeSummary } from '../lib/api'
import MetricCard from '../components/MetricCard'
import { fmtTokens, fmtCost, fmtRelative, shortId, modelColor, trendPct } from '../lib/format'

const CUSTOM_TOOLTIP_STYLE = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-default)',
  borderRadius: '2px',
  padding: '8px 12px',
  fontSize: '11px',
  color: 'var(--text-primary)',
}

function DualTooltip({ active, payload, label }: Record<string, unknown>) {
  if (!active || !payload || !(payload as unknown[]).length) return null
  return (
    <div style={CUSTOM_TOOLTIP_STYLE}>
      <div style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>{String(label)}</div>
      {(payload as Array<{ name: string; value: number; color?: string }>).map((p) => (
        <div key={p.name} className="flex gap-2">
          <span style={{ color: p.color || 'var(--amber)' }}>{p.name}:</span>
          <span className="num">
            {p.name === '成本' ? fmtCost(p.value) : fmtTokens(p.value)}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function Dashboard() {
  const [summary, setSummary] = useState<SummaryData | null>(null)
  const [daily, setDaily] = useState<DailyRow[]>([])
  const [ccSummary, setCCSummary] = useState<ClaudeCodeSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      api.summary(),
      api.daily(14),
      api.claudeCodeSummary().catch(() => null),
    ])
      .then(([s, d, cc]) => { setSummary(s); setDaily(d); setCCSummary(cc) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingState />
  if (error) return <ErrorState message={error} />
  if (!summary) return null

  const { today, yesterday, modelDistribution, channelDistribution, topSessions, trend7, productBreakdown } = summary
  const tokenTrend = trendPct(today.totalTokens, yesterday.totalTokens)
  const costTrend = trendPct(today.totalCost, yesterday.totalCost)
  const cost7d = trend7.reduce((s, d) => s + d.cost, 0)

  const cc = productBreakdown?.claudeCode
  const oc = productBreakdown?.openClaw

  const hasData = today.callCount > 0

  // Summary card data
  const avgCallCost = today.callCount > 0 ? today.totalCost / today.callCount : 0
  const ccQuotaPct = ccSummary && ccSummary.config.monthlyQuota > 0
    ? (ccSummary.periodUsage.totalCost / ccSummary.config.monthlyQuota) * 100
    : 0

  return (
    <div className="p-6 space-y-6 fade-in">
      {/* Header */}
      <div className="flex items-baseline justify-between">
        <div>
          <h1
            className="text-lg font-semibold tracking-wide"
            style={{ fontFamily: 'Barlow Condensed', color: 'var(--text-primary)', letterSpacing: '0.04em' }}
          >
            仪表盘
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
            {new Date().toLocaleDateString('zh-CN', { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
        </div>
        {!hasData && (
          <span
            className="text-xs px-2 py-1 rounded-sm"
            style={{ background: 'var(--amber-bg)', color: 'var(--amber)', border: '1px solid var(--amber-dim)' }}
          >
            今日暂无数据 — 点击同步按钮导入
          </span>
        )}
      </div>

      {/* Summary cards row — 5 cards */}
      <div className="grid grid-cols-5 gap-3">
        <SummaryCard
          label="今日总花费"
          value={fmtCost(today.totalCost)}
          trend={costTrend}
          costLike
        />
        <SummaryCard
          label="今日Token用量"
          value={fmtTokens(today.totalTokens)}
          trend={tokenTrend}
        />
        <SummaryCard
          label="活跃会话"
          value={String(today.sessions)}
        />
        <SummaryCard
          label="平均调用成本"
          value={fmtCost(avgCallCost)}
        />
        <SummaryCard
          label="Claude Code额度"
          value={`${ccQuotaPct.toFixed(1)}%`}
          progress={ccQuotaPct}
        />
      </div>

      {/* Metrics row */}
      <div className="grid grid-cols-4 gap-3">
        <MetricCard
          label="今日Token"
          value={fmtTokens(today.totalTokens)}
          sub={`${today.callCount} 次调用`}
          trend={tokenTrend}
          accent="amber"
          approx
        />
        <MetricCard
          label="今日预估成本"
          value={fmtCost(today.totalCost)}
          sub={`昨日 ${fmtCost(yesterday.totalCost)}`}
          trend={costTrend}
          accent="teal"
          approx
        />
        <MetricCard
          label="会话数"
          value={String(today.sessions)}
          sub="今日活跃"
          accent="amber"
        />
        <MetricCard
          label="7日成本"
          value={fmtCost(cost7d)}
          sub={`${trend7.length} 天`}
          accent="teal"
          approx
        />
      </div>

      {/* Product breakdown */}
      {cc && oc && (
        <div className="grid grid-cols-2 gap-3">
          <ProductCard
            name="Claude Code"
            icon="terminal"
            todayCost={cc.today.totalCost}
            todayTokens={cc.today.totalTokens}
            todayCalls={cc.today.callCount}
            cost7d={cc.cost7d}
            link="/claude-code"
          />
          <ProductCard
            name="OpenClaw"
            icon="openclaw"
            todayCost={oc.today.totalCost}
            todayTokens={oc.today.totalTokens}
            todayCalls={oc.today.callCount}
            cost7d={oc.cost7d}
            link="/channels"
          />
        </div>
      )}

      {/* Charts row */}
      <div className="grid grid-cols-3 gap-3">
        {/* 14-day dual trend: tokens + cost */}
        <div className="card col-span-2 p-4">
          <div className="flex items-center justify-between mb-3">
            <span style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              14日趋势
            </span>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full" style={{ background: 'var(--amber)' }} />
                <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>Token</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full" style={{ background: 'var(--teal)' }} />
                <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>成本</span>
              </div>
              <Link to="/models" style={{ color: 'var(--teal)', fontSize: '10px' }}>
                按模型查看 →
              </Link>
            </div>
          </div>
          {daily.length > 0 ? (
            <ResponsiveContainer width="100%" height={140}>
              <ComposedChart data={daily} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="tokenGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--amber)" stopOpacity={0.25} />
                    <stop offset="100%" stopColor="var(--amber)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="day"
                  tick={{ fill: 'var(--text-muted)', fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: string) => v.slice(5)}
                />
                <YAxis
                  yAxisId="tokens"
                  tick={{ fill: 'var(--text-muted)', fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => fmtTokens(v)}
                />
                <YAxis
                  yAxisId="cost"
                  orientation="right"
                  tick={{ fill: 'var(--text-muted)', fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => `$${v.toFixed(1)}`}
                />
                <Tooltip content={<DualTooltip />} />
                <Area
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="tokens"
                  name="Token"
                  stroke="var(--amber)"
                  strokeWidth={1.5}
                  fill="url(#tokenGrad)"
                  dot={false}
                />
                <Line
                  yAxisId="cost"
                  type="monotone"
                  dataKey="cost"
                  name="成本"
                  stroke="var(--teal)"
                  strokeWidth={1.5}
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <EmptyChart />
          )}
        </div>

        {/* Model distribution */}
        <div className="card p-4">
          <div style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 12 }}>
            模型分布 · 今日
          </div>
          {modelDistribution.length > 0 ? (
            <div>
              <ResponsiveContainer width="100%" height={100}>
                <PieChart>
                  <Pie
                    data={modelDistribution}
                    dataKey="tokens"
                    nameKey="model"
                    cx="50%"
                    cy="50%"
                    innerRadius={28}
                    outerRadius={45}
                    strokeWidth={0}
                  >
                    {modelDistribution.map((entry) => (
                      <Cell key={entry.model} fill={modelColor(entry.model)} opacity={0.85} />
                    ))}
                  </Pie>
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null
                      const d = payload[0].payload as { model: string; tokens: number }
                      return (
                        <div style={CUSTOM_TOOLTIP_STYLE}>
                          <div style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>{d.model}</div>
                          <div className="num" style={{ color: 'var(--amber)' }}>{fmtTokens(d.tokens)}</div>
                        </div>
                      )
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="mt-2 space-y-1">
                {modelDistribution.slice(0, 4).map((m) => (
                  <div key={m.model} className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: modelColor(m.model) }} />
                    <span className="text-2xs truncate flex-1" style={{ color: 'var(--text-secondary)' }}>
                      {m.model}
                    </span>
                    <span className="num text-2xs" style={{ color: 'var(--amber)' }}>
                      {fmtTokens(m.tokens)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <EmptyChart height={160} />
          )}
        </div>
      </div>

      {/* Top sessions */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3">
          <span style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            热门会话 · 今日
          </span>
          <Link to="/sessions" style={{ color: 'var(--teal)', fontSize: '10px' }}>全部会话 →</Link>
        </div>
        {topSessions.length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>会话</th>
                <th>渠道</th>
                <th>模型</th>
                <th style={{ textAlign: 'right' }}>Token</th>
                <th style={{ textAlign: 'right' }}>预估成本</th>
                <th style={{ textAlign: 'right' }}>最近</th>
              </tr>
            </thead>
            <tbody>
              {topSessions.map((s) => (
                <tr key={s.session_id}>
                  <td>
                    <Link
                      to={`/sessions/${s.session_id}`}
                      className="num hover:underline"
                      style={{ color: 'var(--teal)', fontSize: '11px' }}
                    >
                      {shortId(s.session_id)}
                    </Link>
                  </td>
                  <td>
                    <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {s.channel}
                    </span>
                  </td>
                  <td>
                    <span className="text-2xs px-1.5 py-0.5 rounded-sm" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>
                      {s.model ? s.model.split('/').pop() : '—'}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="num text-xs" style={{ color: 'var(--amber)' }}>{fmtTokens(s.tokens)}</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="num text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {fmtCost(s.cost)} <span style={{ color: 'var(--text-muted)', fontSize: '9px' }}>~</span>
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                      {fmtRelative(s.lastAt)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ color: 'var(--text-muted)', fontSize: '12px', padding: '24px 0', textAlign: 'center' }}>
            今日暂无会话
          </div>
        )}
      </div>

      {/* Channel distribution — compact at bottom */}
      {channelDistribution.length > 0 && (
        <div className="card p-3">
          <div className="flex items-center justify-between mb-2">
            <span style={{ color: 'var(--text-muted)', fontSize: '10px', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              渠道
            </span>
            <Link to="/channels" style={{ color: 'var(--teal)', fontSize: '10px' }}>全部 →</Link>
          </div>
          <div className="flex gap-4 flex-wrap">
            {channelDistribution.map((ch) => {
              const maxTokens = Math.max(...channelDistribution.map((c) => c.tokens))
              const pct = maxTokens ? (ch.tokens / maxTokens) * 100 : 0
              return (
                <div key={ch.channel} className="flex-1 min-w-[120px] max-w-[200px]">
                  <div className="flex items-center justify-between mb-0.5">
                    <span style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>{ch.channel}</span>
                    <span className="num" style={{ color: 'var(--amber)', fontSize: '10px' }}>{fmtTokens(ch.tokens)}</span>
                  </div>
                  <div className="h-1 rounded-full" style={{ background: 'var(--border-default)' }}>
                    <div
                      className="h-1 rounded-full transition-all"
                      style={{ width: `${pct}%`, background: modelColor(ch.channel) }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/** Top-level summary card with trend arrow */
function SummaryCard({ label, value, trend, costLike, progress }: {
  label: string
  value: string
  trend?: number | null
  costLike?: boolean
  progress?: number
}) {
  const hasTrend = trend != null && Math.abs(trend) >= 0.5
  const isUp = trend != null && trend > 0
  // For costs, up = bad (red), down = good (green); for others, inverted
  const trendColor = costLike
    ? (isUp ? 'var(--rose)' : 'var(--green)')
    : (isUp ? 'var(--green)' : 'var(--rose)')
  const arrow = isUp ? '▲' : '▼'

  return (
    <div className="card p-4">
      <div style={{ color: 'var(--text-muted)', fontSize: '10px', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
        {label}
      </div>
      <div className="flex items-end justify-between">
        <span className="metric-num text-xl" style={{ color: 'var(--text-primary)' }}>
          {value}
        </span>
        {hasTrend && (
          <span className="num" style={{ color: trendColor, fontSize: '11px' }}>
            {arrow} {Math.abs(trend!).toFixed(0)}%
          </span>
        )}
      </div>
      {progress != null && (
        <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border-default)' }}>
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.min(progress, 100)}%`,
              background: progress > 90 ? 'var(--rose)' : progress > 70 ? 'var(--orange)' : 'var(--amber)',
            }}
          />
        </div>
      )}
    </div>
  )
}

function LoadingState() {
  return (
    <div className="p-6 space-y-6">
      <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>加载仪表盘…</div>
      <div className="grid grid-cols-5 gap-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="card p-4 h-20 animate-pulse" style={{ background: 'var(--bg-elevated)' }} />
        ))}
      </div>
    </div>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="p-6">
      <div className="card p-6" style={{ borderColor: 'var(--rose-dim)' }}>
        <div style={{ color: 'var(--rose)', fontSize: '12px' }}>错误: {message}</div>
        <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: 4 }}>
          请确认服务运行在端口 3001。
        </div>
      </div>
    </div>
  )
}

function ProductCard({ name, icon, todayCost, todayTokens, todayCalls, cost7d, link }: {
  name: string; icon: string; todayCost: number; todayTokens: number; todayCalls: number; cost7d: number; link: string
}) {
  const totalToday = todayCost
  return (
    <Link to={link} className="card p-4 transition-colors hover:border-amber-500/30" style={{ textDecoration: 'none' }}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div
            className="w-6 h-6 rounded-sm flex items-center justify-center"
            style={{ background: 'var(--bg-elevated)' }}
          >
            <span style={{ fontSize: '12px' }}>{icon === 'terminal' ? '>' : 'O'}</span>
          </div>
          <span
            className="text-xs font-medium"
            style={{ color: 'var(--text-primary)', fontFamily: 'Barlow', letterSpacing: '0.02em' }}
          >
            {name}
          </span>
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>→</span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <div style={{ color: 'var(--text-muted)', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>今日成本</div>
          <span className="num text-sm" style={{ color: 'var(--amber)' }}>{fmtCost(totalToday)}</span>
        </div>
        <div>
          <div style={{ color: 'var(--text-muted)', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>今日Token</div>
          <span className="num text-sm" style={{ color: 'var(--text-primary)' }}>{fmtTokens(todayTokens)}</span>
        </div>
        <div>
          <div style={{ color: 'var(--text-muted)', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>7日成本</div>
          <span className="num text-sm" style={{ color: 'var(--teal)' }}>{fmtCost(cost7d)}</span>
        </div>
      </div>
      <div className="mt-2" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
        今日 {todayCalls} 次调用
      </div>
    </Link>
  )
}

function EmptyChart({ height = 120 }: { height?: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-sm"
      style={{ height, background: 'var(--bg-elevated)', border: '1px dashed var(--border-default)' }}
    >
      <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>暂无数据</span>
    </div>
  )
}
