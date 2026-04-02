import { useEffect, useState } from 'react'
import { api, PlatformOverviewData, PlatformOverviewPeriod } from '../lib/api'
import { fmtCost, fmtTokens, trendPct } from '../lib/format'
import MetricCard from '../components/MetricCard'
import {
  BreakdownList,
  InsightPanel,
  PeriodToggle,
  TopSessionsTable,
  TrendCard,
} from '../components/platform/OverviewBlocks'

export default function CodexOverview() {
  const [period, setPeriod] = useState<PlatformOverviewPeriod>('7d')
  const [data, setData] = useState<PlatformOverviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    api.platformOverview('codex', period)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [period])

  if (loading && !data) return <StateView text="加载中…" />
  if (error) return <StateView text={error} />
  if (!data) return null

  const totalCalls = data.current.callCount
  const avgTokensPerCall = data.current.totalTokens / Math.max(totalCalls, 1)
  const avgCostPerSession = data.current.totalCost / Math.max(data.current.sessions, 1)

  return (
    <div className="p-6 space-y-6 fade-in">
      <div className="flex items-baseline justify-between">
        <div>
          <h1
            className="text-lg font-semibold tracking-wide"
            style={{ fontFamily: 'Barlow Condensed', color: 'var(--text-primary)', letterSpacing: '0.04em' }}
          >
            CODEX
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
            OpenAI Codex CLI & App · 成本与消耗归因
          </p>
        </div>
        <PeriodToggle value={period} onChange={setPeriod} />
      </div>

      <div className="grid grid-cols-4 gap-3">
        <MetricCard
          label="总成本"
          value={fmtCost(data.current.totalCost)}
          sub={`上期 ${fmtCost(data.previous.totalCost)}`}
          trend={trendPct(data.current.totalCost, data.previous.totalCost)}
          accent="teal"
          approx
        />
        <MetricCard
          label="总 Tokens"
          value={fmtTokens(data.current.totalTokens)}
          sub={`上期 ${fmtTokens(data.previous.totalTokens)}`}
          trend={trendPct(data.current.totalTokens, data.previous.totalTokens)}
          accent="amber"
        />
        <MetricCard
          label="调用数"
          value={String(data.current.callCount)}
          sub={`上期 ${data.previous.callCount}`}
          trend={trendPct(data.current.callCount, data.previous.callCount)}
          accent="green"
        />
        <MetricCard
          label="活跃项目"
          value={String(data.current.projectCount)}
          sub={`${data.current.sessions} 个会话`}
          trend={trendPct(data.current.projectCount, data.previous.projectCount)}
          accent="amber"
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <TrendCard rows={data.trend} peak={data.peak} title="成本 / Token 趋势" period={period} />
        <InsightPanel
          title="效率视角"
          items={[
            {
              label: '平均每次调用 Tokens',
              value: fmtTokens(avgTokensPerCall),
              sub: `${data.current.callCount} 次调用`,
              accent: 'var(--amber)',
            },
            {
              label: '平均每会话成本',
              value: fmtCost(avgCostPerSession),
              sub: `${data.current.sessions} 个会话`,
              accent: 'var(--teal)',
            },
            {
              label: '缓存读取',
              value: fmtTokens(data.current.cacheReadTokens),
              sub: `输出 ${fmtTokens(data.current.outputTokens)}`,
              accent: 'var(--green)',
            },
          ]}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <BreakdownList
          title="模型归因"
          subtitle="先看哪个模型把成本打出来"
          rows={data.topModels}
          metric="cost"
        />
        <BreakdownList
          title="项目归因"
          subtitle="再看哪些 workspace / repo 最重"
          rows={data.topProjects}
          metric="cost"
        />
      </div>

      <TopSessionsTable rows={data.topSessions} emptyText="暂无 Codex 会话数据" botNicknames={data.botNicknames} />
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
