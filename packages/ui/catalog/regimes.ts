import type { UiLocale } from '../src/i18n/context.tsx'

export const THEMES = ['light', 'dark', 'light-hc', 'dark-hc'] as const
export const DENSITIES = ['compact', 'comfortable'] as const
export const GLASS_LEVELS = ['glass', 'tinted', 'solid'] as const
export const MOTIONS = ['system', 'full', 'reduced'] as const
export const TRANSPARENCIES = ['normal', 'reduced'] as const
export const LOCALES = ['en', 'ru', 'pseudo'] as const

export type Theme = (typeof THEMES)[number]
export type Density = (typeof DENSITIES)[number]
export type GlassLevel = (typeof GLASS_LEVELS)[number]
export type Motion = (typeof MOTIONS)[number]
export type Transparency = (typeof TRANSPARENCIES)[number]

/** One rendering regime of the catalog: everything the owner can switch per component. */
export interface Regime {
  theme: Theme
  density: Density
  glass: GlassLevel
  motion: Motion
  transparency: Transparency
  locale: UiLocale
}

export const DEFAULT_REGIME: Regime = {
  theme: 'light',
  density: 'compact',
  glass: 'glass',
  motion: 'full',
  transparency: 'normal',
  locale: 'en',
}

/** Attributes the token layer reads (see src/styles/token-stub.css). */
export function regimeAttributes(regime: Regime): Record<string, string | undefined> {
  return {
    'data-theme': regime.theme,
    'data-density': regime.density,
    'data-glass': regime.glass,
    'data-motion': regime.motion === 'system' ? undefined : regime.motion,
    'data-reduce-transparency': regime.transparency === 'reduced' ? '' : undefined,
    lang: regime.locale === 'pseudo' ? 'en-XA' : regime.locale,
  }
}

function pick<T extends string>(values: readonly T[], raw: string | null, fallback: T): T {
  return raw !== null && (values as readonly string[]).includes(raw) ? (raw as T) : fallback
}

export function regimeFromSearch(search: URLSearchParams, fallback: Regime = DEFAULT_REGIME): Regime {
  return {
    theme: pick(THEMES, search.get('theme'), fallback.theme),
    density: pick(DENSITIES, search.get('density'), fallback.density),
    glass: pick(GLASS_LEVELS, search.get('glass'), fallback.glass),
    motion: pick(MOTIONS, search.get('motion'), fallback.motion),
    transparency: pick(TRANSPARENCIES, search.get('transparency'), fallback.transparency),
    locale: pick(LOCALES, search.get('locale'), fallback.locale),
  }
}
