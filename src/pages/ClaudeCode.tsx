import { useEffect, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell
} from 'recharts'
import { api, ClaudeCodeSummary } from '../lib/api'
import MetricCard from '../components/MetricCard'
import { TokenBarLegend } from '../components/TokenBar'
import { fmtTokens, fmtCost, fmtDate, fmtRelative, modelColor, trendPct } from '../lib/format'

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
          <span className="num">{typeof p.value === 'number' && p.value > 1000 ? fmtTokens(p.value) : p.value < 1 ? fmtCost(p.value) : String(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

export default function ClaudeCode() {
  const [data, setData] = useState<ClaudeCodeSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingConfig, setEditingConfig] = useState(false)
  const [quotaInput, setQuotaInput] = useState('')
  const [billingDayInput, setBillingDayInput] = useState('')
  const [planInput, setPlanInput] = useState('')

  useEffect(() => {
    api.claudeCodeSummary()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingState />
  if (error) return <ErrorState message={error} />
  if (!data) return null

  const { config, period, periodUsage, today, yesterday, week, modelDistribution, dailyTrend, topProjects } = data

  const quotaUsedPct = config.monthlyQuota > 0 ? (periodUsage.totalCost / config.monthlyQuota) * 100 : 0
  const todayTrend = trendPct(today.totalCost, yesterday.totalCost)
  const dailyBudget = period.daysLeft > 0 ? (config.monthlyQuota - periodUsage.totalCost) / period.daysLeft : 0

  // Projected monthly cost based on daily average
  const daysElapsed = period.daysTotal - period.daysLeft
  const dailyAvgCost = daysElapsed > 0 ? periodUsage.totalCost / daysElapsed : today.totalCost
  const projectedMonthlyCost = dailyAvgCost * period.daysTotal

  // Overage warning: days until quota exceeded at current rate
  const daysUntilOverage = dailyAvgCost > 0
    ? Math.floor((config.monthlyQuota - periodUsage.totalCost) / dailyAvgCost)
    : Infinity

  // Token totals for summary row
  const totalInput = dailyTrend.reduce((s, d) => s + d.inputTokens, 0)
  const totalOutput = dailyTrend.reduce((s, d) => s + d.outputTokens, 0)
  const totalCacheRead = dailyTrend.reduce((s, d) => s + d.cacheReadTokens, 0)
  const totalCacheWrite = dailyTrend.reduce((s, d) => s + d.cacheWriteTokens, 0)

  const handleSaveConfig = async () => {
    await api.updateClaudeCodeConfig({
      monthly_quota_usd: quotaInput,
      billing_cycle_day: billingDayInput,
      plan_name: planInput,
    })
    setEditingConfig(false)
    // Refresh data
    const fresh = await api.claudeCodeSummary()
    setData(fresh)
  }

  return (
    <div className="p-6 space-y-6 fade-in">
      {/* Header */}
      <div className="flex items-baseline justify-between">
        <div>
          <h1
            className="text-lg font-semibold tracking-wide"
            style={{ fontFamily: 'Barlow Condensed', color: 'var(--text-primary)', letterSpacing: '0.04em' }}
          >
            CLAUDE CODE
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
            {config.planName} · 额度重置于 {fmtDate(period.endMs)} · 剩余 {period.daysLeft} 天
          </p>
        </div>
        <button
          onClick={() => {
            setQuotaInput(String(config.monthlyQuota))
            setBillingDayInput(String(config.billingDay))
            setPlanInput(config.planName)
            setEditingConfig(!editingConfig)
          }}
          className="text-xs px-2 py-1 rounded-sm transition-colors"
          style={{
            background: 'var(--bg-elevated)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--border-default)',
          }}
        >
          {editingConfig ? '取消' : '配置'}
        </button>
      </div>

      {/* Config editor */}
      {editingConfig && (
        <div className="card p-4 space-y-3">
          <div style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            额度配置
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>套餐名称</label>
              <input
                type="text"
                value={planInput}
                onChange={(e) => setPlanInput(e.target.value)}
                className="w-full px-2 py-1.5 rounded-sm text-xs"
                style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
              />
            </div>
            <div>
              <label className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>月度额度 (USD)</label>
              <input
                type="number"
                value={quotaInput}
                onChange={(e) => setQuotaInput(e.target.value)}
                className="w-full px-2 py-1.5 rounded-sm text-xs"
                style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
              />
            </div>
            <div>
              <label className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>账单周期日 (1-28)</label>
              <input
                type="number"
                min="1"
                max="28"
                value={billingDayInput}
                onChange={(e) => setBillingDayInput(e.target.value)}
                className="w-full px-2 py-1.5 rounded-sm text-xs"
                style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
              />
            </div>
          </div>
          <button
            onClick={handleSaveConfig}
            className="px-3 py-1.5 rounded-sm text-xs font-medium"
            style={{ background: 'var(--amber)', color: '#000' }}
          >
            保存
          </button>
        </div>
      )}

      {/* Quota Progress */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-3">
          <span style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            月度额度使用
          </span>
          <span className="num text-xs" style={{ color: 'var(--text-muted)' }}>
            已过 {period.daysTotal - period.daysLeft} 天 / 共 {period.daysTotal} 天
          </span>
        </div>

        {/* Progress bar */}
        <div className="relative mb-3">
          <div
            className="h-4 rounded-sm overflow-hidden"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
          >
            <div
              className="h-full rounded-sm transition-all"
              style={{
                width: `${Math.min(quotaUsedPct, 100)}%`,
                background: quotaUsedPct > 90 ? 'var(--rose)' : quotaUsedPct > 70 ? 'var(--orange)' : 'var(--amber)',
                opacity: 0.85,
              }}
            />
          </div>
          {/* Day progress marker */}
          <div
            className="absolute top-0 h-4"
            style={{
              left: `${((period.daysTotal - period.daysLeft) / period.daysTotal) * 100}%`,
              borderLeft: '1.5px dashed var(--text-muted)',
              opacity: 0.5,
            }}
          />
        </div>

        <div className="flex items-baseline justify-between">
          <div>
            <span className="metric-num text-xl" style={{ color: quotaUsedPct > 90 ? 'var(--rose)' : 'var(--amber)' }}>
              {fmtCost(periodUsage.totalCost)}
            </span>
            <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}> / {fmtCost(config.monthlyQuota)}</span>
            <span className="num text-xs ml-2" style={{ color: 'var(--text-secondary)' }}>
              ({quotaUsedPct.toFixed(1)}%)
            </span>
          </div>
          <div className="text-right">
            <div style={{ color: 'var(--text-muted)', fontSize: '10px' }}>剩余日均预算</div>
            <span className="num text-sm" style={{ color: 'var(--teal)' }}>
              {fmtCost(dailyBudget)}
            </span>
            <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}> /天</span>
          </div>
        </div>

        {/* Overage warning */}
        {quotaUsedPct > 80 && config.monthlyQuota > 0 && (
          <div
            className="mt-3 px-3 py-2 rounded-sm text-xs"
            style={{
              background: quotaUsedPct > 90 ? 'var(--rose-dim)' : 'var(--orange-dim)',
              color: quotaUsedPct > 90 ? 'var(--rose)' : 'var(--orange)',
              border: `1px solid ${quotaUsedPct > 90 ? 'var(--rose)' : 'var(--orange)'}`,
            }}
          >
            {projectedMonthlyCost > config.monthlyQuota ? (
              daysUntilOverage <= 0
                ? '⚠️ 已超出月度配额！当前花费速率将持续超额'
                : `⚠️ 按当前速率将在 ${daysUntilOverage} 天后超额 · 预计月总花费 ${fmtCost(projectedMonthlyCost)}`
            ) : (
              `⚠️ 配额使用已达 ${quotaUsedPct.toFixed(0)}%，请注意控制用量`
            )}
          </div>
        )}
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-4 gap-3">
        <MetricCard
          label="今日成本"
          value={fmtCost(today.totalCost)}
          sub={`${today.callCount} 次调用`}
          trend={todayTrend}
          accent="amber"
          approx
        />
        <MetricCard
          label="本周"
          value={fmtCost(week.totalCost)}
          sub={`${fmtTokens(week.totalTokens)} tokens`}
          accent="teal"
          approx
        />
        <MetricCard
          label="预计月度"
          value={fmtCost(projectedMonthlyCost)}
          sub={`日均 ${fmtCost(dailyAvgCost)}`}
          accent={projectedMonthlyCost > config.monthlyQuota ? 'rose' : 'amber'}
          approx
        />
        <MetricCard
          label="剩余额度"
          value={fmtCost(Math.max(0, config.monthlyQuota - periodUsage.totalCost))}
          sub={`剩余 ${period.daysLeft} 天`}
          accent={quotaUsedPct > 80 ? 'rose' : 'green'}
          approx
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-3 gap-3">
        {/* Daily Token Breakdown with summary */}
        <div className="card col-span-2 p-4">
          <div className="flex items-center justify-between mb-3">
            <span style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              每日Token明细
            </span>
            <TokenBarLegend />
          </div>

          {/* Summary row */}
          {dailyTrend.length > 0 && (
            <div className="flex gap-4 mb-3 pb-3" style={{ borderBottom: '1px solid var(--border-default)' }}>
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>输入</div>
                <span className="num text-xs" style={{ color: 'var(--amber)' }}>{fmtTokens(totalInput)}</span>
              </div>
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>输出</div>
                <span className="num text-xs" style={{ color: 'var(--teal)' }}>{fmtTokens(totalOutput)}</span>
              </div>
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>缓存读取</div>
                <span className="num text-xs" style={{ color: 'var(--violet)' }}>{fmtTokens(totalCacheRead)}</span>
              </div>
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>缓存写入</div>
                <span className="num text-xs" style={{ color: 'var(--orange)' }}>{fmtTokens(totalCacheWrite)}</span>
              </div>
            </div>
          )}

          {dailyTrend.length > 0 ? (
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={dailyTrend} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
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
                <Bar dataKey="inputTokens" name="输入" stackId="a" fill="var(--amber)" opacity={0.8} />
                <Bar dataKey="outputTokens" name="输出" stackId="a" fill="var(--teal)" opacity={0.8} />
                <Bar dataKey="cacheReadTokens" name="缓存读取" stackId="a" fill="var(--violet)" opacity={0.8} />
                <Bar dataKey="cacheWriteTokens" name="缓存写入" stackId="a" fill="var(--orange)" opacity={0.8} radius={[1, 1, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyChart />
          )}
        </div>

        {/* Model distribution */}
        <div className="card p-4">
          <div style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 12 }}>
            模型分布
          </div>
          {modelDistribution.length > 0 ? (
            <div>
              <ResponsiveContainer width="100%" height={100}>
                <PieChart>
                  <Pie
                    data={modelDistribution}
                    dataKey="cost"
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
                      const d = payload[0].payload as { model: string; cost: number; tokens: number }
                      return (
                        <div style={CUSTOM_TOOLTIP_STYLE}>
                          <div style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>{d.model}</div>
                          <div className="num" style={{ color: 'var(--amber)' }}>{fmtCost(d.cost)}</div>
                          <div className="num" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{fmtTokens(d.tokens)} tokens</div>
                        </div>
                      )
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="mt-2 space-y-1.5">
                {modelDistribution.map((m) => (
                  <div key={m.model} className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: modelColor(m.model) }} />
                    <span className="text-2xs truncate flex-1" style={{ color: 'var(--text-secondary)' }}>
                      {m.model}
                    </span>
                    <span className="num text-2xs" style={{ color: 'var(--amber)' }}>
                      {fmtCost(m.cost)}
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

      {/* Top projects */}
      {topProjects.length > 0 && (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <span style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              热门项目 · 本周期
            </span>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>项目</th>
                <th style={{ textAlign: 'right' }}>Token</th>
                <th style={{ textAlign: 'right' }}>预估成本</th>
                <th style={{ textAlign: 'right' }}>调用次数</th>
                <th style={{ textAlign: 'right' }}>会话数</th>
                <th style={{ textAlign: 'right' }}>最近活跃</th>
              </tr>
            </thead>
            <tbody>
              {topProjects.map((p) => (
                <tr key={p.project}>
                  <td>
                    <span className="text-xs" style={{ color: 'var(--teal)' }}>
                      {formatProjectName(p.project)}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="num text-xs" style={{ color: 'var(--amber)' }}>{fmtTokens(p.tokens)}</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="num text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {fmtCost(p.cost)} <span style={{ color: 'var(--text-muted)', fontSize: '9px' }}>~</span>
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="num text-xs" style={{ color: 'var(--text-secondary)' }}>{p.calls}</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="num text-xs" style={{ color: 'var(--text-secondary)' }}>{p.sessions}</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                      {fmtRelative(p.lastAt)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** Convert Claude Code project path format to a readable name */
function formatProjectName(raw: string): string {
  // Format: -Users-xinzechao-project-name → project-name
  const parts = raw.replace(/^-/, '').split('-')
  // Skip the first two parts (Users, username) if they exist
  if (parts.length > 2 && parts[0] === 'Users') {
    return parts.slice(2).join('-') || raw
  }
  return raw
}

function LoadingState() {
  return (
    <div className="p-6 space-y-6">
      <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>加载 Claude Code 数据…</div>
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
          请确认服务已启动且 Claude Code 数据已同步。
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
      <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>暂无数据 — 点击同步导入 Claude Code 对话</span>
    </div>
  )
}
