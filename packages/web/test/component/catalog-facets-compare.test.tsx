import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CatalogModel, Health, ListCatalogResponse } from '@guanxi/contract'
import { useMemo, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LauncherPage } from '../../src/features/launcher/LauncherPage.tsx'
import { CatalogCompare, exactCatalogRows } from '../../src/features/models/CatalogCompare.tsx'
import {
  CatalogFilters,
  EMPTY_CATALOG_FILTERS,
  type CatalogFilterState,
} from '../../src/features/models/CatalogFilters.tsx'
import { CatalogVariantInstall } from '../../src/features/models/CatalogVariantInstall.tsx'
import { api } from '../../src/lib/api.ts'
import { setActiveLocale } from '../../src/lib/locale.ts'

const AT = '2026-08-04T00:00:00.000Z'
const originalFetch = globalThis.fetch

const HEALTH: Health = {
  ok: true, appVersion: 'test',
  application: { state: 'reachable', source: 'application_http', observedAt: AT },
  ollama: {
    installed: true, running: true, state: 'reachable', source: 'ollama_api_version',
    observedAt: AT, version: '0.12.6', host: 'http://fixture.invalid', installHint: null,
  },
  hardware: {
    platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8,
    totalMemoryBytes: 16_000_000_000, usableMemoryBytes: 12_000_000_000,
    accelerator: 'metal', acceleratorName: 'fixture', unifiedMemory: true,
    freeDiskBytes: null,
  },
  network: { ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked' },
}

function fit(level: 'green' | 'red', bytes: number) {
  return {
    level, summary: level, contextLength: 8_192, modelBytes: bytes,
    kvCacheBytes: 0, requiredBytes: bytes, usableBytes: 12_000_000_000,
    utilization: bytes / 12_000_000_000, basis: 'vendor_hint' as const, measured: null,
  }
}

function catalog(): CatalogModel {
  return {
    name: 'fixture', description: 'pair facts',
    variants: [
      {
        tag: 'a', normalizedName: 'fixture:a', sizeBytes: 1_000,
        parameterSize: '1B', contextLength: 8_192,
        fit: { state: 'calculated', source: 'catalog_claim', contextLength: 8_192, verdict: fit('red', 1_000) },
        installation: { state: 'installed', digest: 'sha256:a', source: 'ollama_api_tags', observedAt: AT },
        source: 'local_cache', freshness: 'stale', sourceObservedAt: AT,
        sourceFetchedAt: '2026-08-01T00:00:00.000Z',
      },
      {
        tag: 'b', normalizedName: 'fixture:b', sizeBytes: null,
        parameterSize: null, contextLength: null,
        fit: { state: 'unknown', source: 'catalog_claim', contextLength: null, verdict: null, reason: 'size_unknown' },
        installation: {
          state: 'unknown', digest: null, source: 'unavailable', observedAt: null,
          reason: 'provider_unavailable',
        },
        source: 'bundled', freshness: 'fallback', sourceObservedAt: AT,
        sourceFetchedAt: '2026-08-02T00:00:00.000Z',
      },
      {
        tag: 'invalid', normalizedName: null, sizeBytes: 2_000,
        parameterSize: '2B', contextLength: 8_192,
        fit: { state: 'unknown', source: 'catalog_claim', contextLength: 8_192, verdict: null, reason: 'invalid_variant' },
        installation: {
          state: 'unknown', digest: null, source: 'unavailable', observedAt: null,
          reason: 'ambiguous_installed_reference',
        },
        source: 'bundled', freshness: 'fallback', sourceObservedAt: AT,
        sourceFetchedAt: '2026-08-02T00:00:00.000Z',
      },
    ],
    contextLength: 8_192, capabilities: [], vramBytes: null, isCloud: false,
    requiredPlan: null, installed: true,
    // Deliberately opposite legacy aggregate; compare must use exact row A.
    fit: fit('green', 1),
    installedProjection: 'variant_aggregate_compatibility',
    fitProjection: 'largest_variant_compatibility', source: 'local_cache',
    freshness: 'stale', sourceObservedAt: AT,
    sourceFetchedAt: '2026-08-01T00:00:00.000Z',
  }
}

const EMPTY_RESPONSE: ListCatalogResponse = { models: [], live: false }

afterEach(() => {
  vi.restoreAllMocks()
  vi.stubGlobal('fetch', originalFetch)
  setActiveLocale('ru')
})

describe('catalog query transport and filter projection', () => {
  it('serializes one deterministic CSV value per group and forwards AbortSignal without mutations', async () => {
    const calls: Array<{ url: string; method: string; signal: AbortSignal | null }> = []
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', signal: init?.signal ?? null })
      return new Response(JSON.stringify(EMPTY_RESPONSE), {
        headers: { 'content-type': 'application/json' },
      })
    }))
    const controller = new AbortController()
    await api.listCatalog({
      q: 'Coder', contextLength: 1_048_577,
      installation: ['installed', 'unknown'], fit: ['green', 'yellow'],
      providerScope: ['local'], source: ['local_cache', 'bundled'],
      freshness: ['stale', 'fallback'], capability: ['tools', 'unknown'],
      minClaimedContext: 32_768, maxClaimedArtifactSize: Number.MAX_SAFE_INTEGER,
    }, controller.signal)
    const url = new URL(calls[0]!.url, 'http://fixture.invalid')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'Coder', contextLength: '1048577', installation: 'installed,unknown',
      fit: 'green,yellow', providerScope: 'local', source: 'local_cache,bundled',
      freshness: 'stale,fallback', capability: 'tools,unknown',
      minClaimedContext: '32768', maxClaimedArtifactSize: '9007199254740991',
    })
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.signal).toBe(controller.signal)
  })

  it('validates arbitrary positive safe integers, shows applied summary and clears once', async () => {
    function Harness() {
      const [value, setValue] = useState<CatalogFilterState>(EMPTY_CATALOG_FILTERS)
      return <CatalogFilters value={value} onChange={setValue} onClear={() => setValue(EMPTY_CATALOG_FILTERS)} />
    }
    render(<Harness />)
    fireEvent.click(screen.getByText('Фильтры фактов каталога'))
    fireEvent.click(screen.getByLabelText('установлен'))
    const numbers = screen.getAllByRole('spinbutton')
    fireEvent.change(numbers[0]!, { target: { value: '1048577' } })
    fireEvent.keyDown(numbers[0]!, { key: 'Enter' })
    expect(screen.getByLabelText('Применённые фильтры каталога').textContent).toContain('1M')
    expect((numbers[0] as HTMLInputElement).hasAttribute('max')).toBe(false)
    fireEvent.change(numbers[1]!, { target: { value: '1.5' } })
    fireEvent.keyDown(numbers[1]!, { key: 'Enter' })
    expect(screen.getByRole('alert').textContent).toContain('положительное целое число')
    fireEvent.click(screen.getAllByLabelText('Явно неизвестно')[1]!)
    expect(screen.queryByRole('alert')).toBeNull()
    expect((numbers[1] as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить фильтры' }))
    expect(screen.queryByLabelText('Применённые фильтры каталога')).toBeNull()
  })

  it('aborts the previous debounced request and ignores its late response', async () => {
    vi.spyOn(api, 'listModels').mockResolvedValue({ models: [] })
    const requests: Array<{
      q: string | undefined
      signal: AbortSignal
      resolve: (value: ListCatalogResponse) => void
    }> = []
    vi.spyOn(api, 'listCatalog').mockImplementation((params, signal) =>
      new Promise((resolve) => requests.push({ q: params.q, signal: signal!, resolve })),
    )
    render(<LauncherPage health={HEALTH} />)
    await waitFor(() => expect(requests).toHaveLength(1))
    const search = screen.getByLabelText('Поиск по каталогу моделей')
    fireEvent.change(search, { target: { value: 'new' } })
    await waitFor(() => expect(requests).toHaveLength(2), { timeout: 1_000 })
    expect(requests[0]!.signal.aborted).toBe(true)
    requests[1]!.resolve(EMPTY_RESPONSE)
    expect(await screen.findByText('Нет подходящих точных вариантов')).toBeTruthy()
    requests[0]!.resolve({ ...EMPTY_RESPONSE, models: [catalog()] })
    await Promise.resolve()
    expect(screen.queryByRole('button', { name: 'Добавить к сравнению fixture:a' })).toBeNull()
  })

  it('distinguishes a transport error that recovers by itself and filtered empty clear without resource actions', async () => {
    vi.spyOn(api, 'listModels').mockResolvedValue({ models: [] })
    const catalogApi = vi.spyOn(api, 'listCatalog')
      .mockRejectedValueOnce(new Error('safe catalog failure'))
      .mockResolvedValue(EMPTY_RESPONSE)
    render(<LauncherPage health={HEALTH} />)
    expect(await screen.findByText('Каталог недоступен')).toBeTruthy()
    expect(screen.queryAllByRole('button', { name: /^(Повторить|Обновить)$/u })).toHaveLength(0)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(await screen.findByText('Каталог пуст')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Поиск по каталогу моделей'), { target: { value: 'absent' } })
    expect(await screen.findByText('Нет подходящих точных вариантов')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить поиск и фильтры' }))
    await waitFor(() => expect(catalogApi).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: undefined }), expect.any(AbortSignal),
    ))
  })
})

