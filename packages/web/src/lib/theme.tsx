/**
 * Theme. The single source of truth is this device store (localStorage `guanxi.theme`, read by the
 * inline script in index.html before first paint). The chrome toggle and the Settings field both
 * write it; Settings Save mirrors the value to the node's `settings.theme` and never overwrites it.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Settings } from '@guanxi/contract'

export type ThemePreference = Settings['theme']

const STORAGE_KEY = 'guanxi.theme'

function readStored(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch {
    // Приватный режим — просто живём с системной темой.
  }
  return 'system'
}

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function apply(preference: ThemePreference): void {
  const dark = preference === 'dark' || (preference === 'system' && systemPrefersDark())
  document.documentElement.classList.toggle('dark', dark)
}

type ThemeContextValue = {
  preference: ThemePreference
  resolved: 'light' | 'dark'
  setPreference: (next: ThemePreference) => void
  /** D-205: swaps light and dark only, by setting the opposite of the theme on screen. */
  toggle: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStored)
  const [systemDark, setSystemDark] = useState(systemPrefersDark)

  // Системную тему могут переключить на ходу — реагируем, если выбрано 'system'.
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    apply(preference)
  }, [preference, systemDark])

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Не критично: тема просто не переживёт перезагрузку.
    }
  }, [])

  const resolved: 'light' | 'dark' =
    preference === 'dark' || (preference === 'system' && systemDark) ? 'dark' : 'light'

  const toggle = useCallback(() => setPreference(resolved === 'dark' ? 'light' : 'dark'), [resolved, setPreference])

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference, toggle }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme вне ThemeProvider')
  return context
}
