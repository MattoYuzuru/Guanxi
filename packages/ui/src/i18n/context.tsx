import { createContext, useCallback, useContext, type ReactNode } from 'react'
import { en, ru, type UiMessageKey, type UiMessages } from './messages.ts'
import { pseudoLocalize } from './pseudo.ts'

export type UiLocale = 'en' | 'ru' | 'pseudo'
export type UiMessageVars = Readonly<Record<string, string | number>>

const pseudo: UiMessages = Object.fromEntries(
  Object.entries(en).map(([key, value]) => [key, pseudoLocalize(value)]),
) as UiMessages

const catalogs: Readonly<Record<UiLocale, UiMessages>> = { en, ru, pseudo }

/** Locale tag for Intl formatting; the pseudo-locale formats numbers and dates as English. */
export function intlLocale(locale: UiLocale): string {
  return locale === 'ru' ? 'ru' : 'en'
}

export function translateUi(locale: UiLocale, key: UiMessageKey, vars?: UiMessageVars): string {
  const template = catalogs[locale][key] ?? en[key]
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  )
}

const UiLocaleContext = createContext<UiLocale>('en')

export function UiLocaleProvider({ locale, children }: { locale: UiLocale; children: ReactNode }) {
  return <UiLocaleContext.Provider value={locale}>{children}</UiLocaleContext.Provider>
}

export function useUiLocale(): UiLocale {
  return useContext(UiLocaleContext)
}

export type UiTranslate = (key: UiMessageKey, vars?: UiMessageVars) => string

export function useUiText(): UiTranslate {
  const locale = useUiLocale()
  return useCallback((key, vars) => translateUi(locale, key, vars), [locale])
}
