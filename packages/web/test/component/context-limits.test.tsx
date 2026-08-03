import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Health, LocalModel, ModelDetail, Settings } from '@alamo/contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LauncherPage } from '../../src/features/launcher/LauncherPage.tsx'
import { ModelPage } from '../../src/features/models/ModelPage.tsx'
import { SettingsPage } from '../../src/features/settings/SettingsPage.tsx'
import { api } from '../../src/lib/api.ts'
import { ThemeProvider } from '../../src/lib/theme.tsx'

const CUSTOM_CONTEXT = 1_048_577
const OBSERVED_AT = '2026-08-03T00:00:00.000Z'

const HEALTH: Health = {
  ok: true,
  appVersion: 'test',
  application: { state: 'reachable', source: 'application_http', observedAt: OBSERVED_AT },
  ollama: {
    installed: true, running: true, state: 'reachable', source: 'ollama_api_version',
    observedAt: OBSERVED_AT, version: '0.12.6', host: 'http://fixture.invalid', installHint: null,
  },
  hardware: {
    platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8,
    totalMemoryBytes: 16_000_000_000, usableMemoryBytes: 12_000_000_000,
    accelerator: 'metal', acceleratorName: 'fixture profile', unifiedMemory: true,
    freeDiskBytes: null,
  },
  network: { ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked' },
}

const SETTINGS: Settings = {
  ollamaHost: 'http://127.0.0.1:11434', defaultModel: 'fixture:latest',
  defaultNumCtx: 32_768, autoApproveTools: false, enableBash: false,
  prewarmEnabled: true,
  webSearch: { provider: 'none', baseUrl: null, hasApiKey: false }, theme: 'system',
}

function fit(contextLength: number) {
  return {
    level: 'green' as const, summary: `fit ${contextLength}`, contextLength,
    modelBytes: 1_000, kvCacheBytes: contextLength, requiredBytes: contextLength + 1_000,
    usableBytes: 12_000_000_000, utilization: 0.1, basis: 'estimate' as const, measured: null,
  }
}

function local(contextLength = CUSTOM_CONTEXT): LocalModel {
  return {
    name: 'fixture:latest', digest: 'sha256:fixture', sizeBytes: 1_000,
    modifiedAt: OBSERVED_AT, family: 'fixture', parameterSize: '1B', quantization: 'Q4',
    contextLength: 2_000_000,
    contextLimit: {
      state: 'declared', value: 2_000_000, source: 'ollama_api_tags',
      observedAt: OBSERVED_AT, confidence: 'declared',
    },
    capabilities: ['completion'], isCloud: false, fit: fit(contextLength),
  }
}

function detail(contextLength: number): ModelDetail {
  return {
    ...local(contextLength),
    fit: fit(contextLength),
    fitByContext: [fit(8_192), fit(contextLength), fit(2_000_000)],
    modelInfo: {}, template: null, systemPrompt: null, license: null,
  }
}

afterEach(() => vi.restoreAllMocks())

function installMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    }),
  })
}

describe('no-artificial-context-cap UI', () => {
  it('saves and reloads an exact Settings value above the retired ceiling', async () => {
    vi.spyOn(api, 'getSettings').mockResolvedValue(SETTINGS)
    vi.spyOn(api, 'listModels').mockResolvedValue({ models: [local()] })
    const update = vi.spyOn(api, 'updateSettings').mockImplementation(async (patch) => ({
      ...SETTINGS, ...patch, defaultNumCtx: patch.defaultNumCtx ?? SETTINGS.defaultNumCtx,
    }))
    installMatchMedia()
    render(<ThemeProvider><SettingsPage /></ThemeProvider>)
    const input = await screen.findByLabelText('Контекст агента по умолчанию')
    expect((input as HTMLInputElement).hasAttribute('max')).toBe(false)
    fireEvent.change(input, { target: { value: String(CUSTOM_CONTEXT) } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ defaultNumCtx: CUSTOM_CONTEXT })))
    expect((input as HTMLInputElement).value).toBe(String(CUSTOM_CONTEXT))

    fireEvent.change(input, { target: { value: '1.5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(screen.getByRole('alert').textContent).toContain('положительное целое число')
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('treats Launcher presets as suggestions and applies a keyboard-entered custom context exactly', async () => {
    const listModels = vi.spyOn(api, 'listModels').mockResolvedValue({ models: [] })
    vi.spyOn(api, 'listCatalog').mockResolvedValue({ models: [], live: false })
    installMatchMedia()
    const view = render(<LauncherPage health={HEALTH} />)
    const input = screen.getByLabelText('Размер окна контекста для расчёта влезаемости')
    fireEvent.change(input, { target: { value: String(CUSTOM_CONTEXT) } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(listModels).toHaveBeenLastCalledWith(CUSTOM_CONTEXT, expect.any(AbortSignal)))
    expect(view.container.textContent).toContain('Preset-значения — только подсказки')
    expect(screen.getByText('Профиль ускорителя').parentElement?.getAttribute('title'))
      .toContain('Этот adapter не сообщает число devices')
  })

  it('requests one custom Model Profile fit and explains sourced maximum without clamping', async () => {
    const getModel = vi.spyOn(api, 'getModel').mockImplementation(async (_name, contextLength) =>
      detail(contextLength ?? 8_192),
    )
    const view = render(<ModelPage name="fixture:latest" health={HEALTH} />)
    const input = await screen.findByLabelText('Свой размер окна контекста')
    fireEvent.change(input, { target: { value: String(CUSTOM_CONTEXT) } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(getModel).toHaveBeenLastCalledWith('fixture:latest', CUSTOM_CONTEXT, expect.any(AbortSignal)))
    expect(view.container.textContent).toContain('Объявленный provider максимум: 1.9M')
    expect(screen.getAllByText(/1M окно/).length).toBeGreaterThan(0)
  })
})
