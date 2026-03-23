import { useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { api, ChannelRow, ChannelDetail } from '../lib/api'
import { fmtTokens, fmtCost, fmtRelative, modelColor, shortId } from '../lib/format'

const TOOLTIP_STYLE = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-default)',
  borderRadius: '2px',
  fontSize: '11px',
  color: 'var(--text-primary)',
}

const PERIOD_OPTIONS = [
  { value: '1d', label: '1d' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
] as const

export function ChannelsList() {
  const [channels, setChannels] = useState<ChannelRow[]>([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState('7d')
  const navigate = useNavigate()

  useEffect(() => {
    setLoading(true)
    api.channels(period).then(setChannels).finally(() => setLoading(false))
  }, [period])

  if (loading) return <PageShell title="频道"><Spinner /></PageShell>

  const maxTokens = Math.max(...channels.map((c) => c.totalTokens), 1)

  return (
    <PageShell title="频道" sub={`共 ${channels.length} 个频道`}>
      {/* Period filter */}
      <div className="flex items-center gap-1.5">
        {PERIOD_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setPeriod(opt.value)}
            className="px-3 py-1 rounded-sm text-xs font-medium transition-colors"
            style={{
              background: period === opt.value ? 'var(--amber-bg)' : 'var(--bg-elevated)',
              border: `1px solid ${period === opt.value ? 'var(--amber-dim)' : 'var(--border-default)'}`,
              color: period === opt.value ? 'var(--amber)' : 'var(--text-muted)',
              cursor: 'pointer',
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {channels.map((ch) => (
          <div
            key={ch.channel}
            className="card p-4 cursor-pointer transition-colors hover:border-amber-dim"
            onClick={() => navigate(`/channels/${encodeURIComponent(ch.channel)}`)}
            style={{ borderColor: 'var(--border-default)' }}
          >
            <div className="flex items-center gap-4">
              {/* Channel name + bar */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full" style={{ background: modelColor(ch.channel) }} />
                    <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>
                      {ch.channel}
                    </span>
                  </div>
                  <span className="num text-xs" style={{ color: 'var(--amber)' }}>
                    {fmtTokens(ch.totalTokens)}
                  </span>
                </div>
                <div className="h-1.5 rounded-full" style={{ background: 'var(--border-default)' }}>
                  <div
                    className="h-1.5 rounded-full"
                    style={{
                      width: `${(ch.totalTokens / maxTokens) * 100}%`,
                      background: modelColor(ch.channel),
                    }}
                  />
                </div>
              </div>

              {/* Stats */}
              <div className="flex items-center gap-6 shrink-0">
                <Stat label="消息数" value={ch.messageCount.toLocaleString()} />
                <Stat label="输入Token" value={fmtTokens(ch.inputTokens)} />
                <Stat label="输出Token" value={fmtTokens(ch.outputTokens)} />
                <Stat label="总Token" value={fmtTokens(ch.totalTokens)} />
                <Stat label="预估成本" value={fmtCost(ch.totalCost)} approx />
                <Stat label="最近" value={fmtRelative(ch.lastSeen)} />
              </div>
            </div>
          </div>
        ))}
        {channels.length === 0 && (
          <div className="card p-8 text-center" style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
            暂无频道数据。请点击侧边栏同步按钮。
          </div>
        )}
      </div>
    </PageShell>
  )
}

export function ChannelDetailPage() {
  const { channel } = useParams<{ channel: string }>()
  const [detail, setDetail] = useState<ChannelDetail | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!channel) return
    api.channelDetail(decodeURIComponent(channel)).then(setDetail).finally(() => setLoading(false))
  }, [channel])

  if (loading) return <PageShell title="频道" back="/channels"><Spinner /></PageShell>
  if (!detail || !detail.summary) return <PageShell title="频道" back="/channels"><div style={{ color: 'var(--text-muted)' }}>未找到</div></PageShell>

  const { summary, dailyTrend, modelMix, topSessions } = detail
  const decodedChannel = decodeURIComponent(channel || '')

  return (
    <PageShell title={decodedChannel} sub="频道详情" back="/channels">
      {/* Summary */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        {[
          { label: '总Token', value: fmtTokens(summary.totalTokens), color: 'var(--amber)' },
          { label: '预估成本', value: fmtCost(summary.totalCost), color: 'var(--teal)', approx: true },
          { label: '会话数', value: String(summary.sessionCount), color: 'var(--amber)' },
          { label: '调用次数', value: summary.callCount.toLocaleString(), color: 'var(--teal)' },
        ].map((c) => (
          <div key={c.label} className="card p-4">
            <div style={{ color: 'var(--text-muted)', fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{c.label}</div>
            <div className="metric-num text-2xl mt-1" style={{ color: c.color }}>
              {c.value}
              {c.approx && <span style={{ color: 'var(--text-muted)', fontSize: '9px', marginLeft: 4 }}>~</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {/* Daily trend */}
        <div className="card p-4 col-span-2">
          <div style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
            每日活动
          </div>
          {dailyTrend.length > 0 ? (
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={dailyTrend} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <XAxis dataKey="day" tick={{ fill: 'var(--text-muted)', fontSize: 9 }} axisLine={false} tickLine={false} tickFormatter={(v: string) => v.slice(5)} />
                <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 9 }} axisLine={false} tickLine={false} tickFormatter={(v: number) => fmtTokens(v)} />
                <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [fmtTokens(v), 'Token']} />
                <Bar dataKey="tokens" fill={modelColor(decodedChannel)} opacity={0.8} radius={[1, 1, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>暂无趋势数据</span>
            </div>
          )}
        </div>

        {/* Model mix */}
        <div className="card p-4">
          <div style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
            模型分布
          </div>
          <div className="space-y-2 mt-2">
            {modelMix.map((m) => {
              const maxCalls = Math.max(...modelMix.map((x) => x.calls), 1)
              return (
                <div key={m.model}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-2xs truncate" style={{ color: 'var(--text-secondary)', maxWidth: 120 }}>{m.model}</span>
                    <span className="num text-2xs" style={{ color: 'var(--text-muted)' }}>{m.calls}</span>
                  </div>
                  <div className="h-1 rounded-full" style={{ background: 'var(--border-default)' }}>
                    <div
                      className="h-1 rounded-full"
                      style={{ width: `${(m.calls / maxCalls) * 100}%`, background: modelColor(m.model) }}
                    />
                  </div>
                </div>
              )
            })}
            {modelMix.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>暂无数据</span>}
          </div>
        </div>
      </div>

      {/* Top sessions */}
      <div className="card mt-3">
        <div className="px-4 pt-4 pb-2" style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          热门会话
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>会话 ID</th>
              <th>模型</th>
              <th style={{ textAlign: 'right' }}>调用次数</th>
              <th style={{ textAlign: 'right' }}>Token</th>
              <th style={{ textAlign: 'right' }}>预估成本</th>
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
                  <span className="text-2xs" style={{ color: 'var(--text-secondary)' }}>
                    {s.model || '—'}
                  </span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <span className="num text-xs" style={{ color: 'var(--text-secondary)' }}>{s.calls}</span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <span className="num text-xs" style={{ color: 'var(--amber)' }}>{fmtTokens(s.tokens)}</span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <span className="num text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {fmtCost(s.cost)} <span style={{ color: 'var(--text-muted)', fontSize: '9px' }}>~</span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {topSessions.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>暂无会话</div>}
      </div>
    </PageShell>
  )
}

function Stat({ label, value, approx }: { label: string; value: string; approx?: boolean }) {
  return (
    <div className="text-center">
      <div style={{ color: 'var(--text-muted)', fontSize: '9px', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</div>
      <div className="num text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
        {value}{approx && <span style={{ color: 'var(--text-muted)', fontSize: '9px' }}> ~</span>}
      </div>
    </div>
  )
}

function PageShell({ title, sub, back, children }: { title: string; sub?: string; back?: string; children: React.ReactNode }) {
  return (
    <div className="p-6 space-y-4 fade-in">
      <div className="flex items-baseline gap-3">
        {back && <Link to={back} style={{ color: 'var(--text-muted)', fontSize: '11px' }}>← 返回</Link>}
        <div>
          <h1 className="text-lg font-semibold" style={{ fontFamily: 'Barlow Condensed', color: 'var(--text-primary)', letterSpacing: '0.04em' }}>
            {title.toUpperCase()}
          </h1>
          {sub && <p style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{sub}</p>}
        </div>
      </div>
      {children}
    </div>
  )
}

function Spinner() {
  return <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>加载中…</div>
}
