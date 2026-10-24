import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CatalogModel } from '@guanxi/contract'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CatalogVariantInstall } from '../../src/features/models/CatalogVariantInstall.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'
import { factPairs } from '../helpers/facts.ts'

const originalFetch = globalThis.fetch
const AT = '2026-08-04T00:00:00.000Z'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sse(...events: unknown[]): Response {
  return new Response(events.map((event, index) =>
    `id: ${index}\nevent: guanxi\ndata: ${JSON.stringify(event)}\n\n`,
  ).join(''), {
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  })
}

const verdict = (modelBytes: number, level: 'green' | 'red') => ({
  level,
  summary: level,
  contextLength: 8_192,
  modelBytes,
  kvCacheBytes: 0,
  requiredBytes: modelBytes,
  usableBytes: 10_000,
  utilization: modelBytes / 10_000,
  basis: 'vendor_hint' as const,
  measured: null,
})

function catalog(options: {
  installed?: 'a' | 'b' | null
  invalidB?: boolean
  unknownB?: boolean
} = {}): CatalogModel {
  const variant = (
    tag: 'a' | 'b',
    normalizedName: string | null,
    sizeBytes: number | null,
  ): CatalogModel['variants'][number] => ({
    tag,
    normalizedName,
    sizeBytes,
    parameterSize: tag === 'a' ? '1B' : '9B',
    contextLength: 8_192,
    fit: normalizedName === null
      ? {
          state: 'unknown', source: 'catalog_claim', contextLength: 8_192,
          verdict: null, reason: 'invalid_variant',
        }
      : sizeBytes === null
        ? {
            state: 'unknown', source: 'catalog_claim', contextLength: 8_192,
            verdict: null, reason: 'size_unknown',
          }
        : {
            state: 'calculated', source: 'catalog_claim', contextLength: 8_192,
            verdict: verdict(sizeBytes, tag === 'a' ? 'green' : 'red'),
          },
    installation: options.installed === tag
      ? { state: 'installed', digest: `sha256:${tag}`, source: 'ollama_api_tags', observedAt: AT }
      : { state: 'not_installed', digest: null, source: 'ollama_api_tags', observedAt: AT },
    source: 'bundled', freshness: 'fallback', sourceObservedAt: AT,
    sourceFetchedAt: '2026-08-02T00:00:00.000Z',
  })

  return {
    name: 'fixture',
    description: 'fixture catalog model',
    variants: [
      variant('a', 'fixture:a', 1_000),
      variant(
        'b',
        options.invalidB ? null : 'fixture:b',
        options.unknownB ? null : 9_000,
      ),
    ],
    contextLength: 8_192,
    capabilities: [],
    vramBytes: null,
    isCloud: false,
    requiredPlan: null,
    installed: options.installed !== null && options.installed !== undefined,
    fit: verdict(9_000, 'red'),
    installedProjection: 'variant_aggregate_compatibility',
    fitProjection: 'largest_variant_compatibility',
    source: 'bundled', freshness: 'fallback', sourceObservedAt: AT,
    sourceFetchedAt: '2026-08-02T00:00:00.000Z',
  }
}

function installed(name: string, digest = `sha256:${name}`) {
  return {
    name, digest, sizeBytes: 1, modifiedAt: AT, family: 'fixture', parameterSize: '1B',
    quantization: 'Q4', contextLength: 8_192, capabilities: [], isCloud: false,
    fit: verdict(1, 'green'),
    descriptor: {
      reference: { state: 'canonical', provider: 'ollama', original: name, normalized: name },
      artifact: { state: 'exact_digest', digest },
      installation: {
        state: 'installed', source: 'ollama_api_tags', observedAt: AT, confidence: 'observed',
      },
      capabilities: {
        state: 'unknown', reason: 'field_not_reported', observedAt: AT, declarations: [],
      },
      freshness: {
        state: 'unknown', source: 'provider', observedAt: AT,
        reason: 'identity_unavailable', offline: false,
      },
    },
  }
}

afterEach(() => {
  vi.stubGlobal('fetch', originalFetch)
  setActiveLocale('ru')
})

