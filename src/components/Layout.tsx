import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { LayoutDashboard, Cpu, Radio, MessageSquare, Settings, RefreshCw, Activity, Terminal, ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { api } from '../lib/api'

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
  { to: '/claude-code', icon: Terminal, label: 'Claude Code' },
  {
    label: 'OpenClaw',
    icon: Activity,
    matchPrefixes: ['/channels', '/sessions'],
    children: [
      { to: '/channels', icon: Radio, label: '渠道' },
      { to: '/sessions', icon: MessageSquare, label: '会话' },
    ],
  },
  { to: '/models', icon: Cpu, label: '模型' },
  { to: '/settings', icon: Settings, label: '设置' },
]

interface LayoutProps {
  children: React.ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const [syncing, setSyncing] = useState(false)
  const [lastSync, setLastSync] = useState<string | null>(null)
  const navigate = useNavigate()
  const location = useLocation()

  // Auto-expand OpenClaw group if current path matches
  const openClawGroup = NAV.find((e) => isGroup(e) && e.label === 'OpenClaw') as NavGroup | undefined
  const isOpenClawActive = openClawGroup?.matchPrefixes.some((p) => location.pathname.startsWith(p)) ?? false
  const [openClawOpen, setOpenClawOpen] = useState(isOpenClawActive)

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
    `flex items-center gap-2.5 px-3 py-2 rounded-sm text-xs font-medium transition-colors ${isActive ? 'text-white' : 'hover:text-white'}`

  const linkStyle = (isActive: boolean) => ({
    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
    background: isActive ? 'var(--bg-elevated)' : 'transparent',
    borderLeft: isActive ? '2px solid var(--amber)' : '2px solid transparent',
  })

  return (
    <div className="flex h-full overflow-hidden" style={{ background: 'var(--bg-base)' }}>
      {/* Sidebar */}
      <aside
        className="flex flex-col w-[200px] shrink-0 border-r"
        style={{ borderColor: 'var(--border-default)', background: 'var(--bg-surface)' }}
      >
        {/* Logo */}
        <div
          className="flex items-center gap-2.5 px-4 py-4 border-b"
          style={{ borderColor: 'var(--border-default)' }}
        >
          <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
            <path d="M7 25L16 7L25 25" stroke="var(--amber)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M10.5 19.5L21.5 19.5" stroke="var(--amber)" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <div>
            <div
              className="font-display font-semibold tracking-wide text-sm"
              style={{ color: 'var(--text-primary)', fontFamily: 'Barlow Condensed' }}
            >
              CLAWMETER
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '9px', letterSpacing: '0.1em' }}>
              COST COCKPIT
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 px-2 space-y-0.5">
          {NAV.map((entry) => {
            if (isGroup(entry)) {
              const groupActive = entry.matchPrefixes.some((p) => location.pathname.startsWith(p))
              return (
                <div key={entry.label}>
                  {/* Group header */}
                  <button
                    onClick={() => setOpenClawOpen(!openClawOpen)}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-sm text-xs font-medium transition-colors w-full hover:text-white"
                    style={{
                      color: groupActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                      background: groupActive && !openClawOpen ? 'var(--bg-elevated)' : 'transparent',
                      borderLeft: groupActive ? '2px solid var(--amber)' : '2px solid transparent',
                    }}
                  >
                    <entry.icon size={14} strokeWidth={1.8} />
                    <span className="flex-1 text-left" style={{ fontFamily: 'Barlow', letterSpacing: '0.02em' }}>
                      {entry.label}
                    </span>
                    {openClawOpen ? (
                      <ChevronDown size={12} strokeWidth={1.8} style={{ color: 'var(--text-muted)' }} />
                    ) : (
                      <ChevronRight size={12} strokeWidth={1.8} style={{ color: 'var(--text-muted)' }} />
                    )}
                  </button>
                  {/* Children */}
                  {openClawOpen && (
                    <div className="ml-3 space-y-0.5 mt-0.5">
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
                          <Icon size={13} strokeWidth={1.8} />
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
                <Icon size={14} strokeWidth={1.8} />
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
            onClick={handleIngest}
            disabled={syncing}
            className="flex items-center gap-2 w-full px-3 py-1.5 rounded-sm text-xs transition-colors"
            style={{
              color: syncing ? 'var(--text-muted)' : 'var(--text-secondary)',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-default)',
              cursor: syncing ? 'not-allowed' : 'pointer',
            }}
          >
            <RefreshCw
              size={11}
              className={syncing ? 'animate-spin' : ''}
              style={{ color: 'var(--amber)' }}
            />
            <span>{syncing ? '同步中…' : '同步数据'}</span>
          </button>
          {lastSync && (
            <div style={{ color: 'var(--text-muted)', fontSize: '10px' }} className="px-1 text-center">
              {lastSync}
            </div>
          )}
          <div
            className="flex items-center gap-1.5 px-1 py-1"
            style={{ color: 'var(--text-muted)', fontSize: '10px' }}
          >
            <Activity size={9} />
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
