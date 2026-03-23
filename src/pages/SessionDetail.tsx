import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { api, SessionDetail } from '../lib/api'
import { fmtTokens, fmtCost, fmtDate, fmtTime, fmtDuration, modelColor } from '../lib/format'
import TokenBar, { TokenBarLegend } from '../components/TokenBar'

export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    api.sessionDetail(id).then(setDetail).finally(() => setLoading(false))
  }, [id])

  if (loading) {
    return (
      <div className="p-6">
        <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>加载会话…</div>
      </div>
    )
  }

  if (!detail || !detail.summary) {
    return (
      <div className="p-6">
        <Link to="/sessions" style={{ color: 'var(--text-muted)', fontSize: '11px' }}>← 会话列表</Link>
        <div className="mt-4" style={{ color: 'var(--text-muted)', fontSize: '12px' }}>未找到会话</div>
      </div>
    )
  }

  const { session, summary, events, modelHistory } = detail
  const duration = summary.lastAt - summary.firstAt

  // Build timeline data for chart
  const timelineData = events.map((e, i) => ({
    index: i + 1,
    tokens: e.total_tokens,
    cost: e.total_cost,
    time: e.timestamp_ms,
    model: e.model,
  }))

  const currentModel = session?.current_model || modelHistory?.[modelHistory.length - 1]?.model || 'unknown'

  return (
    <div className="p-6 space-y-4 fade-in">
      {/* Header */}
      <div className="flex items-baseline gap-3">
        <Link to="/sessions" style={{ color: 'var(--text-muted)', fontSize: '11px' }}>← 会话列表</Link>
        <div>
          <h1
            className="font-mono text-sm"
            style={{ color: 'var(--teal)', letterSpacing: '0.01em' }}
          >
            {id}
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
            {session?.channel || summary.channel} · {session?.agent || summary.agent} ·{' '}
            {fmtDate(summary.firstAt)} → {fmtDate(summary.lastAt)}
          </p>
        </div>
      </div>

      {/* Summary metrics */}
      <div className="grid grid-cols-5 gap-3">
        {[
          { label: '总Token', value: fmtTokens(summary.totalTokens), color: 'var(--amber)', approx: false },
          { label: '预估成本', value: fmtCost(summary.totalCost), color: 'var(--teal)', approx: true },
          { label: 'API调用', value: String(summary.callCount), color: 'var(--amber)', approx: false },
          { label: '时长', value: fmtDuration(duration), color: 'var(--teal)', approx: false },
          { label: '渠道', value: summary.channel || '—', color: 'var(--text-secondary)', approx: false },
        ].map((c) => (
          <div key={c.label} className="card p-3">
            <div style={{ color: 'var(--text-muted)', fontSize: '9px', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{c.label}</div>
            <div className="metric-num text-lg mt-0.5" style={{ color: c.color }}>
              {c.value}
              {c.approx && <span style={{ color: 'var(--text-muted)', fontSize: '9px', marginLeft: 3 }}>~</span>}
            </div>
          </div>
        ))}
      </div>

      {/* Token breakdown */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3">
          <span style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Token明细
          </span>
          <TokenBarLegend />
        </div>
        <div className="grid grid-cols-4 gap-4 mb-3">
          {[
            { label: '输入', value: summary.inputTokens, color: 'var(--amber)' },
            { label: '输出', value: summary.outputTokens, color: 'var(--teal)' },
            { label: '缓存读取', value: summary.cacheReadTokens, color: 'var(--violet)' },
            { label: '缓存写入', value: summary.cacheWriteTokens, color: 'var(--orange)' },
          ].map((t) => (
            <div key={t.label}>
              <div style={{ color: 'var(--text-muted)', fontSize: '10px', textTransform: 'uppercase' }}>{t.label}</div>
              <div className="num mt-0.5" style={{ color: t.color, fontSize: '15px' }}>{fmtTokens(t.value)}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                {summary.totalTokens ? ((t.value / summary.totalTokens) * 100).toFixed(1) : 0}%
              </div>
            </div>
          ))}
        </div>
        <TokenBar
          input={summary.inputTokens}
          output={summary.outputTokens}
          cacheRead={summary.cacheReadTokens}
          cacheWrite={summary.cacheWriteTokens}
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        {/* Timeline chart */}
        <div className="card p-4 col-span-2">
          <div style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
            每次调用Token用量
          </div>
          {timelineData.length > 0 ? (
            <ResponsiveContainer width="100%" height={140}>
              <AreaChart data={timelineData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="sessionGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--teal)" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="var(--teal)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="index" tick={{ fill: 'var(--text-muted)', fontSize: 9 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 9 }} axisLine={false} tickLine={false} tickFormatter={(v: number) => fmtTokens(v)} />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', borderRadius: '2px', fontSize: '11px', color: 'var(--text-primary)' }}
                  formatter={(v: number, n: string) => [n === 'tokens' ? fmtTokens(v) : fmtCost(v), n]}
                  labelFormatter={(i: number) => {
                    const ev = events[i - 1]
                    return ev ? `第 ${i} 次调用 · ${fmtTime(ev.timestamp_ms)}` : `第 ${i} 次调用`
                  }}
                />
                <Area type="monotone" dataKey="tokens" name="tokens" stroke="var(--teal)" strokeWidth={1.5} fill="url(#sessionGrad)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>暂无事件</span>
            </div>
          )}
        </div>

        {/* Model history */}
        <div className="card p-4">
          <div style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
            模型历史
          </div>
          {modelHistory.length > 0 ? (
            <div className="space-y-2 mt-2">
              {modelHistory.map((m, i) => (
                <div key={m.model} className="flex items-start gap-2">
                  <div
                    className="w-1.5 h-1.5 rounded-full mt-1 shrink-0"
                    style={{ background: modelColor(m.model), boxShadow: i === modelHistory.length - 1 ? `0 0 4px ${modelColor(m.model)}` : 'none' }}
                  />
                  <div>
                    <div className="text-xs" style={{ color: 'var(--text-primary)' }}>{m.model}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                      {m.calls} 次调用 · 始于 {fmtDate(m.firstAt)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>暂无模型数据</span>
          )}

          {/* Metadata */}
          {session?.source_path && (
            <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: '9px', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 4 }}>
                数据源
              </div>
              <div
                className="num text-2xs break-all"
                style={{ color: 'var(--text-muted)', lineHeight: 1.6 }}
              >
                {session.source_path.replace(/.*\.openclaw/, '~/.openclaw')}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Events table */}
      <div className="card">
        <div className="px-4 pt-4 pb-2 flex items-center justify-between">
          <span style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            API调用日志
          </span>
          <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
            共 {events.length} 次调用
          </span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>#</th>
              <th>时间</th>
              <th>模型</th>
              <th style={{ textAlign: 'right' }}>输入</th>
              <th style={{ textAlign: 'right' }}>输出</th>
              <th style={{ textAlign: 'right' }}>缓存读</th>
              <th style={{ textAlign: 'right' }}>总计</th>
              <th style={{ textAlign: 'right' }}>成本</th>
              <th>终止原因</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e, i) => (
              <tr key={e.id}>
                <td style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{i + 1}</td>
                <td>
                  <span className="num" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                    {fmtTime(e.timestamp_ms)}
                  </span>
                </td>
                <td>
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: modelColor(e.model) }} />
                    <span className="text-2xs" style={{ color: 'var(--text-secondary)' }}>{e.model}</span>
                  </div>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <span className="num text-2xs" style={{ color: 'var(--amber)' }}>{e.input_tokens.toLocaleString()}</span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <span className="num text-2xs" style={{ color: 'var(--teal)' }}>{e.output_tokens.toLocaleString()}</span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <span className="num text-2xs" style={{ color: 'var(--violet)' }}>{e.cache_read_tokens.toLocaleString()}</span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <span className="num text-2xs" style={{ color: 'var(--text-primary)' }}>{fmtTokens(e.total_tokens)}</span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <span className="num text-2xs" style={{ color: 'var(--text-secondary)' }}>
                    {fmtCost(e.total_cost)}<span style={{ color: 'var(--text-muted)', fontSize: '8px' }}> ~</span>
                  </span>
                </td>
                <td>
                  <span
                    className="text-2xs px-1 py-0.5 rounded-sm"
                    style={{
                      background: 'var(--bg-elevated)',
                      color: e.stop_reason === 'error' ? 'var(--rose)' : 'var(--text-muted)',
                    }}
                  >
                    {e.stop_reason}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {events.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
            暂无事件记录
          </div>
        )}
      </div>
    </div>
  )
}
