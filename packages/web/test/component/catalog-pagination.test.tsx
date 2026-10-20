import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CatalogModel, Health, ListCatalogResponse } from '@guanxi/contract'
import { CATALOG_DEFAULT_PAGE_SIZE } from '@guanxi/contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CatalogPager,
  LauncherPage,
  projectCatalogPage,
} from '../../src/features/launcher/LauncherPage.tsx'
import { api } from '../../src/lib/api.ts'
import { setActiveLocale } from '../../src/lib/locale.ts'

const AT = '2026-08-04T00:00:00.000Z'
const TOTAL = 1_000
const HEALTH: Health = {
  ok: true,
  appVersion: 'test',
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

const originalFetch = globalThis.fetch

function model(index: number): CatalogModel {
  const target = `synthetic-${String(index).padStart(4, '0')}:q4`
  const sizeBytes = 1_000_000_000 + index
  return {
    name: `synthetic-${String(index).padStart(4, '0')}`,
    description: `Synthetic row ${index}`,
    variants: [{
      tag: 'q4', normalizedName: target, sizeBytes, parameterSize: '4B',
      contextLength: 32_768,
      fit: {
        state: 'calculated', source: 'catalog_claim', contextLength: 8_192,
        verdict: {
          level: 'green', summary: 'fixture', contextLength: 8_192,
          modelBytes: sizeBytes, kvCacheBytes: 0, requiredBytes: sizeBytes,
          usableBytes: 12_000_000_000, utilization: sizeBytes / 12_000_000_000,
          basis: 'vendor_hint', measured: null,
        },
      },
      installation: {
        state: 'not_installed', digest: null, source: 'ollama_api_tags', observedAt: AT,
      },
      source: 'bundled', freshness: 'fallback', sourceObservedAt: AT,
      sourceFetchedAt: '2026-08-02T00:00:00.000Z',
    }],
    contextLength: 32_768, capabilities: ['completion'], vramBytes: null,
    isCloud: false, requiredPlan: null, installed: false,
    fit: {
      level: 'green', summary: 'fixture', contextLength: 8_192,
      modelBytes: sizeBytes, kvCacheBytes: 0, requiredBytes: sizeBytes,
      usableBytes: 12_000_000_000, utilization: sizeBytes / 12_000_000_000,
      basis: 'vendor_hint', measured: null,
    },
    installedProjection: 'variant_aggregate_compatibility',
    fitProjection: 'largest_variant_compatibility', source: 'bundled',
    freshness: 'fallback', sourceObservedAt: AT,
    sourceFetchedAt: '2026-08-02T00:00:00.000Z',
  }
}

function response(page: number, totalItems = TOTAL): ListCatalogResponse {
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / CATALOG_DEFAULT_PAGE_SIZE)
  const start = page <= totalPages ? (page - 1) * CATALOG_DEFAULT_PAGE_SIZE : totalItems
  const end = Math.min(start + CATALOG_DEFAULT_PAGE_SIZE, totalItems)
  return {
    models: Array.from({ length: Math.max(0, end - start) }, (_, offset) => model(start + offset)),
    live: false,
    source: {
      state: 'bundled_fallback', source: 'bundled_snapshot', observedAt: AT,
      fetchedAt: '2026-08-02T00:00:00.000Z',
    },
    pagination: {
      mode: 'paged', page, pageSize: CATALOG_DEFAULT_PAGE_SIZE, totalItems, totalPages,
      previousPage: page > 1 && page <= totalPages ? page - 1 : null,
      nextPage: page < totalPages ? page + 1 : null,
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.stubGlobal('fetch', originalFetch)
  setActiveLocale('ru')
})

describe('bounded catalog paging', () => {
  it('renders one bounded page and constant pager controls for 1,000 logical rows', async () => {
    vi.spyOn(api, 'listModels').mockResolvedValue({ models: [] })
    const catalog = vi.spyOn(api, 'listCatalog').mockImplementation(async (params) =>
      response(params.page ?? 1),
    )
    const { container } = render(<LauncherPage health={HEALTH} />)
    await screen.findByText('Страница 1 из 84 · на странице 12 · всего найдено 1000')
    expect(catalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, pageSize: 12 }), expect.any(AbortSignal),
    )
    const catalogCarousel = screen.getByRole('group', { name: 'Каталог моделей' })
    expect(catalogCarousel.querySelectorAll('.embla-slide')).toHaveLength(12)
    expect(container.querySelectorAll('[role="tab"][aria-label^="Модель "]')).toHaveLength(12)
    const pager = screen.getByRole('navigation', { name: 'Страницы каталога' })
    expect(within(pager).getAllByRole('button')).toHaveLength(2)
  })

  it('keeps two exact snapshots across distant pages and resets on accepted query changes', async () => {
    vi.spyOn(api, 'listModels').mockResolvedValue({ models: [] })
    vi.spyOn(api, 'listCatalog').mockImplementation(async (params) => response(params.page ?? 1, 25))
    render(<LauncherPage health={HEALTH} />)
    await screen.findByRole('button', { name: 'Добавить к сравнению synthetic-0000:q4' })
    fireEvent.click(screen.getByRole('button', { name: 'Добавить к сравнению synthetic-0000:q4' }))
    const pager = screen.getByRole('navigation', { name: 'Страницы каталога' })
    for (let page = 2; page <= 3; page += 1) {
      fireEvent.click(within(pager).getByRole('button', { name: 'Следующая страница' }))
      await screen.findByText(`Страница ${page} из 3 · на странице ${page === 3 ? 1 : 12} · всего найдено 25`)
    }
    fireEvent.click(screen.getByRole('button', { name: 'Добавить к сравнению synthetic-0024:q4' }))
    const compare = screen.getByRole('button', { name: 'Сравнить точные варианты (2/2)' })
    fireEvent.click(compare)
    expect(screen.getByRole('dialog', { name: 'Сравнение точных вариантов' }).textContent)
      .toContain('synthetic-0000:q4')
    expect(screen.getByRole('dialog', { name: 'Сравнение точных вариантов' }).textContent)
      .toContain('synthetic-0024:q4')
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.change(screen.getByLabelText('Поиск по каталогу моделей'), {
      target: { value: 'changed' },
    })
    expect(screen.getByText(/Сравнение очищено/u)).toBeTruthy()
    expect((screen.getByRole('button', {
      name: 'Сравнить точные варианты (0/2)',
    }) as HTMLButtonElement).disabled).toBe(true)
    await waitFor(() => expect(api.listCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, q: 'changed' }), expect.any(AbortSignal),
    ), { timeout: 1_000 })
  })

  it('shows source shrink as an explicit empty requested page without optimistic count', async () => {
    vi.spyOn(api, 'listModels').mockResolvedValue({ models: [] })
    let totalItems = 13
    vi.spyOn(api, 'listCatalog').mockImplementation(async (params) =>
      response(params.page ?? 1, totalItems),
    )
    render(<LauncherPage health={HEALTH} />)
    await screen.findByText('Страница 1 из 2 · на странице 12 · всего найдено 13')
    totalItems = 5
    fireEvent.click(screen.getByRole('button', { name: 'Следующая страница' }))
    expect(await screen.findByText('Эта страница каталога больше недоступна')).toBeTruthy()
    expect(screen.getByText('Страница 2 из 1 · на странице 0 · всего найдено 5')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Вернуться на первую страницу' })).toBeTruthy()
  })

  it('aborts and ignores a late old page before accepting the requested page', async () => {
    vi.spyOn(api, 'listModels').mockResolvedValue({ models: [] })
    const requests: Array<{
      page: number
      signal: AbortSignal
      resolve: (value: ListCatalogResponse) => void
    }> = []
    vi.spyOn(api, 'listCatalog').mockImplementation((params, signal) =>
      new Promise((resolve) => requests.push({ page: params.page ?? 1, signal: signal!, resolve })),
    )
    render(<LauncherPage health={HEALTH} />)
    await waitFor(() => expect(requests).toHaveLength(1))
    requests[0]!.resolve(response(1, 25))
    await screen.findByText('Страница 1 из 3 · на странице 12 · всего найдено 25')

    fireEvent.click(screen.getByRole('button', { name: 'Следующая страница' }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[0]!.signal.aborted).toBe(true)
    requests[0]!.resolve(response(1, 1))
    requests[1]!.resolve(response(2, 25))
    await screen.findByText('Страница 2 из 3 · на странице 12 · всего найдено 25')
    expect(screen.queryByText('Страница 1 из 1 · на странице 1 · всего найдено 1')).toBeNull()
  })

  it('keeps the real exact pull owned while page navigation is blocked', async () => {
    vi.spyOn(api, 'listModels').mockResolvedValue({ models: [] })
    const catalog = vi.spyOn(api, 'listCatalog').mockResolvedValue(response(1, 25))
    let pullSignal: AbortSignal | null = null
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
      if (String(input).endsWith('/start')) {
        pullSignal = init?.signal ?? null
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('fixture cleanup', 'AbortError')),
            { once: true },
          )
        })
      }
      throw new Error(String(input))
    }))
    const view = render(<LauncherPage health={HEALTH} />)
    await waitFor(() => expect(
      screen.getAllByRole('button', { name: 'Выбрать вариант q4' }),
    ).toHaveLength(CATALOG_DEFAULT_PAGE_SIZE))
    fireEvent.click(screen.getAllByRole('button', { name: 'Выбрать вариант q4' })[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'Проверить точную установку' }))
    fireEvent.click(screen.getByRole('button', { name: /Подтвердить точную цель/u }))
    await screen.findByText(/Pull не был отменён/u)

    const next = screen.getByText('Следующая страница').closest('button') as HTMLButtonElement
    expect(next.disabled).toBe(true)
    fireEvent.click(next)
    expect(catalog).toHaveBeenCalledTimes(1)
    expect(pullSignal?.aborted).toBe(false)

    view.unmount()
    await waitFor(() => expect(pullSignal?.aborted).toBe(true))
  })

  it('keeps legacy full responses compatible while bounding their client DOM page', () => {
    const legacy: ListCatalogResponse = {
      models: Array.from({ length: 25 }, (_, index) => model(index)),
      live: false,
    }
    const page = projectCatalogPage(legacy, 2)
    expect(page.models).toHaveLength(12)
    expect(page.models[0]?.name).toBe('synthetic-0012')
    expect(page.totalItems).toBe(25)
    expect(page.totalPages).toBe(3)
  })

  it('announces and disables page navigation during an active exact pull', () => {
    render(
      <CatalogPager
        page={2} totalPages={3} totalItems={30} pageItems={12}
        previousPage={1} nextPage={3} loading={false} pullActive
        onPage={() => undefined}
      />,
    )
    expect(screen.getByText(/Pull не был отменён/u)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Предыдущая страница' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Следующая страница' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