describe('pairwise exact variant compare', () => {
  function Harness() {
    const model = useMemo(catalog, [])
    const rows = useMemo(() => exactCatalogRows([model]), [model])
    const [targets, setTargets] = useState<string[]>([])
    return (
      <>
        <CatalogVariantInstall
          model={model}
          compareTargets={targets}
          onToggleCompare={(variant) => {
            if (variant.normalizedName === null) return
            setTargets((current) => current.includes(variant.normalizedName!)
              ? current.filter((target) => target !== variant.normalizedName)
              : current.length < 2 ? [...current, variant.normalizedName!] : current)
          }}
        />
        <CatalogCompare
          rows={rows}
          selectedTargets={targets}
          onRemove={(target) => setTargets((current) => current.filter((value) => value !== target))}
          onSwap={() => setTargets((current) => [...current].reverse())}
        />
      </>
    )
  }

  it('selects exact A/B only, rejects invalid/third/duplicate, and shows exact facts without a winner', async () => {
    vi.stubGlobal('fetch', vi.fn())
    render(<Harness />)
    const invalid = screen.getByRole('button', { name: 'Добавить к сравнению invalid' })
    expect((invalid as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Добавить к сравнению fixture:a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Добавить к сравнению fixture:b' }))
    const open = screen.getByRole('button', { name: 'Сравнить точные варианты (2/2)' })
    fireEvent.click(open)
    const dialog = screen.getByRole('dialog', { name: 'Сравнение точных вариантов' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Поменять колонки местами' })).toBe(document.activeElement))
    expect(dialog.textContent).toContain('sha256:a')
    expect(dialog.textContent).toContain('красный расчётный fit')
    expect(screen.queryByRole('heading', { name: /winner|recommended/i })).toBeNull()
    expect(dialog.textContent).toContain('Сравнение не создаёт winner')
    expect(globalThis.fetch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Поменять колонки местами' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(open))
  })

  it('supports keyboard remove and closes without pull/probe/prewarm/load', async () => {
    vi.stubGlobal('fetch', vi.fn())
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Добавить к сравнению fixture:a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Добавить к сравнению fixture:b' }))
    fireEvent.click(screen.getByRole('button', { name: 'Сравнить точные варианты (2/2)' }))
    const remove = screen.getByRole('button', { name: 'Убрать из сравнения fixture:b' })
    remove.focus()
    fireEvent.keyDown(remove, { key: 'Enter' })
    fireEvent.click(remove)
    expect(screen.getByRole('button', { name: 'Сравнить точные варианты (1/2)' })).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('button', {
      name: 'Убрать из сравнения fixture:a',
    })).toBe(document.activeElement))
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('fails duplicate exact targets closed before selection', () => {
    const duplicate = catalog()
    duplicate.variants[1] = {
      ...duplicate.variants[1]!, normalizedName: 'fixture:a', tag: 'duplicate-a',
    }
    expect(exactCatalogRows([duplicate])).toEqual([])
  })

  it('uses English fallback for filters and comparison', () => {
    setActiveLocale('en')
    render(
      <>
        <CatalogFilters value={EMPTY_CATALOG_FILTERS} onChange={() => undefined} onClear={() => undefined} />
        <Harness />
      </>,
    )
    expect(screen.getByText('Filter catalog facts')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Compare exact variants (0/2)' })).toBeTruthy()
  })
})
