import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Settings, UiLocale } from '@alamo/contract'
import { api } from './api.ts'
import { getActiveLocale, setActiveLocale } from './locale.ts'

type LocaleSource = Settings['localeSource'] | 'loading' | 'pending' | 'unavailable'

type LocaleContextValue = {
  locale: UiLocale
  source: LocaleSource
  setLocale: (locale: UiLocale, source?: LocaleSource) => void
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

const setFallbackLocale: LocaleContextValue['setLocale'] = (locale) => {
  setActiveLocale(locale)
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<UiLocale>(getActiveLocale)
  const [source, setSource] = useState<LocaleSource>('loading')

  const setLocale = useCallback((next: UiLocale, nextSource: LocaleSource = 'user_setting') => {
    setActiveLocale(next)
    setLocaleState(next)
    setSource(nextSource)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    api.getSettings(controller.signal).then((settings) => {
      if (!controller.signal.aborted) setLocale(settings.locale, settings.localeSource)
    }).catch(() => {
      if (!controller.signal.aborted) {
        setActiveLocale('en')
        setLocaleState('en')
        setSource('unavailable')
      }
    })
    return () => controller.abort()
  }, [setLocale])

  const value = useMemo(() => ({ locale, source, setLocale }), [locale, source, setLocale])
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext)
  return context ?? {
    locale: getActiveLocale(),
    source: 'unavailable',
    setLocale: setFallbackLocale,
  }
}
