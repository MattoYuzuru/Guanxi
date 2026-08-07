import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HuggingFaceDiscovery } from '../../src/features/models/HuggingFaceDiscovery.tsx'

const originalFetch = globalThis.fetch
const OBSERVED_AT = '2026-08-07T12:00:00.000Z'
const SHA = 'a'.repeat(40)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function repository(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    provider: 'hugging_face',
    identity: {
      provider: 'hugging_face',
      owner: 'TheBloke',
      name: 'Llama-2-7B-GGUF',
      repositoryId: 'TheBloke/Llama-2-7B-GGUF',
      comparisonKey: 'thebloke/llama-2-7b-gguf',
    },
    metadata: 'resolved',
    observedAt: OBSERVED_AT,
    revision: { state: 'exact_commit', commit: SHA, source: 'hugging_face_api_model' },
    gated: { state: 'open', mode: null },
    license: {
      state: 'declared', value: 'apache-2.0',
      source: 'hugging_face_model_tags', confidence: 'declared',
    },
    files: {
      state: 'listed', source: 'hugging_face_api_model', totalFiles: 2,
      malformedEntries: 0, truncated: false,
      ggufFiles: [{
        path: 'llama-2-7b.Q4_K_M.gguf', sizeBytes: 4_000,
        sizeSource: 'hugging_face_api_model',
      }],
    },
    verdict: {
      state: 'supported', scope: 'exact_gguf_file_only',
      basis: 'exact_gguf_files_listed', reason: null,
      requiresExactFileSelection: true,
    },
    ...overrides,
  }
}

function listed(repositories: unknown[] = [repository()], nextCursor: string | null = null) {
  return {
    result: {
      state: 'listed', version: 1, page: 1, pageSize: 10,
      source: {
        state: 'available', source: 'hugging_face_public_api',
        observedAt: OBSERVED_AT, reason: null,
      },
      droppedRows: 0, repositories, nextCursor, reason: null,
    },
  }
}

function failed(reason: string) {
  return {
    result: {
      state: 'failed', version: 1, page: 1, pageSize: 10,
      source: {
        state: 'unavailable', source: 'hugging_face_public_api',
        observedAt: OBSERVED_AT, reason,
      },
      droppedRows: 0, repositories: [], nextCursor: null, reason,
    },
  }
}

function submitSearch(value = 'llama gguf') {
  const input = screen.getByRole('searchbox')
  fireEvent.change(input, { target: { value } })
  fireEvent.submit(input.closest('form')!)
  return input
}

afterEach(() => {
  vi.stubGlobal('fetch', originalFetch)
  document.documentElement.lang = 'ru'
})