describe('variant-first Marketplace install', () => {
  it('does not pull on mount, focus, hover, navigation or selection and requires an exact variant', () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal('fetch', fetch)
    render(<CatalogVariantInstall model={catalog()} />)
    const install = screen.getByRole('button', { name: 'Сначала выберите вариант' })
    expect((install as HTMLButtonElement).disabled).toBe(true)
    fireEvent.focus(install)
    fireEvent.mouseOver(screen.getByRole('button', { name: 'Выбрать вариант a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать вариант a' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.getByText('fixture:a')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Проверить точную установку' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText(/Точная цель отсутствовала в sample \/api\/tags/u)).toBeTruthy()
    expect(screen.getByText(/Строка каталога наблюдалась/u)).toBeTruthy()
    expect(screen.getByText(/Источник получен/u)).toBeTruthy()
  })

  it('shows exact claimed facts, distinct fit and disables malformed or unknown-size evidence safely', () => {
    const invalid = render(<CatalogVariantInstall model={catalog({ invalidB: true })} />)
    expect((screen.getByRole('button', { name: /b: некорректный вариант/u }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать вариант a' }))
    expect(screen.getByText('fixture:a')).toBeTruthy()
    expect(screen.getByText(/Влезает по оценке заявленного размера/u)).toBeTruthy()
    expect(screen.getByText(/Датированный встроенный snapshot/u)).toBeTruthy()

    invalid.unmount()
    const view = render(<CatalogVariantInstall model={catalog({ unknownB: true })} />)
    fireEvent.click(view.getByRole('button', { name: 'Выбрать вариант b' }))
    expect(view.getByText('Fit неизвестен: у варианта нет заявленного размера.')).toBeTruthy()
    expect(view.container.innerHTML).not.toContain('color-fit-green')
  })

  it('updates exact facts from A to B before start and exposes stale provenance', () => {
    const model = catalog()
    model.variants[1]!.source = 'local_cache'
    model.variants[1]!.freshness = 'stale'
    model.variants[1]!.sourceFetchedAt = '2026-07-30T08:00:00.000Z'
    const view = render(<CatalogVariantInstall model={model} />)

    fireEvent.click(view.getByRole('button', { name: 'Выбрать вариант a' }))
    expect(view.getByText('fixture:a')).toBeTruthy()
    expect(view.getByText(/Влезает по оценке заявленного размера/u)).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: 'Выбрать вариант b' }))
    expect(view.queryByText('fixture:a')).toBeNull()
    expect(view.getByText('fixture:b')).toBeTruthy()
    expect(view.getByText(/Не влезает по текущей оценке/u)).toBeTruthy()
    expect(factPairs(view.container)).toEqual(expect.arrayContaining([['Источник', 'Локальный cache рекомендаций'], ['Свежесть', 'устаревший sample']]))

    fireEvent.click(view.getByRole('button', { name: 'Проверить точную установку' }))
    expect(view.getAllByText('fixture:b')).toHaveLength(2)
  })

  it('marks only the exact installed tag and never inherits a family aggregate', () => {
    const view = render(<CatalogVariantInstall model={catalog({ installed: 'a' })} />)
    fireEvent.click(view.getByRole('button', { name: 'Выбрать вариант b' }))
    expect(view.queryByText(/Точный tag наблюдался установленным/u)).toBeNull()
    expect(view.getByRole('button', { name: 'Проверить точную установку' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Выбрать вариант a' }))
    expect(view.getByText(/Точный tag наблюдался установленным/u)).toBeTruthy()
    expect(view.getByText('sha256:a')).toBeTruthy()
  })

  it('snapshots selected A, dispatches it once on double activation, never B/base, and refreshes exact digest', async () => {
    const requests: Array<{ url: string; body: unknown }> = []
    const onInstalled = vi.fn()
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
      const url = String(input)
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (url.endsWith('/start')) return sse(
        { type: 'progress', seq: 0, data: {
          status: 'downloading', digest: 'sha256:layer', totalBytes: 100,
          completedBytes: 50, percent: 50, bytesPerSecond: 10, etaSeconds: 5,
        } },
        { type: 'done', seq: 1, data: { name: 'fixture:a' } },
      )
      if (url === '/api/models') return json({ models: [installed('fixture:a', 'sha256:exact-a')] })
      throw new Error(url)
    })
    vi.stubGlobal('fetch', fetch)
    render(<CatalogVariantInstall model={catalog()} onInstalled={onInstalled} />)
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать вариант a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Проверить точную установку' }))
    const confirm = screen.getByRole('button', { name: /Подтвердить точную цель/u })
    await waitFor(() => expect(document.activeElement).toBe(confirm))
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(await screen.findByText('sha256:exact-a')).toBeTruthy()
    expect(screen.getByText(/Наблюдение \/api\/tags/u)).toBeTruthy()
    expect(requests.filter((entry) => entry.url.endsWith('/start'))).toEqual([{
      url: '/api/models/imports/ollama-reference/start',
      body: { reference: 'fixture:a', confirmedModelName: 'fixture:a' },
    }])
    expect(JSON.stringify(requests)).not.toContain('fixture:b')
    expect(JSON.stringify(requests)).not.toContain('"reference":"fixture"')
    expect(requests.some((entry) => /probe|prewarm|warm|catalog/u.test(entry.url))).toBe(false)
    expect(onInstalled).toHaveBeenCalledWith('fixture:a')
  })

  it('keeps the active target locked when the selected variant changes upstream', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller } })
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/start')) return new Response(stream, {
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      })
      if (url === '/api/models') return json({ models: [installed('fixture:a')] })
      throw new Error(url)
    })
    vi.stubGlobal('fetch', fetch)
    const view = render(<CatalogVariantInstall model={catalog()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать вариант a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Проверить точную установку' }))
    fireEvent.click(screen.getByRole('button', { name: /Подтвердить точную цель/u }))
    view.rerender(<CatalogVariantInstall model={catalog({ installed: 'b' })} />)
    const lockedB = view.container.querySelector<HTMLButtonElement>('[aria-label="Выбрать вариант b"]')
    expect(lockedB?.disabled).toBe(true)
    expect(screen.getAllByText('fixture:a')).toHaveLength(2)
    const encoder = new TextEncoder()
    streamController.enqueue(encoder.encode(
      `id: 0\nevent: guanxi\ndata: ${JSON.stringify({ type: 'done', seq: 0, data: { name: 'fixture:a' } })}\n\n`,
    ))
    streamController.close()
    expect(await screen.findByText(/Точная цель и digest присутствуют/u)).toBeTruthy()
  })

  it('renders ordered progress phases before exact terminal refresh', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller },
    })
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/start')) return new Response(stream, {
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      })
      if (url === '/api/models') return json({
        models: [installed('fixture:a', 'sha256:ordered-a')],
      })
      throw new Error(url)
    }))
    render(<CatalogVariantInstall model={catalog()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать вариант a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Проверить точную установку' }))
    fireEvent.click(screen.getByRole('button', { name: /Подтвердить точную цель/u }))

    const encoder = new TextEncoder()
    streamController.enqueue(encoder.encode(
      `id: 0\nevent: guanxi\ndata: ${JSON.stringify({ type: 'progress', seq: 0, data: {
        status: 'pulling manifest', digest: null, totalBytes: null,
        completedBytes: null, percent: null, bytesPerSecond: null, etaSeconds: null,
      } })}\n\n`,
    ))
    expect(await screen.findByText('Ollama получает manifest точной цели.')).toBeTruthy()

    streamController.enqueue(encoder.encode(
      `id: 1\nevent: guanxi\ndata: ${JSON.stringify({ type: 'progress', seq: 1, data: {
        status: 'downloading', digest: 'sha256:layer', totalBytes: 100,
        completedBytes: 60, percent: 60, bytesPerSecond: 10, etaSeconds: 4,
      } })}\n\n`,
    ))
    expect(await screen.findByText('Ollama скачивает выбранный вариант.')).toBeTruthy()
    expect(screen.getByText(/60%/u)).toBeTruthy()

    streamController.enqueue(encoder.encode(
      `id: 2\nevent: guanxi\ndata: ${JSON.stringify({
        type: 'done', seq: 2, data: { name: 'fixture:a' },
      })}\n\n`,
    ))
    streamController.close()
    expect(await screen.findByText('sha256:ordered-a')).toBeTruthy()
  })

  it('distinguishes missing target, refresh failure, provider/protocol error, cancel and explicit retry', async () => {
    let attempt = 0
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/start')) {
        attempt += 1
        if (attempt === 1) return sse({ type: 'error', seq: 0, data: {
          code: 'upstream_error', message: 'redacted', details: null,
        } })
        if (attempt === 2) return sse({ type: 'done', seq: 0, data: { name: 'fixture:a' } })
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
        })
      }
      if (url === '/api/models') return json({ models: [installed('fixture:b')] })
      throw new Error(url)
    })
    vi.stubGlobal('fetch', fetch)
    const first = render(<CatalogVariantInstall model={catalog()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать вариант a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Проверить точную установку' }))
    fireEvent.click(screen.getByRole('button', { name: /Подтвердить точную цель/u }))
    expect(await screen.findByText('Pull варианта завершился ошибкой')).toBeTruthy()
    expect(screen.queryAllByRole('button', { name: /Повторить/u })).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Скачать точный tag' }))
    expect(await screen.findByText(/Installation остаётся неподтверждённой/u)).toBeTruthy()
    first.unmount()

    const second = render(<CatalogVariantInstall model={catalog()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать вариант a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Проверить точную установку' }))
    fireEvent.click(screen.getByRole('button', { name: /Подтвердить точную цель/u }))
    const cancel = await screen.findByRole('button', { name: 'Отменить pull этого варианта' })
    fireEvent.click(cancel)
    expect(await screen.findByText('Pull варианта отменён')).toBeTruthy()
    second.unmount()

    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      if (String(input).endsWith('/start')) return sse({ type: 'done', seq: 0, data: { name: 'fixture:a' } })
      throw new Error('refresh failed')
    }))
    render(<CatalogVariantInstall model={catalog()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать вариант a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Проверить точную установку' }))
    fireEvent.click(screen.getByRole('button', { name: /Подтвердить точную цель/u }))
    expect(await screen.findByText(/Installed не удалось/u)).toBeTruthy()
    expect(screen.queryByText(/sha256/u)).toBeNull()
  })

  it('distinguishes EOF protocol failure from transport failure without retry', async () => {
    const eofFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(sse())
    vi.stubGlobal('fetch', eofFetch)
    const eof = render(<CatalogVariantInstall model={catalog()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать вариант a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Проверить точную установку' }))
    fireEvent.click(screen.getByRole('button', { name: /Подтвердить точную цель/u }))
    expect(await screen.findByText(/не сообщила terminal success/u)).toBeTruthy()
    expect(eofFetch).toHaveBeenCalledTimes(1)
    eof.unmount()

    const transportFetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(
      new TypeError('fixture transport failure'),
    )
    vi.stubGlobal('fetch', transportFetch)
    render(<CatalogVariantInstall model={catalog()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать вариант a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Проверить точную установку' }))
    fireEvent.click(screen.getByRole('button', { name: /Подтвердить точную цель/u }))
    expect(await screen.findByText(/Соединение точного pull завершилось/u)).toBeTruthy()
    expect(transportFetch).toHaveBeenCalledTimes(1)
  })

  it('aborts on StrictMode unmount without late refresh and uses English fallback', async () => {
    setActiveLocale('en')
    let signal: AbortSignal | null = null
    const onInstalled = vi.fn()
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
      if (String(input).endsWith('/start')) {
        signal = init?.signal ?? null
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('unmount', 'AbortError')), { once: true })
        })
      }
      throw new Error(String(input))
    })
    vi.stubGlobal('fetch', fetch)
    const view = render(
      <StrictMode><CatalogVariantInstall model={catalog()} onInstalled={onInstalled} /></StrictMode>,
    )
    expect(screen.getByText('Select one exact variant before installation.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Select variant a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review exact install' }))
    fireEvent.click(screen.getByRole('button', { name: /Confirm the selected exact catalog target/u }))
    await waitFor(() => expect(signal).not.toBeNull())
    view.unmount()
    await waitFor(() => expect(signal?.aborted).toBe(true))
    expect(fetch.mock.calls.filter(([input]) => String(input) === '/api/models')).toHaveLength(0)
    expect(onInstalled).not.toHaveBeenCalled()
  })
})
