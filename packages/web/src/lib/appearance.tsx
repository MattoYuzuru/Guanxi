/**
 * Appearance preferences of the one interface (D-204, D-206): density, graphics tier and motion.
 * They live in the customisation popover of the chrome, apply to the root element at once and
 * persist per browser (the inline script in index.html applies them before first paint).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { PRODUCT_FILE_PREFIX } from './brand.ts'

export type Density = 'compact' | 'comfortable'
export type GraphicsTier = 'static' | 'max'
export type MotionPreference = 'system' | 'reduced' | 'full'

export interface Appearance {
  density: Density
  graphics: GraphicsTier
  motion: MotionPreference
}

export const APPEARANCE_KEY = `${PRODUCT_FILE_PREFIX}.appearance.v1`
/** Comfortable reading density by default (D-131 chat default); max graphics is opt-in (D-206). */
export const defaultAppearance = (): Appearance => ({ density: 'comfortable', graphics: 'static', motion: 'system' })

export function readAppearance(): Appearance {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? 'null')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultAppearance()
    const record = value as Record<string, unknown>
    return {
      density: record.density === 'compact' ? 'compact' : 'comfortable',
      graphics: record.graphics === 'max' ? 'max' : 'static',
      motion: record.motion === 'reduced' || record.motion === 'full' ? record.motion : 'system',
    }
  } catch {
    return defaultAppearance()
  }
}

export function applyAppearance(appearance: Appearance, root: HTMLElement = document.documentElement): void {
  root.dataset.density = appearance.density
  root.dataset.graphics = appearance.graphics
  if (appearance.motion === 'system') delete root.dataset.motion
  else root.dataset.motion = appearance.motion
}

type AppearanceContextValue = Appearance & { update(next: Partial<Appearance>): void }
const AppearanceContext = createContext<AppearanceContextValue | null>(null)

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState(readAppearance)
  useEffect(() => {
    applyAppearance(appearance)
    try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance)) } catch { /* memory only */ }
  }, [appearance])
  // Another tab changed the preference: follow it.
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === APPEARANCE_KEY) setAppearance(readAppearance()) }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])
  const update = useCallback((next: Partial<Appearance>) => setAppearance(previous => ({ ...previous, ...next })), [])
  const value = useMemo(() => ({ ...appearance, update }), [appearance, update])
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>
}

export function useAppearance(): AppearanceContextValue {
  const context = useContext(AppearanceContext)
  if (!context) throw new Error('useAppearance needs an AppearanceProvider')
  return context
}

/** For components that may render outside the provider (tests, fixtures). */
export function useOptionalAppearance(): AppearanceContextValue | null {
  return useContext(AppearanceContext)
}
