import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Settings } from '@guanxi/contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applySettingsPatch } from '../helpers/settings.ts'
import { SettingsPage } from '../../src/features/settings/SettingsPage.tsx'
import { api } from '../../src/lib/api.ts'
import { LocaleProvider } from '../../src/lib/locale-context.tsx'
import { ThemeProvider, useTheme } from '../../src/lib/theme.tsx'

const SETTINGS: Settings = {
  ollamaHost: 'http://127.0.0.1:11434', defaultModel: null, defaultNumCtx: 32_768,
  autoApproveTools: false, enableBash: false, prewarmEnabled: true,
  locale: 'en', localeSource: 'user_setting',
  webSearch: { provider: 'none', baseUrl: null, hasApiKey: false }, theme: 'system',
}

function installMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: false, media: query, onchange: null,
      addListener: () => undefined, removeListener: () => undefined,
      addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => true,
    }),
  })
}

function Toggle() {
  const { toggle, resolved } = useTheme()
  return <button type="button" onClick={toggle}>toggle {resolved}</button>
}

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } })
  document.documentElement.classList.remove('dark')
  installMatchMedia()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('one theme source of truth (P2)', () => {
  it('a theme chosen with the chrome toggle survives a Settings save and is mirrored to the node', async () => {
    vi.spyOn(api, 'getSettings').mockResolvedValue(SETTINGS)
    vi.spyOn(api, 'listModels').mockResolvedValue({ models: [] })
    const update = vi.spyOn(api, 'updateSettings').mockImplementation(async (patch) => applySettingsPatch(SETTINGS, patch))
    render(<LocaleProvider><ThemeProvider><Toggle /><SettingsPage /></ThemeProvider></LocaleProvider>)
    await screen.findByRole('button', { name: 'Save' })

    fireEvent.click(screen.getByRole('button', { name: 'toggle light' }))
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update.mock.calls[0]![0].theme).toBe('dark')
    await screen.findByText('Settings saved')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem('guanxi.theme')).toBe('dark')
    expect(screen.getAllByRole('button', { name: 'toggle dark' })).toHaveLength(1)
  })
})
