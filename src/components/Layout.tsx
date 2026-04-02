import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { LayoutDashboard, Cpu, Settings, RefreshCw, Activity, Terminal, ChevronDown, ChevronRight, Monitor, Layers, Zap, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { api } from '../lib/api'
import { useTheme } from '../lib/theme'

interface NavItem {
  to: string
  icon: LucideIcon
  label: string
}

interface NavGroup {
  label: string
  icon: LucideIcon
  children: NavItem[]
  matchPrefixes: string[]
}

type NavEntry = NavItem | NavGroup

function isGroup(entry: NavEntry): entry is NavGroup {
  return 'children' in entry
}

const NAV: NavEntry[] = [
  { to: '/', icon: LayoutDashboard, label: '仪表盘' },
  {
    label: '平台',
    icon: Layers,
    matchPrefixes: ['/platforms', '/channels', '/sessions'],
    children: [
      { to: '/platforms/claude-code', icon: Terminal, label: 'Claude Code' },
      { to: '/platforms/openclaw', icon: Activity, label: 'OpenClaw' },
      { to: '/platforms/codex', icon: Zap, label: 'Codex' },
    ],
  },
  { to: '/models', icon: Cpu, label: '模型' },
  { to: '/settings', icon: Settings, label: '设置' },
]

interface LayoutProps {
  children: React.ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const { theme, toggle, label: nextThemeLabel, currentLabel } = useTheme()
  const [syncing, setSyncing] = useState(false)
  const [lastSync, setLastSync] = useState<string | null>(null)
  const navigate = useNavigate()
  const location = useLocation()

  // Auto-expand platform group if current path matches
  const platformGroup = NAV.find((e) => isGroup(e) && e.label === '平台') as NavGroup | undefined
  const isPlatformActive = platformGroup?.matchPrefixes.some((p) => location.pathname.startsWith(p)) ?? false
  const [platformOpen, setPlatformOpen] = useState(isPlatformActive)

  const handleIngest = async () => {
    setSyncing(true)
    try {
      const result = await api.ingest()
      setLastSync(`+${result.stats.eventsInserted} events`)
      navigate(0)
    } catch (e) {
      setLastSync('error')
    } finally {
      setSyncing(false)
    }
  }

  const linkClasses = (isActive: boolean) =>
    `flex items-center gap-3 px-3 py-2.5 rounded-sm text-sm font-medium transition-colors ${isActive ? 'text-white' : 'hover:text-white'}`

  const linkStyle = (isActive: boolean) => ({
    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
    background: isActive ? 'var(--bg-elevated)' : 'transparent',
    borderLeft: isActive ? '2px solid var(--amber)' : '2px solid transparent',
  })

  return (
    <div className="flex h-full overflow-hidden" style={{ background: 'var(--bg-base)' }}>
      {/* Sidebar */}
      <aside
        className="flex flex-col w-[240px] shrink-0 border-r"
        style={{ borderColor: 'var(--border-default)', background: 'var(--bg-surface)' }}
      >
        {/* Logo */}
        <div
          className="flex items-center gap-2.5 px-4 py-4 border-b"
          style={{ borderColor: 'var(--border-default)' }}
        >
          {theme === 'receipt' ? (
            <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
              <line x1="6" y1="8" x2="26" y2="8" stroke="var(--text-primary)" strokeWidth="2" strokeLinecap="round"/>
              <line x1="16" y1="8" x2="16" y2="26" stroke="var(--text-primary)" strokeWidth="2.2" strokeLinecap="round"/>
              <line x1="9" y1="13.5" x2="14.5" y2="13.5" stroke="var(--text-primary)" strokeWidth="1.5" strokeLinecap="round" opacity="0.85"/>
              <line x1="9" y1="18.5" x2="13.5" y2="18.5" stroke="var(--amber)" strokeWidth="1.5" strokeLinecap="round" opacity="0.7"/>
              <line x1="9" y1="23.5" x2="12" y2="23.5" stroke="var(--text-primary)" strokeWidth="1.5" strokeLinecap="round" opacity="0.4"/>
            </svg>
          ) : theme === 'crt' ? (
            <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
              <line x1="6" y1="8" x2="26" y2="8" stroke="var(--amber)" strokeWidth="2.5" strokeLinecap="square"/>
              <line x1="16" y1="8" x2="16" y2="26" stroke="var(--amber)" strokeWidth="2.5" strokeLinecap="square"/>
              <line x1="9" y1="13.5" x2="14.5" y2="13.5" stroke="var(--amber)" strokeWidth="1.8" strokeLinecap="square" opacity="0.8"/>
              <line x1="9" y1="18.5" x2="13.5" y2="18.5" stroke="var(--amber)" strokeWidth="1.8" strokeLinecap="square" opacity="0.5"/>
              <line x1="9" y1="23.5" x2="12" y2="23.5" stroke="var(--amber)" strokeWidth="1.8" strokeLinecap="square" opacity="0.35"/>
            </svg>
          ) : theme === 'ocean' ? (
            /* Ocean: cyan-teal on frosted white */
            <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
              <line x1="6" y1="8" x2="26" y2="8" stroke="#0891b2" strokeWidth="1.8" strokeLinecap="round"/>
              <line x1="16" y1="8" x2="16" y2="26" stroke="#0891b2" strokeWidth="1.8" strokeLinecap="round"/>
              <line x1="9" y1="13.5" x2="14.5" y2="13.5" stroke="#06b6d4" strokeWidth="1.2" strokeLinecap="round" opacity="0.9"/>
              <line x1="9" y1="18.5" x2="13.5" y2="18.5" stroke="#0284c7" strokeWidth="1.2" strokeLinecap="round" opacity="0.6"/>
              <line x1="9" y1="23.5" x2="12" y2="23.5" stroke="#0891b2" strokeWidth="1.2" strokeLinecap="round" opacity="0.3"/>
            </svg>
          ) : (
            /* Classic: amber accent system */
            <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
              <line x1="6" y1="8" x2="26" y2="8" stroke="var(--amber)" strokeWidth="2.2" strokeLinecap="round"/>
              <line x1="16" y1="8" x2="16" y2="26" stroke="var(--amber)" strokeWidth="2.2" strokeLinecap="round"/>
              <line x1="9" y1="13.5" x2="14.5" y2="13.5" stroke="var(--amber)" strokeWidth="1.5" strokeLinecap="round" opacity="0.8"/>
              <line x1="9" y1="18.5" x2="13.5" y2="18.5" stroke="var(--amber)" strokeWidth="1.5" strokeLinecap="round" opacity="0.5"/>
              <line x1="9" y1="23.5" x2="12" y2="23.5" stroke="var(--amber)" strokeWidth="1.5" strokeLinecap="round" opacity="0.3"/>
            </svg>
          )}
          <div>
            <div
              className="font-display font-semibold tracking-wide text-sm"
              style={{ color: 'var(--text-primary)', fontFamily: 'Barlow Condensed' }}
            >
              TOKEND
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '10px', letterSpacing: '0.1em' }}>
              TOKEN LEDGER
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 px-2.5 space-y-1">
          {NAV.map((entry) => {
            if (isGroup(entry)) {
              const groupActive = entry.matchPrefixes.some((p) => location.pathname.startsWith(p))
              return (
                <div key={entry.label}>
                  {/* Group header */}
                  <button
                    onClick={() => setPlatformOpen(!platformOpen)}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-sm text-sm font-medium transition-colors w-full hover:text-white"
                    style={{
                      color: groupActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                      background: groupActive && !platformOpen ? 'var(--bg-elevated)' : 'transparent',
                      borderLeft: groupActive ? '2px solid var(--amber)' : '2px solid transparent',
                    }}
                  >
                    <entry.icon size={16} strokeWidth={1.8} />
                    <span className="flex-1 text-left" style={{ fontFamily: 'Barlow', letterSpacing: '0.02em' }}>
                      {entry.label}
                    </span>
                    {platformOpen ? (
                      <ChevronDown size={14} strokeWidth={1.8} style={{ color: 'var(--text-muted)' }} />
                    ) : (
                      <ChevronRight size={14} strokeWidth={1.8} style={{ color: 'var(--text-muted)' }} />
                    )}
                  </button>
                  {/* Children */}
                  {platformOpen && (
                    <div className="ml-4 space-y-0.5 mt-0.5">
                      {entry.children.map(({ to, icon: Icon, label }) => (
                        <NavLink
                          key={to}
                          to={to}
                          className={({ isActive }) => linkClasses(isActive)}
                          style={({ isActive }) => ({
                            ...linkStyle(isActive),
                            paddingLeft: '20px',
                          })}
                        >
                          <Icon size={15} strokeWidth={1.8} />
                          <span style={{ fontFamily: 'Barlow', letterSpacing: '0.02em' }}>{label}</span>
                        </NavLink>
                      ))}
                    </div>
                  )}
                </div>
              )
            }

            const { to, icon: Icon, label } = entry
            return (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) => linkClasses(isActive)}
                style={({ isActive }) => linkStyle(isActive)}
              >
                <Icon size={16} strokeWidth={1.8} />
                <span style={{ fontFamily: 'Barlow', letterSpacing: '0.02em' }}>{label}</span>
              </NavLink>
            )
          })}
        </nav>

        {/* Footer */}
        <div
          className="px-3 py-3 border-t space-y-2"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <button
            onClick={toggle}
            className="flex items-center gap-2.5 w-full px-3 py-2 rounded-sm text-sm transition-colors"
            style={{
              color: 'var(--text-secondary)',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-default)',
              cursor: 'pointer',
            }}
          >
            <Monitor size={13} style={{ color: 'var(--amber)' }} />
            <span>{currentLabel}</span>
            <span style={{ color: 'var(--text-muted)', marginLeft: 'auto', fontSize: '10px' }}>{'>'} {nextThemeLabel}</span>
          </button>
          <button
            onClick={handleIngest}
            disabled={syncing}
            className="flex items-center gap-2.5 w-full px-3 py-2 rounded-sm text-sm transition-colors"
            style={{
              color: syncing ? 'var(--text-muted)' : 'var(--text-secondary)',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-default)',
              cursor: syncing ? 'not-allowed' : 'pointer',
            }}
          >
            <RefreshCw
              size={13}
              className={syncing ? 'animate-spin' : ''}
              style={{ color: 'var(--amber)' }}
            />
            <span>{syncing ? '同步中…' : '同步数据'}</span>
          </button>
          {lastSync && (
            <div style={{ color: 'var(--text-muted)', fontSize: '11px' }} className="px-1 text-center">
              {lastSync}
            </div>
          )}
          <div
            className="flex items-center gap-1.5 px-1 py-1"
            style={{ color: 'var(--text-muted)', fontSize: '11px' }}
          >
            <Activity size={11} />
            <span>v1 · 仅本地</span>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  )
}
