import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, AreaChart, Area
} from 'recharts'
import { api, SummaryData, DailyRow } from '../lib/api'
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

function CustomTooltip({ active, payload, label }: Record<string, unknown>) {
  if (!active || !payload || !(payload as unknown[]).length) return null
  return (
    <div style={CUSTOM_TOOLTIP_STYLE}>
      <div style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>{String(label)}</div>
      {(payload as Array<{ name: string; value: number; color?: string }>).map((p) => (
        <div key={p.name} className="flex gap-2">
          <span style={{ color: p.color || 'var(--amber)' }}>{p.name}:</span>
          <span className="num">{typeof p.value === 'number' && p.value > 1000 ? fmtTokens(p.value) : String(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

export default function Dashboard() {
  const [summary, setSummary] = useState<SummaryData | null>(null)
  const [daily, setDaily] = useState<DailyRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([api.summary(), api.daily(14)])
      .then(([s, d]) => { setSummary(s); setDaily(d) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingState />
  if (error) return <ErrorState message={error} />
  if (!summary) return null

  const { today, yesterday, modelDistribution, channelDistribution, topSessions, trend7 } = summary
  const tokenTrend = trendPct(today.totalTokens, yesterday.totalTokens)
  const costTrend = trendPct(today.totalCost, yesterday.totalCost)

  const hasData = today.callCount > 0

  return (
    <div className="p-6 space-y-6 fade-in">
      {/* Header */}
      <div className="flex items-baseline justify-between">
        <div>
          <h1
            className="text-lg font-semibold tracking-wide"
            style={{ fontFamily: 'Barlow Condensed', color: 'var(--text-primary)', letterSpacing: '0.04em' }}
          >
            DASHBOARD
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
        </div>
        {!hasData && (
          <span
            className="text-xs px-2 py-1 rounded-sm"
            style={{ background: 'var(--amber-bg)', color: 'var(--amber)', border: '1px solid var(--amber-dim)' }}
          >
            No data today — run Sync to ingest
          </span>
        )}
      </div>

      {/* Metrics row */}
      <div className="grid grid-cols-4 gap-3">
        <MetricCard
          label="Today Tokens"
          value={fmtTokens(today.totalTokens)}
          sub={`${today.callCount} calls`}
          trend={tokenTrend}
          accent="amber"
          approx
        />
        <MetricCard
          label="Est. Cost Today"
          value={fmtCost(today.totalCost)}
          sub={`vs ${fmtCost(yesterday.totalCost)} yesterday`}
          trend={costTrend}
          accent="teal"
          approx
        />
        <MetricCard
          label="Sessions"
          value={String(today.sessions)}
          sub="active today"
          accent="amber"
        />
        <MetricCard
          label="Channels"
          value={String(today.channels)}
          sub="active today"
          accent="teal"
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-3 gap-3">
        {/* 14-day trend */}
        <div className="card col-span-2 p-4">
          <div className="flex items-center justify-between mb-3">
            <span style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              14-Day Token Trend
            </span>
            <Link to="/models" style={{ color: 'var(--teal)', fontSize: '10px' }}>
              by model →
            </Link>
          </div>
          {daily.length > 0 ? (
            <ResponsiveContainer width="100%" height={140}>
              <AreaChart data={daily} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
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
                  tick={{ fill: 'var(--text-muted)', fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => fmtTokens(v)}
                />
                <Tooltip content={<CustomTooltip />} />
                <Area
                  type="monotone"
                  dataKey="tokens"
                  name="Tokens"
                  stroke="var(--amber)"
                  strokeWidth={1.5}
                  fill="url(#tokenGrad)"
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <EmptyChart />
          )}
        </div>

        {/* Model distribution */}
        <div className="card p-4">
          <div style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 12 }}>
            Model Mix · Today
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

      {/* Bottom row: channel dist + top sessions */}
      <div className="grid grid-cols-3 gap-3">
        {/* Channel distribution */}
        <div className="card p-4">
          <div style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>
            Channels
          </div>
          {channelDistribution.length > 0 ? (
            <div className="space-y-2">
              {channelDistribution.map((ch) => {
                const maxTokens = Math.max(...channelDistribution.map((c) => c.tokens))
                const pct = maxTokens ? (ch.tokens / maxTokens) * 100 : 0
                return (
                  <Link key={ch.channel} to={`/channels`} className="block group">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs" style={{ color: 'var(--text-primary)' }}>{ch.channel}</span>
                      <span className="num text-xs" style={{ color: 'var(--amber)' }}>{fmtTokens(ch.tokens)}</span>
                    </div>
                    <div className="h-1 rounded-full" style={{ background: 'var(--border-default)' }}>
                      <div
                        className="h-1 rounded-full transition-all"
                        style={{ width: `${pct}%`, background: modelColor(ch.channel) }}
                      />
                    </div>
                  </Link>
                )
              })}
            </div>
          ) : (
            <EmptyChart height={100} />
          )}
        </div>

        {/* Top sessions */}
        <div className="card col-span-2 p-4">
          <div className="flex items-center justify-between mb-3">
            <span style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Top Sessions · Today
            </span>
            <Link to="/sessions" style={{ color: 'var(--teal)', fontSize: '10px' }}>all sessions →</Link>
          </div>
          {topSessions.length > 0 ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Channel</th>
                  <th>Model</th>
                  <th style={{ textAlign: 'right' }}>Tokens</th>
                  <th style={{ textAlign: 'right' }}>Est. Cost</th>
                  <th style={{ textAlign: 'right' }}>Last</th>
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
              No sessions today
            </div>
          )}
        </div>
      </div>

      {/* 7-day summary bar */}
      {trend7.length > 1 && (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <span style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              7-Day Token Activity
            </span>
          </div>
          <ResponsiveContainer width="100%" height={80}>
            <BarChart data={trend7} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
              <XAxis
                dataKey="day"
                tick={{ fill: 'var(--text-muted)', fontSize: 9 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: string) => v.slice(5)}
              />
              <YAxis hide />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="tokens" name="Tokens" fill="var(--amber)" opacity={0.7} radius={[1, 1, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

function LoadingState() {
  return (
    <div className="p-6 space-y-6">
      <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Loading dashboard…</div>
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
        <div style={{ color: 'var(--rose)', fontSize: '12px' }}>Error: {message}</div>
        <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: 4 }}>
          Make sure the server is running on port 3001.
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
      <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>No data</span>
    </div>
  )
}
