import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CatalogModel, Health, ListCatalogResponse } from '@guanxi/contract'
import { CATALOG_DEFAULT_PAGE_SIZE, listModelsResponse } from '@guanxi/contract'
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

function installedModel(name: string, digest: string) {
  const fit = {
    level: 'green', summary: 'fixture', contextLength: 8_192, modelBytes: 1,
    kvCacheBytes: 0, requiredBytes: 1, usableBytes: 12_000_000_000,
    utilization: 1 / 12_000_000_000, basis: 'vendor_hint', measured: null,
  }
  return {
    name, digest, sizeBytes: 1, modifiedAt: AT, family: 'synthetic', parameterSize: '4B',
    quantization: 'Q4', contextLength: 8_192, capabilities: [], isCloud: false, fit,
    descriptor: {
      reference: {
        state: 'canonical', provider: 'ollama', original: name, normalized: name,
      },
      artifact: { state: 'exact_digest', digest },
      installation: {
        state: 'installed', source: 'ollama_api_tags', observedAt: AT,
        confidence: 'observed',
      },
      capabilities: {
        state: 'unknown', reason: 'field_not_reported', observedAt: AT,
        declarations: [],
      },
      freshness: {
        state: 'unknown', source: 'provider', observedAt: AT,
        reason: 'identity_unavailable', offline: false,
      },
    },
  }
}