describe('Marketplace Hugging Face discovery section', () => {
  it('issues no request on mount, hover, focus, typing or unmount', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(listed()))
    vi.stubGlobal('fetch', fetch)
    const view = render(<HuggingFaceDiscovery />)

    expect(fetch).not.toHaveBeenCalled()
    const input = screen.getByRole('searchbox')
    fireEvent.mouseOver(input)
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'llama' } })
    fireEvent.blur(input)
    fireEvent.mouseOver(screen.getByRole('button', { name: /Выполнить поиск/u }))
    // Typing and hovering are not an intent: nothing may be requested yet.
    expect(fetch).not.toHaveBeenCalled()

    view.unmount()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('requests exactly once per explicit submit and treats a double submit as one intent', async () => {
    let resolve: ((response: Response) => void) | undefined
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      () => new Promise<Response>((r) => { resolve = r }),
    )
    vi.stubGlobal('fetch', fetch)
    render(<HuggingFaceDiscovery />)

    const input = submitSearch()
    fireEvent.submit(input.closest('form')!)
    fireEvent.submit(input.closest('form')!)
    expect(fetch).toHaveBeenCalledTimes(1)

    expect(fetch.mock.calls[0]?.[0]).toBe('/api/models/discovery/hugging-face/search')
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('POST')
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      query: 'llama gguf', page: 1, pageSize: 10, cursor: null,
    })

    resolve?.(json(listed()))
    expect(await screen.findByText('TheBloke/Llama-2-7B-GGUF')).toBeTruthy()
  })

  it('never issues a cross-origin request to the provider', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(listed()))
    vi.stubGlobal('fetch', fetch)
    render(<HuggingFaceDiscovery />)
    submitSearch()
    await screen.findByText('TheBloke/Llama-2-7B-GGUF')

    for (const call of fetch.mock.calls) {
      const url = String(call[0])
      expect(url.startsWith('/api/')).toBe(true)
      expect(url).not.toContain('huggingface.co')
    }
  })

  it('ignores a late response from a superseded search', async () => {
    const resolvers: Array<(response: Response) => void> = []
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      () => new Promise<Response>((resolve) => { resolvers.push(resolve) }),
    )
    vi.stubGlobal('fetch', fetch)
    render(<HuggingFaceDiscovery />)

    // Both searches are started before either response arrives, so the first
    // response is genuinely late rather than merely replayed.
    const input = submitSearch('first')
    expect(fetch).toHaveBeenCalledTimes(1)
    fireEvent.change(input, { target: { value: 'second' } })
    fireEvent.submit(input.closest('form')!)
    expect(fetch).toHaveBeenCalledTimes(2)

    resolvers[1]?.(json(listed()))
    expect(await screen.findByText('TheBloke/Llama-2-7B-GGUF')).toBeTruthy()

    // The superseded first response now lands. It must be discarded, not rendered.
    resolvers[0]?.(json(listed([repository({
      identity: {
        provider: 'hugging_face', owner: 'stale', name: 'result',
        repositoryId: 'stale/result', comparisonKey: 'stale/result',
      },
    })])))
    await Promise.resolve()
    await waitFor(() => {
      expect(screen.getByText('TheBloke/Llama-2-7B-GGUF')).toBeTruthy()
    })
    expect(screen.queryByText('stale/result')).toBeNull()
  })

  it('offers no Install or Pull control and states the remaining requirement', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(listed())))
    render(<HuggingFaceDiscovery />)
    submitSearch()
    await screen.findByText('TheBloke/Llama-2-7B-GGUF')

    for (const name of [/Установить/u, /Install/u, /Pull/u, /Скачать/u, /Download/u]) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    // The user is told what is still required instead of being promised one click.
    expect(screen.getByText(/нужно выбрать точный файл GGUF/u)).toBeTruthy()
    expect(screen.getByText(/не обещает установку в один клик/u)).toBeTruthy()
  })

  it('distinguishes supported, unsupported and unknown verdicts truthfully', async () => {
    // `supported` is the only state allowed to render the supported badge.
    const cases: Array<[Record<string, unknown>, RegExp, RegExp, boolean]> = [
      [
        {},
        /Содержит файлы GGUF/u,
        /Точные файлы GGUF перечислены/u,
        true,
      ],
      [
        {
          files: {
            state: 'listed', source: 'hugging_face_api_model', totalFiles: 1,
            malformedEntries: 0, truncated: false, ggufFiles: [],
          },
          verdict: {
            state: 'unsupported', scope: 'exact_gguf_file_only',
            basis: 'complete_listing_without_gguf', reason: null,
            requiresExactFileSelection: true,
          },
        },
        /Вне GGUF-only scope/u,
        // `unsupported` must explain scope, never call the model broken.
        /не значит, что модель сломана/u,
        false,
      ],
      [
        {
          files: {
            state: 'listed', source: 'hugging_face_api_model', totalFiles: 600,
            malformedEntries: 0, truncated: true, ggufFiles: [],
          },
          verdict: {
            state: 'unknown', scope: 'exact_gguf_file_only',
            basis: 'insufficient_evidence', reason: 'file_listing_truncated',
            requiresExactFileSelection: true,
          },
        },
        /Доказательств недостаточно/u,
        /Перечень файлов превысил ограниченную страницу/u,
        false,
      ],
      [
        {
          metadata: 'unavailable',
          revision: { state: 'unknown', commit: null, source: 'not_reported' },
          gated: { state: 'unknown', mode: null },
          license: {
            state: 'unknown', value: null,
            source: 'metadata_unavailable', confidence: 'unknown',
          },
          files: {
            state: 'unknown', source: 'metadata_unavailable', totalFiles: null,
            malformedEntries: null, truncated: null, ggufFiles: [],
          },
          verdict: {
            state: 'unknown', scope: 'exact_gguf_file_only',
            basis: 'insufficient_evidence', reason: 'metadata_unavailable',
            requiresExactFileSelection: true,
          },
        },
        /Доказательств недостаточно/u,
        /Metadata репозитория прочитать не удалось/u,
        false,
      ],
    ]

    for (const [overrides, badge, detail, isSupported] of cases) {
      const view = render(<HuggingFaceDiscovery />)
      vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>()
        .mockResolvedValue(json(listed([repository(overrides)]))))
      submitSearch()
      expect(await screen.findByText(badge)).toBeTruthy()
      expect(screen.getByText(detail)).toBeTruthy()
      // Only a genuinely supported repository may show the supported badge.
      if (isSupported) {
        expect(screen.getByText(/Содержит файлы GGUF/u)).toBeTruthy()
      } else {
        expect(screen.queryByText(/Содержит файлы GGUF/u)).toBeNull()
      }
      view.unmount()
    }
  })

  it('shows gated and license state without letting them change the verdict', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json(listed([repository({
        gated: { state: 'gated', mode: 'manual' },
        license: {
          state: 'unknown', value: null,
          source: 'conflicting_declarations', confidence: 'unknown',
        },
      })])),
    ))
    render(<HuggingFaceDiscovery />)
    submitSearch()

    expect(await screen.findByText(/Gated — ручное одобрение/u)).toBeTruthy()
    expect(screen.getByText(/Противоречивые заявления/u)).toBeTruthy()
    expect(screen.getByText(/не запрашивает token/u)).toBeTruthy()
    // The GGUF evidence is unchanged, so the verdict stays supported.
    expect(screen.getByText(/Содержит файлы GGUF/u)).toBeTruthy()
  })

  it('renders each transport failure distinguishably with a retry', async () => {
    const reasons: Array<[string, RegExp]> = [
      ['rate_limited', /ограничивает частоту запросов/u],
      ['provider_unavailable', /Провайдер недоступен/u],
      ['connect_timeout', /не принял соединение/u],
      ['response_timeout', /перестал присылать ответ/u],
      ['response_too_large', /превысил размер/u],
      ['provider_malformed', /не смогло разобрать/u],
      ['not_found', /Публично доступного репозитория не нашлось/u],
    ]
    for (const [reason, message] of reasons) {
      const view = render(<HuggingFaceDiscovery />)
      vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>()
        .mockResolvedValue(json(failed(reason))))
      submitSearch()
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toMatch(message)
      expect(screen.getByRole('button', { name: /Повторить/u })).toBeTruthy()
      view.unmount()
    }
  })

  it('retries through the same explicit intent after a failure', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(failed('rate_limited')))
      .mockResolvedValueOnce(json(listed()))
    vi.stubGlobal('fetch', fetch)
    render(<HuggingFaceDiscovery />)
    submitSearch()
    await screen.findByRole('alert')

    fireEvent.click(screen.getByRole('button', { name: /Повторить/u }))
    expect(await screen.findByText('TheBloke/Llama-2-7B-GGUF')).toBeTruthy()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).page).toBe(1)
  })

  it('separates empty results from a failure', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      result: {
        state: 'empty', version: 1, page: 1, pageSize: 10,
        source: {
          state: 'available', source: 'hugging_face_public_api',
          observedAt: OBSERVED_AT, reason: null,
        },
        droppedRows: 0, repositories: [], nextCursor: null, reason: null,
      },
    })))
    render(<HuggingFaceDiscovery />)
    submitSearch()
    expect(await screen.findByText(/Подходящих репозиториев нет/u)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports an offline failure as a connectivity problem, not a provider verdict', async () => {
    const online = Object.getOwnPropertyDescriptor(navigator, 'onLine')
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    try {
      vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>()
        .mockRejectedValue(new TypeError('Failed to fetch')))
      render(<HuggingFaceDiscovery />)
      submitSearch()
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toMatch(/компьютер офлайн/u)
    } finally {
      if (online) Object.defineProperty(navigator, 'onLine', online)
    }
  })

  it('discloses a shrunken page instead of presenting it as fewer results', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      ...listed(),
      result: { ...listed().result, droppedRows: 3 },
    })))
    render(<HuggingFaceDiscovery />)
    submitSearch()
    expect(await screen.findByText(/это не «нашлось меньше»/u)).toBeTruthy()
  })

  it('loads a further bounded page only through an explicit action and one request', async () => {
    const second = repository({
      identity: {
        provider: 'hugging_face', owner: 'Second', name: 'Repo-GGUF',
        repositoryId: 'Second/Repo-GGUF', comparisonKey: 'second/repo-gguf',
      },
    })
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(listed([repository()], 'CURSOR-2')))
      .mockResolvedValueOnce(json({
        result: { ...listed([second]).result, page: 2 },
      }))
    vi.stubGlobal('fetch', fetch)
    render(<HuggingFaceDiscovery />)
    submitSearch()
    await screen.findByText('TheBloke/Llama-2-7B-GGUF')

    const more = screen.getByRole('button', { name: /Загрузить следующую страницу/u })
    fireEvent.click(more)
    fireEvent.click(more)
    expect(fetch).toHaveBeenCalledTimes(2)
    // The opaque cursor is echoed back verbatim with the next ordinal page.
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      query: 'llama gguf', page: 2, pageSize: 10, cursor: 'CURSOR-2',
    })
    expect(await screen.findByText('Second/Repo-GGUF')).toBeTruthy()
    expect(screen.getByText('TheBloke/Llama-2-7B-GGUF')).toBeTruthy()
  })

  it('offers no further page when the bounded walk is finished', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>()
      .mockResolvedValue(json(listed([repository()], null))))
    render(<HuggingFaceDiscovery />)
    submitSearch()
    await screen.findByText('TheBloke/Llama-2-7B-GGUF')
    expect(screen.queryByRole('button', { name: /Загрузить следующую/u })).toBeNull()
  })

  it('uses curated English as the source language fallback', async () => {
    document.documentElement.lang = 'en'
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>()
      .mockResolvedValue(json(failed('rate_limited'))))
    render(<HuggingFaceDiscovery />)
    const input = screen.getByRole('searchbox', {
      name: 'Search Hugging Face repositories',
    })
    fireEvent.change(input, { target: { value: 'llama' } })
    fireEvent.submit(input.closest('form')!)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/rate-limiting requests/u)
    expect(screen.getByText(/A separate source from the catalog above/u)).toBeTruthy()
  })

  it('labels the search control and exposes a polite status region', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(listed())))
    render(<HuggingFaceDiscovery />)
    const input = screen.getByRole('searchbox', { name: 'Поиск репозиториев Hugging Face' })
    // The label and the hint are programmatically associated, not merely adjacent.
    expect(input.getAttribute('aria-describedby')).toBe('hf-search-hint')
    expect(document.getElementById('hf-search-hint')?.textContent)
      .toMatch(/До явной отправки запрос не уходит/u)

    const status = document.querySelector('[role="status"][aria-live="polite"]')
    expect(status).toBeTruthy()

    const section = document.querySelector('section[aria-labelledby="hf-discovery-heading"]')
    expect(section).toBeTruthy()
    expect(document.getElementById('hf-discovery-heading')?.textContent).toBe('Hugging Face')
  })

  it('keeps the GGUF file list behind a keyboard-operable disclosure', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(listed())))
    render(<HuggingFaceDiscovery />)
    submitSearch()
    await screen.findByText('TheBloke/Llama-2-7B-GGUF')

    const toggle = screen.getByRole('button', { name: /Файлы GGUF/u })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('llama-2-7b.Q4_K_M.gguf')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('llama-2-7b.Q4_K_M.gguf')).toBeTruthy()
  })

  it('shows the exact case-sensitive Hub path and not the folded comparison key', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(listed())))
    render(<HuggingFaceDiscovery />)
    submitSearch()
    expect(await screen.findByText('TheBloke/Llama-2-7B-GGUF')).toBeTruthy()
    expect(screen.queryByText('thebloke/llama-2-7b-gguf')).toBeNull()
  })

  it('states the read-only boundary of the whole section', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(listed())))
    render(<HuggingFaceDiscovery />)
    expect(screen.getByText(/Discovery только читает/u)).toBeTruthy()
    expect(screen.getByText(/Отдельный источник, не каталог выше/u)).toBeTruthy()
  })
})
