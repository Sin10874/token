import { useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { api, ModelRow, ModelDetail } from '../lib/api'
import { fmtTokens, fmtCost, fmtRelative, modelColor } from '../lib/format'
import TokenBar, { TokenBarLegend } from '../components/TokenBar'

export function ModelsList() {
  const [models, setModels] = useState<ModelRow[]>([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    api.models().then(setModels).finally(() => setLoading(false))
  }, [])

  if (loading) return <PageShell title="模型"><Spinner /></PageShell>

  return (
    <PageShell title="模型" sub={`共 ${models.length} 个模型`}>
      <div className="card">
        <table className="data-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>提供商</th>
              <th style={{ textAlign: 'right' }}>调用次数</th>
              <th style={{ textAlign: 'right' }}>会话数</th>
              <th style={{ textAlign: 'right' }}>总Token</th>
              <th style={{ textAlign: 'right' }}>预估成本</th>
              <th style={{ textAlign: 'right' }}>最近使用</th>
              <th style={{ width: 120 }}>Token构成</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr
                key={m.model}
                onClick={() => navigate(`/models/${encodeURIComponent(m.model)}`)}
                style={{ cursor: 'pointer' }}
              >
                <td>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ background: modelColor(m.model) }} />
                    <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                      {m.model}
                    </span>
                  </div>
                </td>
                <td>
                  <span className="text-2xs px-1.5 py-0.5 rounded-sm" style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
                    {m.provider}
                  </span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <span className="num text-xs" style={{ color: 'var(--text-secondary)' }}>{m.callCount.toLocaleString()}</span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <span className="num text-xs" style={{ color: 'var(--text-secondary)' }}>{m.sessionCount}</span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <span className="num text-xs" style={{ color: 'var(--amber)' }}>{fmtTokens(m.totalTokens)}</span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <span className="num text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {fmtCost(m.totalCost)} <span style={{ color: 'var(--text-muted)', fontSize: '9px' }}>~</span>
                  </span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{fmtRelative(m.lastSeen)}</span>
                </td>
                <td>
                  <TokenBar
                    input={m.inputTokens}
                    output={m.outputTokens}
                    cacheRead={m.cacheReadTokens}
                    cacheWrite={m.cacheWriteTokens}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {models.length === 0 && <EmptyState />}
      </div>
      <div className="mt-2">
        <TokenBarLegend />
      </div>
    </PageShell>
  )
}

export function ModelDetailPage() {
  const { modelId } = useParams<{ modelId: string }>()
  const [detail, setDetail] = useState<ModelDetail | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!modelId) return
    api.modelDetail(decodeURIComponent(modelId)).then(setDetail).finally(() => setLoading(false))
  }, [modelId])

  if (loading) return <PageShell title="模型"><Spinner /></PageShell>
  if (!detail || !detail.summary) return <PageShell title="模型"><EmptyState /></PageShell>

  const { summary, dailyTrend, channelMix } = detail
  const s = summary

  return (
    <PageShell
      title={s.model}
      sub={s.provider}
      back="/models"
    >
      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        {[
          { label: '总Token', value: fmtTokens(s.totalTokens), accent: 'var(--amber)' },
          { label: '预估成本', value: fmtCost(s.totalCost), accent: 'var(--teal)' },
          { label: '调用次数', value: s.callCount.toLocaleString(), accent: 'var(--amber)' },
          { label: '平均/次', value: fmtTokens(Math.round(s.avgTokensPerCall || 0)), accent: 'var(--teal)' },
        ].map((c) => (
          <div key={c.label} className="card p-4">
            <div style={{ color: 'var(--text-muted)', fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{c.label}</div>
            <div className="metric-num text-2xl mt-1" style={{ color: c.accent }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Token breakdown */}
      <div className="card p-4 mb-3">
        <div style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 12 }}>
          Token明细
        </div>
        <div className="grid grid-cols-4 gap-4">
          {[
            { label: '输入', value: s.inputTokens, color: 'var(--amber)' },
            { label: '输出', value: s.outputTokens, color: 'var(--teal)' },
            { label: '缓存读取', value: s.cacheReadTokens, color: 'var(--violet)' },
            { label: '缓存写入', value: s.cacheWriteTokens, color: 'var(--orange)' },
          ].map((t) => (
            <div key={t.label}>
              <div style={{ color: 'var(--text-muted)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {t.label}
              </div>
              <div className="num mt-1" style={{ color: t.color, fontSize: '16px', fontWeight: 500 }}>
                {fmtTokens(t.value)}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                {s.totalTokens ? ((t.value / s.totalTokens) * 100).toFixed(1) : '0'}%
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3">
          <TokenBar input={s.inputTokens} output={s.outputTokens} cacheRead={s.cacheReadTokens} cacheWrite={s.cacheWriteTokens} />
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-3 gap-3">
        <div className="card p-4 col-span-2">
          <div style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
            每日趋势
          </div>
          {dailyTrend.length > 0 ? (
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={dailyTrend} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <XAxis dataKey="day" tick={{ fill: 'var(--text-muted)', fontSize: 9 }} axisLine={false} tickLine={false} tickFormatter={(v: string) => v.slice(5)} />
                <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 9 }} axisLine={false} tickLine={false} tickFormatter={(v: number) => fmtTokens(v)} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v: number) => [fmtTokens(v), 'Token']}
                />
                <Bar dataKey="tokens" fill={modelColor(s.model)} opacity={0.8} radius={[1, 1, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>暂无趋势数据</span>
            </div>
          )}
        </div>

        <div className="card p-4">
          <div style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
            频道分布
          </div>
          {channelMix.length > 0 ? (
            <div className="space-y-2 mt-2">
              {channelMix.map((ch) => {
                const maxCalls = Math.max(...channelMix.map((c) => c.calls))
                return (
                  <div key={ch.channel}>
                    <div className="flex items-center justify-between mb-1">
                      <span style={{ color: 'var(--text-secondary)', fontSize: '11px' }}>{ch.channel}</span>
                      <span className="num text-2xs" style={{ color: 'var(--text-muted)' }}>{ch.calls}</span>
                    </div>
                    <div className="h-1 rounded-full" style={{ background: 'var(--border-default)' }}>
                      <div
                        className="h-1 rounded-full"
                        style={{ width: `${(ch.calls / maxCalls) * 100}%`, background: modelColor(ch.channel) }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>暂无数据</span>
          )}
        </div>
      </div>
    </PageShell>
  )
}

const TOOLTIP_STYLE = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-default)',
  borderRadius: '2px',
  fontSize: '11px',
  color: 'var(--text-primary)',
}

// Shared shell
function PageShell({
  title,
  sub,
  back,
  children,
}: {
  title: string
  sub?: string
  back?: string
  children: React.ReactNode
}) {
  return (
    <div className="p-6 space-y-4 fade-in">
      <div className="flex items-baseline gap-3">
        {back && (
          <Link to={back} style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
            ← 返回
          </Link>
        )}
        <div>
          <h1
            className="text-lg font-semibold tracking-wide"
            style={{ fontFamily: 'Barlow Condensed', color: 'var(--text-primary)', letterSpacing: '0.04em' }}
          >
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

function EmptyState() {
  return (
    <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
      暂无数据。请点击侧边栏 <strong style={{ color: 'var(--amber)' }}>同步数据</strong> 按钮。
    </div>
  )
}
