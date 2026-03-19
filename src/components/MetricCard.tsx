interface MetricCardProps {
  label: string
  value: string
  sub?: string
  trend?: number | null
  accent?: 'amber' | 'teal' | 'green' | 'rose'
  className?: string
  approx?: boolean
}

const ACCENT_COLORS = {
  amber: 'var(--amber)',
  teal: 'var(--teal)',
  green: 'var(--green)',
  rose: 'var(--rose)',
}

export default function MetricCard({
  label,
  value,
  sub,
  trend,
  accent = 'amber',
  className = '',
  approx = false,
}: MetricCardProps) {
  const color = ACCENT_COLORS[accent]

  return (
    <div
      className={`card p-4 flex flex-col gap-1 ${className}`}
      style={{ borderColor: 'var(--border-default)' }}
    >
      <div
        className="text-xs font-medium tracking-widest uppercase"
        style={{ color: 'var(--text-muted)', letterSpacing: '0.08em' }}
      >
        {label}
      </div>

      <div
        className="metric-num text-2xl leading-none mt-1"
        style={{ color }}
      >
        {value}
        {approx && (
          <span style={{ color: 'var(--text-muted)', fontSize: '10px', marginLeft: '4px', fontFamily: 'Barlow' }}>
            ~
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 mt-1">
        {sub && (
          <span
            className="text-xs"
            style={{ color: 'var(--text-secondary)', fontFamily: 'DM Mono' }}
          >
            {sub}
          </span>
        )}
        {trend != null && (
          <TrendBadge value={trend} />
        )}
      </div>
    </div>
  )
}

interface TrendBadgeProps {
  value: number
}

export function TrendBadge({ value }: TrendBadgeProps) {
  const isUp = value > 0
  const color = isUp ? 'var(--rose)' : 'var(--green)'
  const sign = isUp ? '+' : ''
  return (
    <span
      className="text-2xs font-medium px-1.5 py-0.5 rounded-sm"
      style={{
        color,
        background: isUp ? 'var(--rose-dim)' : 'var(--green-dim)',
        fontFamily: 'DM Mono',
      }}
    >
      {sign}{value.toFixed(0)}%
    </span>
  )
}
