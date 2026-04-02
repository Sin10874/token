import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip,
} from 'recharts'
import type {
  OverviewBreakdownRow,
  OverviewChannelAgentRow,
  OverviewSessionRow,
  OverviewTrendRow,
  PlatformOverviewPeriod,
} from '../../lib/api'
import { fmtCost, fmtRelative, fmtSessionName, fmtTokens, modelColor, shortId } from '../../lib/format'

export const PERIOD_OPTIONS: Array<{ value: PlatformOverviewPeriod; label: string }> = [
  { value: '1d', label: '1d' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
]

const TOOLTIP_STYLE = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-default)',
  borderRadius: '3px',
  padding: '10px 12px',
  fontSize: '12px',
  color: 'var(--text-primary)',
}

export function PeriodToggle({
  value,
  onChange,
}: {
  value: PlatformOverviewPeriod
  onChange: (value: PlatformOverviewPeriod) => void
}) {
  return (
    <div className="flex items-center gap-1.5">
      {PERIOD_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className="px-3 py-1 rounded-sm text-xs font-medium"
          style={{
            background: value === opt.value ? 'var(--amber-bg)' : 'transparent',
            border: `1px solid ${value === opt.value ? 'var(--amber-dim)' : 'var(--border-subtle)'}`,
            color: value === opt.value ? 'var(--amber)' : 'var(--text-muted)',
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

export function TrendCard({
  rows,
  peak,
  title,
  period,
}: {
  rows: OverviewTrendRow[]
  peak: OverviewTrendRow | null
  title: string
  period: PlatformOverviewPeriod
}) {
  const [mode, setMode] = useState<'cost' | 'tokens'>('cost')
  const totalCost = rows.reduce((sum, row) => sum + row.totalCost, 0)
  const totalTokens = rows.reduce((sum, row) => sum + row.totalTokens, 0)

  return (
    <div className="card p-5 col-span-2">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div style={{ color: 'var(--text-primary)', fontSize: '15px', fontWeight: 600 }}>{title}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
            峰值 {peak ? `${String(peak.bucket).slice(period === '1d' ? 11 : 5)} · ${fmtCost(peak.totalCost)}` : '—'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <MiniStat label="总成本" value={fmtCost(totalCost)} />
          <MiniStat label="总 Tokens" value={fmtTokens(totalTokens)} />
          {(['cost', 'tokens'] as const).map((item) => (
            <button
              key={item}
              onClick={() => setMode(item)}
              className="px-3 py-1 rounded-sm text-xs"
              style={{
                background: mode === item ? 'var(--bg-elevated)' : 'transparent',
                border: `1px solid ${mode === item ? 'var(--border-bright)' : 'var(--border-subtle)'}`,
                color: mode === item ? 'var(--text-primary)' : 'var(--text-muted)',
              }}
            >
              {item === 'cost' ? '费用' : 'Token'}
            </button>
          ))}
        </div>
      </div>

      {rows.length > 0 ? (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={rows} margin={{ top: 0, right: 4, left: -18, bottom: 0 }}>
            <XAxis
              dataKey="bucket"
              tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(value: string) => (period === '1d' ? value.slice(11) : value.slice(5))}
            />
            <YAxis
              tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(value: number) => (mode === 'cost' ? fmtCost(value) : fmtTokens(value))}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null
                const row = payload[0]?.payload as OverviewTrendRow
                return (
                  <div style={TOOLTIP_STYLE}>
                    <div style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>{String(label)}</div>
                    <div className="num text-xs">
                      <span style={{ color: 'var(--text-muted)' }}>成本: </span>
                      <span>{fmtCost(row.totalCost)}</span>
                    </div>
                    <div className="num text-xs">
                      <span style={{ color: 'var(--text-muted)' }}>Tokens: </span>
                      <span>{fmtTokens(row.totalTokens)}</span>
                    </div>
                    <div className="num text-xs">
                      <span style={{ color: 'var(--text-muted)' }}>调用: </span>
                      <span>{row.callCount}</span>
                    </div>
                  </div>
                )
              }}
            />
            <Bar
              dataKey={mode === 'cost' ? 'totalCost' : 'totalTokens'}
              fill={mode === 'cost' ? 'var(--teal)' : 'var(--amber)'}
              radius={[2, 2, 0, 0]}
              opacity={0.85}
            />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <EmptyState text="暂无趋势数据" height={220} />
      )}
    </div>
  )
}

export function BreakdownList({
  title,
  subtitle,
  rows,
  metric = 'cost',
}: {
  title: string
  subtitle?: string
  rows: OverviewBreakdownRow[]
  metric?: 'cost' | 'tokens'
}) {
  const maxValue = Math.max(...rows.map((row) => (metric === 'cost' ? row.cost : row.tokens)), 1)

  return (
    <div className="card p-5">
      <div className="mb-3">
        <div style={{ color: 'var(--text-primary)', fontSize: '15px', fontWeight: 600 }}>{title}</div>
        {subtitle && <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{subtitle}</div>}
      </div>
      <div className="space-y-3">
        {rows.length > 0 ? rows.map((row) => {
          const value = metric === 'cost' ? row.cost : row.tokens
          const pct = Math.max((value / maxValue) * 100, 5)
          return (
            <div key={row.label}>
              <div className="flex items-center justify-between gap-3 mb-1">
                <span className="truncate" style={{ color: 'var(--text-primary)', fontSize: '13px' }}>{row.label}</span>
                <span className="num shrink-0" style={{ color: metric === 'cost' ? 'var(--teal)' : 'var(--amber)', fontSize: '12px' }}>
                  {metric === 'cost' ? fmtCost(row.cost) : fmtTokens(row.tokens)}
                </span>
              </div>
              <div className="h-1.5 rounded-full" style={{ background: 'var(--border-default)' }}>
                <div
                  className="h-1.5 rounded-full"
                  style={{ width: `${pct}%`, background: metric === 'cost' ? 'var(--teal)' : modelColor(row.label) }}
                />
              </div>
              <div className="flex items-center justify-between mt-1">
                <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                  {row.calls} 调用 · {row.sessions} 会话
                </span>
                {row.lastAt != null && <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{fmtRelative(row.lastAt)}</span>}
              </div>
            </div>
          )
        }) : (
          <EmptyState text="暂无归因数据" height={160} />
        )}
      </div>
    </div>
  )
}

export function CrossAttributionTable({ rows }: { rows: OverviewChannelAgentRow[] }) {
  return (
    <div className="card p-5">
      <div className="mb-3">
        <div style={{ color: 'var(--text-primary)', fontSize: '15px', fontWeight: 600 }}>频道 × Agent</div>
        <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>定位真正的大户组合</div>
      </div>
      {rows.length > 0 ? (
        <table className="data-table">
          <thead>
            <tr>
              <th>频道</th>
              <th>Agent</th>
              <th style={{ textAlign: 'right' }}>调用</th>
              <th style={{ textAlign: 'right' }}>会话</th>
              <th style={{ textAlign: 'right' }}>Tokens</th>
              <th style={{ textAlign: 'right' }}>成本</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.channel}:${row.agent}`}>
                <td><span style={{ color: 'var(--text-primary)', fontSize: '13px' }}>{row.channel}</span></td>
                <td><span style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>{row.agent}</span></td>
                <td style={{ textAlign: 'right' }}><span className="num text-xs" style={{ color: 'var(--text-secondary)' }}>{row.calls}</span></td>
                <td style={{ textAlign: 'right' }}><span className="num text-xs" style={{ color: 'var(--text-secondary)' }}>{row.sessions}</span></td>
                <td style={{ textAlign: 'right' }}><span className="num text-xs" style={{ color: 'var(--amber)' }}>{fmtTokens(row.tokens)}</span></td>
                <td style={{ textAlign: 'right' }}><span className="num text-xs" style={{ color: 'var(--teal)' }}>{fmtCost(row.cost)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState text="暂无交叉归因数据" height={160} />
      )}
    </div>
  )
}

export function TopSessionsTable({
  rows,
  emptyText,
  botNicknames,
}: {
  rows: OverviewSessionRow[]
  emptyText: string
  botNicknames?: Record<string, string>
}) {
  return (
    <div className="card p-5">
      <div className="mb-3">
        <div style={{ color: 'var(--text-primary)', fontSize: '15px', fontWeight: 600 }}>Top Sessions</div>
        <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>按成本排序，便于继续钻取</div>
      </div>
      {rows.length > 0 ? (
        <table className="data-table">
          <thead>
            <tr>
              <th>会话</th>
              <th>名称</th>
              <th>模型</th>
              <th style={{ textAlign: 'right' }}>调用</th>
              <th style={{ textAlign: 'right' }}>Tokens</th>
              <th style={{ textAlign: 'right' }}>成本</th>
              <th style={{ textAlign: 'right' }}>最近</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const models = row.models ? row.models.split(',').slice(0, 2) : []
              return (
                <tr key={row.session_id}>
                  <td>
                    <Link
                      to={`/sessions/${row.session_id}`}
                      className="num hover:underline"
                      style={{ color: 'var(--teal)', fontSize: '12px' }}
                    >
                      {shortId(row.session_id)}
                    </Link>
                  </td>
                  <td>
                    <span style={{ color: 'var(--text-primary)', fontSize: '13px' }}>
                      {fmtSessionName(row.agent, row.channel, row.session_key, botNicknames)}
                    </span>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {models.map((model) => (
                        <span
                          key={model}
                          className="px-1.5 py-0.5 rounded-sm truncate"
                          style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)', fontSize: '11px', maxWidth: 120 }}
                        >
                          {model.split('/').pop()}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td style={{ textAlign: 'right' }}><span className="num text-xs" style={{ color: 'var(--text-secondary)' }}>{row.calls}</span></td>
                  <td style={{ textAlign: 'right' }}><span className="num text-xs" style={{ color: 'var(--amber)' }}>{fmtTokens(row.tokens)}</span></td>
                  <td style={{ textAlign: 'right' }}><span className="num text-xs" style={{ color: 'var(--teal)' }}>{fmtCost(row.cost)}</span></td>
                  <td style={{ textAlign: 'right' }}><span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{fmtRelative(row.lastAt)}</span></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : (
        <EmptyState text={emptyText} height={180} />
      )}
    </div>
  )
}

export function InsightPanel({
  items,
  title = '关键指标',
}: {
  title?: string
  items: Array<{ label: string; value: string; sub?: string; accent?: 'var(--amber)' | 'var(--teal)' | 'var(--green)' | 'var(--rose)' }>
}) {
  return (
    <div className="card p-5">
      <div className="mb-3">
        <div style={{ color: 'var(--text-primary)', fontSize: '15px', fontWeight: 600 }}>{title}</div>
      </div>
      <div className="space-y-3">
        {items.map((item) => (
          <div key={item.label} className="pb-3" style={{ borderBottom: '1px solid var(--border-default)' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginBottom: 4 }}>{item.label}</div>
            <div className="metric-num text-lg" style={{ color: item.accent || 'var(--text-primary)' }}>{item.value}</div>
            {item.sub && <div style={{ color: 'var(--text-secondary)', fontSize: '11px' }}>{item.sub}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right">
      <div style={{ color: 'var(--text-muted)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div className="num text-xs" style={{ color: 'var(--text-secondary)' }}>{value}</div>
    </div>
  )
}

function EmptyState({ text, height }: { text: string; height: number }) {
  return (
    <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
      {text}
    </div>
  )
}
