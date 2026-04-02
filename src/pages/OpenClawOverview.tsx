import { useEffect, useState } from 'react'
import { api, PlatformOverviewData, PlatformOverviewPeriod } from '../lib/api'
import { fmtCost, fmtTokens, trendPct } from '../lib/format'
import MetricCard from '../components/MetricCard'
import {
  BreakdownList,
  CrossAttributionTable,
  InsightPanel,
  PeriodToggle,
  TopSessionsTable,
  TrendCard,
} from '../components/platform/OverviewBlocks'

export default function OpenClawOverview() {
  const [period, setPeriod] = useState<PlatformOverviewPeriod>('7d')
  const [data, setData] = useState<PlatformOverviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    api.platformOverview('openclaw', period)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [period])

  if (loading && !data) return <StateView text="加载中…" />
  if (error) return <StateView text={error} />
  if (!data) return null

  const avgTokensPerCall = data.current.totalTokens / Math.max(data.current.callCount, 1)
  const avgCostPerCall = data.current.totalCost / Math.max(data.current.callCount, 1)

  return (
    <div className="p-6 space-y-6 fade-in">
      <div className="flex items-baseline justify-between">
        <div>
          <h1
            className="text-lg font-semibold tracking-wide"
            style={{ fontFamily: 'Barlow Condensed', color: 'var(--text-primary)', letterSpacing: '0.04em' }}
          >
            OPENCLAW
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
            自部署 AI Agent 平台 · 频道与 Agent 双归因
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
          label="活跃频道"
          value={String(data.current.channelCount)}
          sub={`上期 ${data.previous.channelCount}`}
          trend={trendPct(data.current.channelCount, data.previous.channelCount)}
          accent="green"
        />
        <MetricCard
          label="活跃 Agent"
          value={String(data.current.projectCount)}
          sub={`${data.current.sessions} 个会话`}
          trend={trendPct(data.current.projectCount, data.previous.projectCount)}
          accent="amber"
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <TrendCard rows={data.trend} peak={data.peak} title="成本 / Token 趋势" period={period} />
        <InsightPanel
          title="运营视角"
          items={[
            {
              label: '平均每调用 Tokens',
              value: fmtTokens(avgTokensPerCall),
              sub: `${data.current.callCount} 次调用`,
              accent: 'var(--amber)',
            },
            {
              label: '平均每调用成本',
              value: fmtCost(avgCostPerCall),
              sub: `缓存写入 ${fmtTokens(data.current.cacheWriteTokens)}`,
              accent: 'var(--teal)',
            },
            {
              label: '总输出',
              value: fmtTokens(data.current.outputTokens),
              sub: `总输入 ${fmtTokens(data.current.inputTokens)}`,
              accent: 'var(--green)',
            },
          ]}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <BreakdownList
          title="频道归因"
          subtitle="先看哪个渠道在吞噬预算"
          rows={data.topChannels}
          metric="cost"
        />
        <BreakdownList
          title="Agent 归因"
          subtitle="再看哪个 Agent 是主要消耗源"
          rows={data.topAgents}
          metric="cost"
        />
      </div>

      <CrossAttributionTable rows={data.topChannelAgents} />

      <TopSessionsTable rows={data.topSessions} emptyText="暂无 OpenClaw 会话数据" botNicknames={data.botNicknames} />
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