function mockInstallFlow(target: string, digest: string) {
  let installed = false
  // Parse like the real client so contract defaults are applied.
  vi.spyOn(api, 'listModels').mockImplementation(async () => listModelsResponse.parse({
    models: installed ? [installedModel(target, digest)] : [],
  }))
  let releaseRefresh!: () => void
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve })
  const catalog = vi.spyOn(api, 'listCatalog').mockImplementation(async (params) => {
    const page = response(params.page ?? 1, 25)
    if (!installed) return page
    await refreshGate
    for (const row of page.models) {
      for (const variant of row.variants) {
        if (variant.normalizedName === target) {
          variant.installation = {
            state: 'installed', digest, source: 'ollama_api_tags', observedAt: AT,
          }
        }
      }
    }
    return page
  })
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
    if (!String(input).endsWith('/start')) throw new Error(String(input))
    installed = true
    return new Response([
      { type: 'progress', seq: 0, data: {
        status: 'downloading', digest: 'sha256:layer', totalBytes: 100,
        completedBytes: 50, percent: 50, bytesPerSecond: 10, etaSeconds: 5,
      } },
      { type: 'done', seq: 1, data: { name: target } },
    ].map((event, index) =>
      `id: ${index}\nevent: guanxi\ndata: ${JSON.stringify(event)}\n\n`,
    ).join(''), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
  }))
  return { catalog, releaseRefresh }
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
    await screen.findByText('Страница 1 из 84, на странице 12, всего найдено 1000')
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
      await screen.findByText(`Страница ${page} из 3, на странице ${page === 3 ? 1 : 12}, всего найдено 25`)
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
    await screen.findByText('Страница 1 из 2, на странице 12, всего найдено 13')
    totalItems = 5
    fireEvent.click(screen.getByRole('button', { name: 'Следующая страница' }))
    expect(await screen.findByText('Эта страница каталога больше недоступна')).toBeTruthy()
    expect(screen.getByText('Страница 2 из 1, на странице 0, всего найдено 5')).toBeTruthy()
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
    await screen.findByText('Страница 1 из 3, на странице 12, всего найдено 25')

    fireEvent.click(screen.getByRole('button', { name: 'Следующая страница' }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[0]!.signal.aborted).toBe(true)
    requests[0]!.resolve(response(1, 1))
    requests[1]!.resolve(response(2, 25))
    await screen.findByText('Страница 2 из 3, на странице 12, всего найдено 25')
    expect(screen.queryByText('Страница 1 из 1, на странице 1, всего найдено 1')).toBeNull()
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

  it('keeps the page and the install result mounted through the post-install refresh', async () => {
    const target = 'synthetic-0012:q4'
    const digest = 'sha256:exact-0012'
    const { catalog, releaseRefresh } = mockInstallFlow(target, digest)
    render(<LauncherPage health={HEALTH} />)
    await screen.findByText('Страница 1 из 3, на странице 12, всего найдено 25')
    fireEvent.click(screen.getByRole('button', { name: 'Следующая страница' }))
    await screen.findByText('Страница 2 из 3, на странице 12, всего найдено 25')
    const variant = screen.getAllByRole('button', { name: 'Выбрать вариант q4' })[0]!
    fireEvent.click(variant)
    expect(screen.getByText(target)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Проверить точную установку' }))
    const callsBeforeInstall = catalog.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /Подтвердить точную цель/u }))
    const dialog = await screen.findByRole('dialog', { name: 'Установка выбранного варианта каталога' })
    await within(dialog).findByText(digest)

    // While the post-install refresh is pending, the card that owns the dialog stays
    // mounted instead of being replaced by a skeleton, and the page is not reset.
    await waitFor(() => expect(catalog.mock.calls.length).toBeGreaterThan(callsBeforeInstall))
    expect(variant.isConnected).toBe(true)
    expect(dialog.isConnected).toBe(true)
    releaseRefresh()

    // The refreshed card reports the digest and the result dialog is still there.
    await waitFor(() => expect(screen.getAllByText(digest)).toHaveLength(2))
    expect(variant.isConnected).toBe(true)
    expect(within(dialog).getByText(digest)).toBeTruthy()
    expect(screen.getByText('Страница 2 из 3, на странице 12, всего найдено 25')).toBeTruthy()
    expect(catalog.mock.calls.slice(callsBeforeInstall).map(([params]) => params.page))
      .toEqual([2])

    fireEvent.click(within(dialog).getByRole('button', { name: 'Готово' }))
    await waitFor(() => expect(
      screen.queryByRole('dialog', { name: 'Установка выбранного варианта каталога' }),
    ).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(variant))
    expect(variant.getAttribute('aria-pressed')).toBe('true')
  })

  it('clears compare rows on install, again for rows added before the refresh lands, and keeps focus', async () => {
    const target = 'synthetic-0000:q4'
    const digest = 'sha256:exact-0000'
    const { releaseRefresh } = mockInstallFlow(target, digest)
    render(<LauncherPage health={HEALTH} />)
    await screen.findByText('Страница 1 из 3, на странице 12, всего найдено 25')
    fireEvent.click(screen.getByRole('button', { name: 'Добавить к сравнению synthetic-0001:q4' }))
    expect(screen.getByRole('button', { name: 'Сравнить точные варианты (1/2)' })).toBeTruthy()
    const variant = screen.getAllByRole('button', { name: 'Выбрать вариант q4' })[0]!
    fireEvent.click(variant)
    fireEvent.click(screen.getByRole('button', { name: 'Проверить точную установку' }))
    fireEvent.click(screen.getByRole('button', { name: /Подтвердить точную цель/u }))
    const dialog = await screen.findByRole('dialog', { name: 'Установка выбранного варианта каталога' })
    await within(dialog).findByText(digest)
    // The pre-install row is cleared as soon as the install is observed.
    expect(screen.getByText('Сравнение очищено', { exact: false })).toBeTruthy()
    expect(screen.getByText('Сравнить точные варианты (0/2)', { exact: false })).toBeTruthy()

    // Done before the refresh lands: focus returns to the install button.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Готово' }))
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Проверить точную установку'))
    // A row added meanwhile still holds pre-install facts.
    fireEvent.click(screen.getByRole('button', { name: `Добавить к сравнению ${target}` }))
    expect(screen.getByRole('button', { name: 'Сравнить точные варианты (1/2)' })).toBeTruthy()
    releaseRefresh()

    // The refresh swaps the focused install button for links; focus moves to the
    // chosen variant, and the stale row is dropped.
    await waitFor(() => expect(document.activeElement).toBe(variant))
    expect(screen.queryByRole('button', { name: 'Проверить точную установку' })).toBeNull()
    await waitFor(() => expect(
      screen.getByText('Сравнить точные варианты (0/2)', { exact: false }),
    ).toBeTruthy())
  })

  it('keeps the skeleton when an install lands while another basis is loading', async () => {
    let installed = false
    vi.spyOn(api, 'listModels').mockImplementation(async () => listModelsResponse.parse({
      models: installed ? [installedModel('qwen3:8b', 'sha256:fixture')] : [],
    }))
    let gate: Promise<void> | null = null
    vi.spyOn(api, 'listCatalog').mockImplementation(async (params) => {
      if (gate) await gate
      return response(params.page ?? 1, 25)
    })
    vi.spyOn(api, 'previewOllamaReference').mockResolvedValue({
      preview: {
        inputKind: 'model_name', displayValue: 'qwen3:8b', normalizedModelName: 'qwen3:8b',
      },
    })
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      if (!String(input).endsWith('/start')) throw new Error(String(input))
      installed = true
      return new Response(
        `id: 0\nevent: guanxi\ndata: ${JSON.stringify({ type: 'done', seq: 0, data: { name: 'qwen3:8b' } })}\n\n`,
        { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
      )
    }))
    // hidden: the AddFromOllama dialog marks the page behind it aria-hidden.
    const carousel = () => screen.queryByRole('group', { name: 'Каталог моделей', hidden: true })
    render(<LauncherPage health={HEALTH} />)
    await screen.findByText('Страница 1 из 3, на странице 12, всего найдено 25')

    // A new query is loading: the old cards are replaced by the skeleton.
    let release!: () => void
    gate = new Promise<void>((resolve) => { release = resolve })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Поиск по каталогу моделей' }), {
      target: { value: 'synthetic-0001' },
    })
    await waitFor(() => expect(carousel()).toBeNull(), { timeout: 2_000 })

    // An install from another flow completes meanwhile; it must not bring the old
    // query's cards back.
    fireEvent.click(screen.getByRole('button', { name: /Добавить модель/u }))
    const input = screen.getByRole('textbox', { name: /Имя модели/u })
    fireEvent.change(input, { target: { value: 'qwen3:8b' } })
    fireEvent.submit(input.closest('form')!)
    fireEvent.click(await screen.findByRole('button', { name: /Подтвердить нормализованную цель/u }))
    await screen.findByText('Ollama сообщила о завершении pull')
    expect(carousel()).toBeNull()
    gate = null
    release()
    await waitFor(() => expect(carousel()).not.toBeNull())
  })

  it('replaces the cards with a skeleton for page and query, and recovers a failed read quietly', async () => {
    vi.spyOn(api, 'listModels').mockResolvedValue({ models: [] })
    let gate: Promise<void> | null = null
    let failNext = false
    vi.spyOn(api, 'listCatalog').mockImplementation(async (params) => {
      if (gate) await gate
      if (failNext) {
        failNext = false
        throw new Error('catalog down')
      }
      return response(params.page ?? 1, 25)
    })
    const hold = () => {
      let release!: () => void
      gate = new Promise<void>((resolve) => { release = resolve })
      return () => {
        gate = null
        release()
      }
    }
    const carousel = () => screen.queryByRole('group', { name: 'Каталог моделей' })
    render(<LauncherPage health={HEALTH} />)
    await screen.findByText('Страница 1 из 3, на странице 12, всего найдено 25')
    expect(carousel()).not.toBeNull()

    let release = hold()
    fireEvent.click(screen.getByRole('button', { name: 'Следующая страница' }))
    await waitFor(() => expect(carousel()).toBeNull())
    release()
    await screen.findByText('Страница 2 из 3, на странице 12, всего найдено 25')
    expect(carousel()).not.toBeNull()

    release = hold()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Поиск по каталогу моделей' }), {
      target: { value: 'synthetic' },
    })
    await waitFor(() => expect(carousel()).toBeNull(), { timeout: 2_000 })
    release()
    await waitFor(() => expect(carousel()).not.toBeNull())

    // D-203: no Refresh or Retry button. A failed read keeps its error on screen, with no
    // skeleton flash and no stale cards, until a quiet recovery read replaces it.
    expect(screen.queryAllByRole('button', { name: /^(Обновить|Повторить)$/u })).toHaveLength(0)
    failNext = true
    fireEvent.change(screen.getByRole('searchbox', { name: 'Поиск по каталогу моделей' }), {
      target: { value: 'synthetic-2' },
    })
    await screen.findByText('Каталог недоступен', undefined, { timeout: 2_000 })
    expect(carousel()).toBeNull()
    release = hold()
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(screen.getByText('Каталог недоступен')).toBeTruthy()
    expect(carousel()).toBeNull()
    release()
    await waitFor(() => expect(carousel()).not.toBeNull())
    expect(screen.queryByText('Каталог недоступен')).toBeNull()
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
