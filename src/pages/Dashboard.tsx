import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
  BarChart, Bar
} from 'recharts'
import { Download } from 'lucide-react'
import { api, SummaryData, DailyRow } from '../lib/api'
import ExportModal from '../components/ExportModal'
import { fmtTokens, fmtCost, fmtRelative, shortId, modelColor, trendPct, fmtSessionName } from '../lib/format'

const CUSTOM_TOOLTIP_STYLE = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-default)',
  borderRadius: '3px',
  padding: '12px 16px',
  fontSize: '13px',
  color: 'var(--text-primary)',
}


export default function Dashboard() {
  const [summary, setSummary] = useState<SummaryData | null>(null)
  const [daily, setDaily] = useState<DailyRow[]>([])
  const [period, setPeriod] = useState<'1d' | '7d' | '30d'>('1d')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [trendMode, setTrendMode] = useState<'tokens' | 'cost'>('tokens')

  const periodDays = period === '1d' ? 1 : period === '7d' ? 7 : 30
  const periodLabel = period === '1d' ? '今日' : period === '7d' ? '近7天' : '近30天'

  useEffect(() => {
    setLoading(true)
    Promise.all([
      api.summary(period),
      api.daily(periodDays),
    ])
      .then(([s, d]) => { setSummary(s); setDaily(d) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [period, periodDays])

  if (loading) return <LoadingState />
  if (error) return <ErrorState message={error} />
  if (!summary) return null

  const { today, yesterday, modelDistribution, topSessions, trend7, botNicknames } = summary
  const chartData = period === '1d' ? trend7 : daily
  const tokenTrend = trendPct(today.totalTokens, yesterday.totalTokens)
  const costTrend = trendPct(today.totalCost, yesterday.totalCost)
  const hasData = today.callCount > 0

  // Summary card data
  const prevLabel = period === '1d' ? '昨日' : period === '7d' ? '上7天' : '上30天'

  const PERIOD_OPTIONS = [
    { label: '1d', value: '1d' as const },
    { label: '7d', value: '7d' as const },
    { label: '30d', value: '30d' as const },
  ]

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
        <div className="flex items-center gap-1">
          {!hasData && (
            <span
              className="text-xs px-2 py-1 rounded-sm mr-3"
              style={{ background: 'var(--amber-bg)', color: 'var(--amber)', border: '1px solid var(--amber-dim)' }}
            >
              {periodLabel}暂无数据 — 点击同步按钮导入
            </span>
          )}
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setPeriod(opt.value)}
              className="px-2.5 py-1 text-xs rounded-sm transition-colors"
              style={{
                fontFamily: 'Barlow Condensed',
                letterSpacing: '0.04em',
                background: period === opt.value ? 'var(--amber-bg)' : 'transparent',
                color: period === opt.value ? 'var(--amber)' : 'var(--text-muted)',
                border: `1px solid ${period === opt.value ? 'var(--amber-dim)' : 'var(--border-subtle)'}`,
              }}
            >
              {opt.label}
            </button>
          ))}
          <button
            onClick={() => setExportOpen(true)}
            className="ml-2 flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-sm transition-colors"
            style={{
              fontFamily: 'Barlow',
              background: 'var(--bg-elevated)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-default)',
            }}
            title="导出数据"
          >
            <Download size={11} strokeWidth={1.8} style={{ color: 'var(--amber)' }} />
            导出
          </button>
          <ExportModal isOpen={exportOpen} onClose={() => setExportOpen(false)} />
        </div>
      </div>

      {/* Summary cards row */}
      <div className="grid grid-cols-4 gap-3">
        <SummaryCard
          label={`${periodLabel}总花费`}
          value={fmtCost(today.totalCost)}
          sub={`${prevLabel} ${fmtCost(yesterday.totalCost)}`}
          trend={costTrend}
          costLike
        />
        <SummaryCard
          label={`${periodLabel}Token`}
          value={fmtTokens(today.totalTokens)}
          sub={`${prevLabel} ${fmtTokens(yesterday.totalTokens)}`}
          trend={tokenTrend}
        />
        <SummaryCard
          label="输入Token"
          value={fmtTokens(today.inputTokens)}
          sub={`${prevLabel} ${fmtTokens(yesterday.inputTokens)}`}
          trend={trendPct(today.inputTokens, yesterday.inputTokens)}
        />
        <SummaryCard
          label="输出Token"
          value={fmtTokens(today.outputTokens)}
          sub={`${prevLabel} ${fmtTokens(yesterday.outputTokens)}`}
          trend={trendPct(today.outputTokens, yesterday.outputTokens)}
        />
        <SummaryCard
          label="缓存Token"
          value={fmtTokens(today.cacheReadTokens)}
          sub={`${prevLabel} ${fmtTokens(yesterday.cacheReadTokens)}`}
          trend={trendPct(today.cacheReadTokens, yesterday.cacheReadTokens)}
        />
        <SummaryCard
          label="活跃会话"
          value={String(today.sessions)}
          sub={`${today.channels} 个频道`}
        />
        <SummaryCard
          label="总消息数"
          value={String(today.messageCount)}
          sub={`${prevLabel} ${yesterday.messageCount}`}
          trend={trendPct(today.messageCount, yesterday.messageCount)}
        />
        <SummaryCard
          label="用户消息数"
          value={String(today.userMessageCount)}
          sub={`${prevLabel} ${yesterday.userMessageCount}`}
          trend={trendPct(today.userMessageCount, yesterday.userMessageCount)}
        />
      </div>


      {/* Charts row */}
      <div className="grid grid-cols-3 gap-3">
        {/* Trend chart: stacked bars with Token/Cost toggle */}
        <div className="card col-span-2 flex flex-col pt-5 px-6 pb-3">
          <div className="flex items-center justify-between mb-3">
            <span style={{ color: 'var(--text-primary)', fontSize: '15px', fontWeight: 600, letterSpacing: '0.02em' }}>
              {periodLabel}趋势
            </span>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full" style={{ background: trendMode === 'tokens' ? 'var(--amber)' : 'var(--teal)' }} />
                <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>输入</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full" style={{ background: trendMode === 'tokens' ? 'var(--amber-dim)' : 'var(--teal-dim)' }} />
                <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>输出</span>
              </div>
              {(['tokens', 'cost'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setTrendMode(m)}
                  className="px-3 py-1 rounded-sm"
                  style={{
                    background: trendMode === m ? 'var(--bg-elevated)' : 'transparent',
                    color: trendMode === m ? 'var(--text-primary)' : 'var(--text-muted)',
                    border: `1px solid ${trendMode === m ? 'var(--border-bright)' : 'var(--border-subtle)'}`,
                    fontSize: '13px',
                  }}
                >
                  {m === 'tokens' ? 'Token' : '费用'}
                </button>
              ))}
            </div>
          </div>
          {chartData.length > 0 ? (
            <div className="flex-1 min-h-0">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 4, right: 4, left: -5, bottom: 0 }} barCategoryGap="20%">
                  <XAxis
                    dataKey="day"
                    tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={period === '1d' ? (v: string) => v.slice(-5) : (v: string) => v.slice(5)}
                  />
                  <YAxis
                    tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={trendMode === 'tokens' ? (v: number) => fmtTokens(v) : (v: number) => `$${v < 1 ? v.toFixed(2) : v.toFixed(1)}`}
                  />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null
                      const d = payload[0]?.payload as Record<string, number>
                      const tipLabel = period === '1d' ? String(label).slice(5) : label
                      if (trendMode === 'tokens') {
                        return (
                          <div style={CUSTOM_TOOLTIP_STYLE}>
                            <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginBottom: 4 }}>{tipLabel}</div>
                            <div className="num" style={{ fontSize: 12 }}>
                              <span style={{ color: 'var(--text-muted)' }}>总 Token: </span>
                              <span style={{ color: 'var(--text-primary)' }}>{fmtTokens(d.inputTokens + d.outputTokens)}</span>
                            </div>
                            <div className="num" style={{ fontSize: 12 }}>
                              <span style={{ color: 'var(--text-muted)' }}>输入: </span>
                              <span style={{ color: 'var(--amber)' }}>{fmtTokens(d.inputTokens)}</span>
                            </div>
                            <div className="num" style={{ fontSize: 12 }}>
                              <span style={{ color: 'var(--text-muted)' }}>输出: </span>
                              <span style={{ color: 'var(--amber-dim)' }}>{fmtTokens(d.outputTokens)}</span>
                            </div>
                            <div className="num" style={{ fontSize: 12, marginTop: 2 }}>
                              <span style={{ color: 'var(--teal)' }}>费用: {fmtCost(d.cost)}</span>
                            </div>
                          </div>
                        )
                      }
                      return (
                        <div style={CUSTOM_TOOLTIP_STYLE}>
                          <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginBottom: 4 }}>{tipLabel}</div>
                          <div className="num" style={{ fontSize: 12 }}>
                            <span style={{ color: 'var(--text-muted)' }}>总费用: </span>
                            <span style={{ color: 'var(--text-primary)' }}>{fmtCost(d.inputCost + d.outputCost)}</span>
                          </div>
                          <div className="num" style={{ fontSize: 12 }}>
                            <span style={{ color: 'var(--text-muted)' }}>输入: </span>
                            <span style={{ color: 'var(--teal)' }}>{fmtCost(d.inputCost)}</span>
                          </div>
                          <div className="num" style={{ fontSize: 12 }}>
                            <span style={{ color: 'var(--text-muted)' }}>输出: </span>
                            <span style={{ color: 'var(--teal-dim)' }}>{fmtCost(d.outputCost)}</span>
                          </div>
                        </div>
                      )
                    }}
                  />
                  {trendMode === 'tokens' ? (
                    <>
                      <Bar dataKey="inputTokens" stackId="t" fill="var(--amber)" maxBarSize={56} />
                      <Bar dataKey="outputTokens" stackId="t" fill="var(--amber-dim)" radius={[2, 2, 0, 0]} maxBarSize={56} />
                    </>
                  ) : (
                    <>
                      <Bar dataKey="inputCost" stackId="c" fill="var(--teal)" maxBarSize={56} />
                      <Bar dataKey="outputCost" stackId="c" fill="var(--teal-dim)" radius={[2, 2, 0, 0]} maxBarSize={56} />
                    </>
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyChart />
          )}
        </div>

        {/* Model distribution */}
        <div className="card p-6">
          <div style={{ color: 'var(--text-primary)', fontSize: '15px', fontWeight: 600, letterSpacing: '0.02em', marginBottom: 16 }}>
            模型分布 · {periodLabel}
          </div>
          {modelDistribution.length > 0 ? (() => {
            const totalModelTokens = modelDistribution.reduce((s, m) => s + m.tokens, 0)
            return (
              <div>
                <ResponsiveContainer width="100%" height={140}>
                  <PieChart>
                    <Pie
                      data={modelDistribution}
                      dataKey="tokens"
                      nameKey="model"
                      cx="50%"
                      cy="50%"
                      innerRadius={36}
                      outerRadius={58}
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
                        const pct = totalModelTokens > 0 ? ((d.tokens / totalModelTokens) * 100).toFixed(1) : '0'
                        return (
                          <div style={CUSTOM_TOOLTIP_STYLE}>
                            <div style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>{d.model}</div>
                            <div className="num" style={{ color: 'var(--amber)', fontSize: '13px' }}>
                              {fmtTokens(d.tokens)}
                              <span style={{ color: 'var(--text-secondary)', marginLeft: 6 }}>{pct}%</span>
                            </div>
                          </div>
                        )
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
                {/* Legend with percentage bars */}
                <div className="mt-4" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {modelDistribution.slice(0, 4).map((m) => {
                    const pct = totalModelTokens > 0 ? (m.tokens / totalModelTokens) * 100 : 0
                    return (
                      <div key={m.model}>
                        <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
                          <div className="flex items-center gap-2.5" style={{ minWidth: 0, flex: 1 }}>
                            <div className="shrink-0" style={{ width: 10, height: 10, borderRadius: '50%', background: modelColor(m.model) }} />
                            <span className="truncate" style={{ color: 'var(--text-primary)', fontSize: '13px' }}>
                              {m.model}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 shrink-0" style={{ marginLeft: 12 }}>
                            <span className="num" style={{ color: 'var(--amber)', fontSize: '14px', fontWeight: 500 }}>
                              {fmtTokens(m.tokens)}
                            </span>
                            <span className="num" style={{ color: 'var(--text-secondary)', fontSize: '12px', width: 42, textAlign: 'right' }}>
                              {pct.toFixed(1)}%
                            </span>
                          </div>
                        </div>
                        {/* Proportion bar */}
                        <div style={{ height: 3, borderRadius: 2, background: 'var(--border-default)', marginLeft: 22 }}>
                          <div style={{
                            height: '100%',
                            borderRadius: 2,
                            width: `${Math.max(pct, 0.5)}%`,
                            background: modelColor(m.model),
                            opacity: 0.7,
                          }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })() : (
            <EmptyChart height={200} />
          )}
        </div>
      </div>

      {/* Top sessions / projects */}
      <div className="card p-6">
        <div className="flex items-center justify-between mb-5">
          <span style={{ color: 'var(--text-primary)', fontSize: '15px', fontWeight: 600, letterSpacing: '0.02em' }}>
            热门会话/项目 · {periodLabel}
          </span>
          <Link to="/sessions" style={{ color: 'var(--teal)', fontSize: '13px' }}>全部会话 →</Link>
        </div>
        {topSessions.length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>会话/项目</th>
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
                      className="hover:underline"
                      style={{ color: 'var(--teal)', fontSize: '14px' }}
                    >
                      {fmtSessionName(s.agent, s.channel, s.session_key, botNicknames)}
                    </Link>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="num" style={{ color: 'var(--amber)', fontSize: '14px' }}>{fmtTokens(s.tokens)}</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="num" style={{ color: 'var(--text-primary)', fontSize: '14px' }}>
                      {fmtCost(s.cost)} <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>~</span>
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
                      {fmtRelative(s.lastAt)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ color: 'var(--text-muted)', fontSize: '14px', padding: '24px 0', textAlign: 'center' }}>
            {periodLabel}暂无会话
          </div>
        )}
      </div>
    </div>
  )
}

/** Top-level summary card with trend arrow */
function SummaryCard({ label, value, sub, trend, costLike, progress }: {
  label: string
  value: string
  sub?: string
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
    <div className="card p-5">
      <div style={{ color: 'var(--text-muted)', fontSize: '12px', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>
        {label}
      </div>
      <div className="flex items-end justify-between">
        <span className="metric-num text-2xl" style={{ color: 'var(--text-primary)' }}>
          {value}
        </span>
        {hasTrend && (
          <span className="num" style={{ color: trendColor, fontSize: '13px' }}>
            {arrow} {Math.abs(trend!).toFixed(0)}%
          </span>
        )}
      </div>
      {sub && (
        <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: 6 }}>{sub}</div>
      )}
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
      <div className="grid grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => (
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
