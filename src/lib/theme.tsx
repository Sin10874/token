import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

type Theme = 'classic' | 'crt' | 'receipt' | 'ocean'

const THEME_ORDER: Theme[] = ['classic', 'crt', 'receipt', 'ocean']
const THEME_LABELS: Record<Theme, string> = {
  classic: 'Classic',
  crt: 'CRT',
  receipt: 'Receipt',
  ocean: 'Ocean',
}

interface ThemeCtx {
  theme: Theme
  toggle: () => void
  label: string
  currentLabel: string
}

const ThemeContext = createContext<ThemeCtx>({ theme: 'classic', toggle: () => {}, label: 'CRT', currentLabel: 'Classic' })

function getStored(): Theme {
  try {
    const v = localStorage.getItem('tokend-theme') as Theme
    if (THEME_ORDER.includes(v)) return v
  } catch {}
  return 'classic'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getStored)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('tokend-theme', theme)
    const fav = document.getElementById('favicon') as HTMLLinkElement | null
    if (fav) fav.href = `/favicon-${theme}.svg`
  }, [theme])

  const toggle = () => setTheme((t) => THEME_ORDER[(THEME_ORDER.indexOf(t) + 1) % THEME_ORDER.length])
  const nextIdx = (THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length
  const label = THEME_LABELS[THEME_ORDER[nextIdx]]
  const currentLabel = THEME_LABELS[theme]

  return <ThemeContext.Provider value={{ theme, toggle, label, currentLabel }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  return useContext(ThemeContext)
}
