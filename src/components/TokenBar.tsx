interface TokenBarProps {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  className?: string
}

export default function TokenBar({ input, output, cacheRead, cacheWrite, className = '' }: TokenBarProps) {
  const total = input + output + cacheRead + cacheWrite
  if (total === 0) return null

  const segments = [
    { value: input, color: 'var(--amber)', label: 'Input' },
    { value: output, color: 'var(--teal)', label: 'Output' },
    { value: cacheRead, color: 'var(--violet)', label: 'Cache Read' },
    { value: cacheWrite, color: 'var(--orange)', label: 'Cache Write' },
  ].filter((s) => s.value > 0)

  return (
    <div className={`flex rounded-sm overflow-hidden ${className}`} style={{ height: '5px', gap: '1px' }}>
      {segments.map((s) => (
        <div
          key={s.label}
          title={`${s.label}: ${s.value.toLocaleString()}`}
          style={{
            width: `${(s.value / total) * 100}%`,
            background: s.color,
            opacity: 0.8,
          }}
        />
      ))}
    </div>
  )
}

export function TokenBarLegend() {
  const items = [
    { color: 'var(--amber)', label: 'Input' },
    { color: 'var(--teal)', label: 'Output' },
    { color: 'var(--violet)', label: 'Cache Read' },
    { color: 'var(--orange)', label: 'Cache Write' },
  ]
  return (
    <div className="flex items-center gap-3 flex-wrap">
      {items.map((i) => (
        <div key={i.label} className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full" style={{ background: i.color }} />
          <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{i.label}</span>
        </div>
      ))}
    </div>
  )
}
