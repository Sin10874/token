export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function fmtCost(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.001) return `$${n.toFixed(6)}`
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

export function fmtDateShort(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function fmtRelative(ms: number): string {
  const diff = Date.now() - ms
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return `${secs}秒前`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}分钟前`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}小时前`
  const days = Math.floor(hrs / 24)
  return `${days}天前`
}

export function fmtDuration(ms: number): string {
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remSecs = secs % 60
  if (mins < 60) return `${mins}m ${remSecs}s`
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  return `${hrs}h ${remMins}m`
}

export function trendPct(current: number, previous: number): number | null {
  if (!previous) return null
  return ((current - previous) / previous) * 100
}

export function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + '…' : id
}

const CHANNEL_LABELS: Record<string, string> = {
  feishu: '飞书',
  'openclaw-weixin': '微信',
  webchat: 'Web',
  'claude-code': 'CC',
  codex: 'Codex',
  cron: 'Cron',
}

/**
 * Extract bot/group name from OpenClaw session_key.
 * Format: agent:{agent}:{channel}:{bot}:{type}:{id}
 *     or: agent:{agent}:{channel}:{type}:{id}
 */
function extractBotName(sessionKey: string | null, agent: string, nicknames?: Record<string, string>): string {
  if (!sessionKey) return agent
  const parts = sessionKey.split(':')
  // agent:main:feishu:group:oc_xxx → parts[3] = 'group'
  // agent:main:feishu:ceo:direct:ou_xxx → parts[3] = 'ceo'
  // agent:main:subagent:uuid → parts[2] = 'subagent'
  // agent:main:main → webchat fallback
  if (parts.length < 4) return agent
  const seg3 = parts[3]
  if (seg3 === 'group') return '群聊'
  if (seg3 === 'direct') return agent
  // Named bot: look up nickname first, fall back to config key
  if (nicknames && nicknames[seg3]) return nicknames[seg3]
  return seg3
}

/** Format session display name: "COS@飞书", "ClawMeter@CC" */
export function fmtSessionName(agent: string, channel: string, sessionKey?: string | null, botNicknames?: Record<string, string>): string {
  const chLabel = CHANNEL_LABELS[channel] || channel
  if (channel === 'claude-code' || channel === 'codex') {
    return agent ? `${agent}@${chLabel}` : chLabel
  }
  const name = extractBotName(sessionKey ?? null, agent, botNicknames)
  return `${name}@${chLabel}`
}

// Color for model/channel (deterministic)
const PALETTE = ['#f5a623', '#38bdf8', '#4ade80', '#a78bfa', '#fb923c', '#f472b6', '#34d399', '#60a5fa']
const CRT_PALETTE = ['#c8a030', '#7ab060', '#a89050', '#8a9860', '#b09040', '#6a8850', '#9a8848', '#88a058']
const RECEIPT_PALETTE = ['#1a1a1a', '#8b2500', '#2a6030', '#4a4a42', '#6b3a2a', '#384830', '#5a4a3a', '#3a3a38']
export function modelColor(name: string): string {
  let hash = 0
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff
  const dt = document.documentElement.getAttribute('data-theme')
  const palette = dt === 'crt' ? CRT_PALETTE : dt === 'receipt' ? RECEIPT_PALETTE : PALETTE
  return palette[Math.abs(hash) % palette.length]
}
