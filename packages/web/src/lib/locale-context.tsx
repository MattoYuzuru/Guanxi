import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Settings, UiLocale } from '@alamo/contract'
import { api } from './api.ts'
import { getActiveLocale, setActiveLocale } from './locale.ts'

type LocaleSource = Settings['localeSource'] | 'loading' | 'pending' | 'unavailable'

type LocaleContextValue = {
  locale: UiLocale
  source: LocaleSource
  settings: Settings | null
  settingsLoading: boolean
  settingsError: unknown
  setLocale: (locale: UiLocale, source?: LocaleSource) => void
  acceptSettings: (settings: Settings) => void
  reloadSettings: () => void
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

const setFallbackLocale: LocaleContextValue['setLocale'] = (locale) => {
  setActiveLocale(locale)
}
const ignoreSettings: LocaleContextValue['acceptSettings'] = () => undefined
const ignoreReload: LocaleContextValue['reloadSettings'] = () => undefined

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<UiLocale>(getActiveLocale)
  const [source, setSource] = useState<LocaleSource>('loading')
  const [settings, setSettingsState] = useState<Settings | null>(null)
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [settingsError, setSettingsError] = useState<unknown>(null)
  const [requestVersion, setRequestVersion] = useState(0)
  const localeIntent = useRef(0)
  const settingsRequest = useRef<{
    version: number
    promise: Promise<Settings>
    controller: AbortController
    subscribers: number
  } | null>(null)

  const setLocale = useCallback((next: UiLocale, nextSource: LocaleSource = 'user_setting') => {
    localeIntent.current += 1
    setActiveLocale(next)
    setLocaleState(next)
    setSource(nextSource)
  }, [])

  const acceptSettings = useCallback((next: Settings) => {
    setSettingsState(next)
    setSettingsError(null)
    setSettingsLoading(false)
    setLocale(next.locale, next.localeSource)
  }, [setLocale])

  const reloadSettings = useCallback(() => {
    setRequestVersion((version) => version + 1)
  }, [])

  useEffect(() => {
    let active = true
    const bootstrapIntent = localeIntent.current
    setSettingsLoading(true)
    setSettingsError(null)
    if (settingsRequest.current?.version !== requestVersion) {
      const controller = new AbortController()
      settingsRequest.current = {
        version: requestVersion,
        promise: api.getSettings(controller.signal),
        controller,
        subscribers: 0,
      }
    }
    const request = settingsRequest.current
    request.subscribers += 1
    request.promise.then((loadedSettings) => {
      if (!active) return
      setSettingsState(loadedSettings)
      setSettingsLoading(false)
      if (localeIntent.current === bootstrapIntent) {
        setLocale(loadedSettings.locale, loadedSettings.localeSource)
      }
    }).catch((error: unknown) => {
      if (!active) return
      setSettingsError(error)
      setSettingsLoading(false)
      if (localeIntent.current === bootstrapIntent) {
        setLocale('en', 'unavailable')
      }
    })
    return () => {
      active = false
      request.subscribers -= 1
      queueMicrotask(() => {
        if (request.subscribers === 0) request.controller.abort()
      })
    }
  }, [requestVersion, setLocale])

  const value = useMemo(() => ({
    locale,
    source,
    settings,
    settingsLoading,
    settingsError,
    setLocale,
    acceptSettings,
    reloadSettings,
  }), [
    acceptSettings,
    locale,
    reloadSettings,
    setLocale,
    settings,
    settingsError,
    settingsLoading,
    source,
  ])
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext)
  return context ?? {
    locale: getActiveLocale(),
    source: 'unavailable',
    settings: null,
    settingsLoading: false,
    settingsError: null,
    setLocale: setFallbackLocale,
    acceptSettings: ignoreSettings,
    reloadSettings: ignoreReload,
  }
}
