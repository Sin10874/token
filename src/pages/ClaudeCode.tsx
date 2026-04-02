import { useEffect, useState } from 'react'
import { api, PlatformOverviewData, PlatformOverviewPeriod } from '../lib/api'
import MetricCard from '../components/MetricCard'
import { fmtCost, fmtTokens, trendPct } from '../lib/format'
import {
  BreakdownList,
  InsightPanel,
  PeriodToggle,
  TopSessionsTable,
  TrendCard,
} from '../components/platform/OverviewBlocks'

export default function ClaudeCode() {
  const [period, setPeriod] = useState<PlatformOverviewPeriod>('7d')
  const [overview, setOverview] = useState<PlatformOverviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    api.platformOverview('claude-code', period)
      .then(setOverview)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [period])

  if (loading && !overview) return <StateView text="加载中…" />
  if (error) return <StateView text={error} />
  if (!overview) return null

  const avgTokensPerCall = overview.current.totalTokens / Math.max(overview.current.callCount, 1)

  return (
    <div className="p-6 space-y-6 fade-in">
      <div className="flex items-baseline justify-between">
        <div>
          <h1
            className="text-lg font-semibold tracking-wide"
            style={{ fontFamily: 'Barlow Condensed', color: 'var(--text-primary)', letterSpacing: '0.04em' }}
          >
            CLAUDE CODE
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
            Anthropic CLI · 成本与项目归因
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PeriodToggle value={period} onChange={setPeriod} />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <MetricCard
          label="总成本"
          value={fmtCost(overview.current.totalCost)}
          sub={`上期 ${fmtCost(overview.previous.totalCost)}`}
          trend={trendPct(overview.current.totalCost, overview.previous.totalCost)}
          accent="teal"
          approx
        />
        <MetricCard
          label="总 Tokens"
          value={fmtTokens(overview.current.totalTokens)}
          sub={`上期 ${fmtTokens(overview.previous.totalTokens)}`}
          trend={trendPct(overview.current.totalTokens, overview.previous.totalTokens)}
          accent="amber"
        />
        <MetricCard
          label="活跃项目"
          value={String(overview.current.projectCount)}
          sub={`${overview.current.sessions} 个会话`}
          trend={trendPct(overview.current.projectCount, overview.previous.projectCount)}
          accent="green"
        />
        <MetricCard
          label="调用数"
          value={String(overview.current.callCount)}
          sub={`上期 ${overview.previous.callCount}`}
          trend={trendPct(overview.current.callCount, overview.previous.callCount)}
          accent="amber"
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <TrendCard rows={overview.trend} peak={overview.peak} title="成本 / Token 趋势" period={period} />
        <InsightPanel
          title="预算视角"
          items={[
            {
              label: '平均每次调用 Tokens',
              value: fmtTokens(avgTokensPerCall),
              sub: `${overview.current.callCount} 次调用`,
              accent: 'var(--amber)',
            },
            {
              label: '平均每会话成本',
              value: fmtCost(overview.current.totalCost / Math.max(overview.current.sessions, 1)),
              sub: `${overview.current.sessions} 个会话`,
              accent: 'var(--teal)',
            },
            {
              label: '缓存读取',
              value: fmtTokens(overview.current.cacheReadTokens),
              sub: `缓存写入 ${fmtTokens(overview.current.cacheWriteTokens)}`,
              accent: 'var(--green)',
            },
          ]}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <BreakdownList
          title="项目归因"
          subtitle="先看哪个工程最烧钱"
          rows={overview.topProjects}
          metric="cost"
        />
        <BreakdownList
          title="模型归因"
          subtitle="再看哪些模型拉高了成本"
          rows={overview.topModels}
          metric="cost"
        />
      </div>

      <TopSessionsTable rows={overview.topSessions} emptyText="暂无 Claude Code 会话数据" botNicknames={overview.botNicknames} />
    </div>
  )
}

function StateView({ text }: { text: string }) {
  return (
    <div className="p-6">
      <div className="card p-8 text-center" style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
        {text}
      </div>
    </div>
  )
}
