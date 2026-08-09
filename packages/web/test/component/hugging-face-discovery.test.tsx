import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HuggingFaceRepository } from '@alamo/contract'
import {
  HuggingFaceDiscovery,
  RepositoryCard,
} from '../../src/features/models/HuggingFaceDiscovery.tsx'

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
    const view = render(<HuggingFaceDiscovery contextLength={8_192} />)

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
    render(<HuggingFaceDiscovery contextLength={8_192} />)

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
    render(<HuggingFaceDiscovery contextLength={8_192} />)
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
    render(<HuggingFaceDiscovery contextLength={8_192} />)

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
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    submitSearch()
    await screen.findByText('TheBloke/Llama-2-7B-GGUF')

    for (const name of [/Установить/u, /Install/u, /Pull/u, /Скачать/u, /Download/u]) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    // The user is told what is still required instead of being promised one click.
    expect(screen.getByText(/явное bounded-скачивание может проверить staging artifact/u)).toBeTruthy()
    expect(screen.getByText(/Локальный импорт в Ollama пока недоступен/u)).toBeTruthy()
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
      const view = render(<HuggingFaceDiscovery contextLength={8_192} />)
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
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    submitSearch()

    expect(await screen.findByText(/Gated — ручное одобрение/u)).toBeTruthy()
    expect(screen.getByText(/Противоречивые заявления/u)).toBeTruthy()
    expect(screen.getByText(/token не запрашивается и доступ не открывается/u))
      .toBeTruthy()
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
      const view = render(<HuggingFaceDiscovery contextLength={8_192} />)
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
    render(<HuggingFaceDiscovery contextLength={8_192} />)
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
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    submitSearch()
    expect(await screen.findAllByText(/Подходящих репозиториев нет/u))
      .toHaveLength(2)
    expect(screen.getByText(/пригодных репозиториев по этому запросу не вернул/u))
      .toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports an offline failure as a connectivity problem, not a provider verdict', async () => {
    const online = Object.getOwnPropertyDescriptor(navigator, 'onLine')
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    try {
      vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>()
        .mockRejectedValue(new TypeError('Failed to fetch')))
      render(<HuggingFaceDiscovery contextLength={8_192} />)
      submitSearch()
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toMatch(/компьютер офлайн/u)
    } finally {
      if (online) Object.defineProperty(navigator, 'onLine', online)
      else delete (navigator as Navigator & { onLine?: boolean }).onLine
    }
  })

  it('discloses a shrunken page instead of presenting it as fewer results', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      ...listed(),
      result: { ...listed().result, droppedRows: 3 },
    })))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
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
    render(<HuggingFaceDiscovery contextLength={8_192} />)
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
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    submitSearch()
    await screen.findByText('TheBloke/Llama-2-7B-GGUF')
    expect(screen.queryByRole('button', { name: /Загрузить следующую/u })).toBeNull()
  })

  it('uses curated English as the source language fallback', async () => {
    document.documentElement.lang = 'en'
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>()
      .mockResolvedValue(json(failed('rate_limited'))))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
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
    render(<HuggingFaceDiscovery contextLength={8_192} />)
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

  it('opens the selectable GGUF file list by default and keeps it keyboard-operable', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(listed())))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    submitSearch()
    await screen.findByText('TheBloke/Llama-2-7B-GGUF')

    // A `supported` repository can be selected from immediately, so its file list
    // (and Select controls) start open rather than requiring an extra click.
    const toggle = screen.getByRole('button', { name: /Файлы GGUF/u })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('llama-2-7b.Q4_K_M.gguf')).toBeTruthy()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('llama-2-7b.Q4_K_M.gguf')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('llama-2-7b.Q4_K_M.gguf')).toBeTruthy()
  })

  it('keeps an unsupported repository’s file list disclosure closed by default', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(listed([
      repository({
        files: {
          state: 'listed', source: 'hugging_face_api_model', totalFiles: 1,
          malformedEntries: 0, truncated: false, ggufFiles: [],
        },
        verdict: {
          state: 'unsupported', scope: 'exact_gguf_file_only',
          basis: 'complete_listing_without_gguf', reason: null, requiresExactFileSelection: true,
        },
      }),
    ]))))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    submitSearch()
    await screen.findByText('TheBloke/Llama-2-7B-GGUF')

    const toggle = screen.getByRole('button', { name: /Файлы GGUF/u })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('shows the exact case-sensitive Hub path and not the folded comparison key', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(listed())))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    submitSearch()
    expect(await screen.findByText('TheBloke/Llama-2-7B-GGUF')).toBeTruthy()
    expect(screen.queryByText('thebloke/llama-2-7b-gguf')).toBeNull()
  })

  it('keeps found rows when a further page fails and retries that exact page', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(listed([repository()], 'CURSOR-2')))
      .mockResolvedValueOnce(json(failed('rate_limited')))
      .mockResolvedValueOnce(json({
        result: {
          ...listed([repository({
            identity: {
              provider: 'hugging_face', owner: 'Second', name: 'Repo-GGUF',
              repositoryId: 'Second/Repo-GGUF', comparisonKey: 'second/repo-gguf',
            },
          })]).result,
          page: 2,
        },
      }))
    vi.stubGlobal('fetch', fetch)
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    submitSearch()
    await screen.findByText('TheBloke/Llama-2-7B-GGUF')

    fireEvent.click(screen.getByRole('button', { name: /Загрузить следующую страницу/u }))
    await screen.findByRole('alert')
    // A transient failure on page 2 must not destroy page 1.
    expect(screen.getByText('TheBloke/Llama-2-7B-GGUF')).toBeTruthy()
    expect(screen.queryByText(/Подходящих репозиториев нет/u)).toBeNull()

    // Retry repeats the failed page and cursor, not a fresh page-1 search.
    fireEvent.click(screen.getByRole('button', { name: /Повторить/u }))
    expect(await screen.findByText('Second/Repo-GGUF')).toBeTruthy()
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({
      query: 'llama gguf', page: 2, pageSize: 10, cursor: 'CURSOR-2',
    })
    expect(screen.getByText('TheBloke/Llama-2-7B-GGUF')).toBeTruthy()
  })

  it('keeps found rows when a further page comes back empty and stops the walk', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(listed([repository()], 'CURSOR-2')))
      .mockResolvedValueOnce(json({
        result: {
          state: 'empty', version: 1, page: 2, pageSize: 10,
          source: {
            state: 'available', source: 'hugging_face_public_api',
            observedAt: OBSERVED_AT, reason: null,
          },
          droppedRows: 0, repositories: [], nextCursor: null, reason: null,
        },
      }))
    vi.stubGlobal('fetch', fetch)
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    submitSearch()
    await screen.findByText('TheBloke/Llama-2-7B-GGUF')

    fireEvent.click(screen.getByRole('button', { name: /Загрузить следующую страницу/u }))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Загрузить следующую/u })).toBeNull()
    })
    // The end of the walk is not "nothing matched".
    expect(screen.getByText('TheBloke/Llama-2-7B-GGUF')).toBeTruthy()
    expect(screen.queryByText(/Подходящих репозиториев нет/u)).toBeNull()
  })

  it('discloses refused rows even when every row on the page was refused', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      result: {
        state: 'empty', version: 1, page: 1, pageSize: 10,
        source: {
          state: 'available', source: 'hugging_face_public_api',
          observedAt: OBSERVED_AT, reason: null,
        },
        droppedRows: 9, repositories: [], nextCursor: null, reason: null,
      },
    })))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    submitSearch()
    // Nine unreadable repositories must not be reported as "nothing matched".
    expect(await screen.findByText(/это не «нашлось меньше»/u)).toBeTruthy()
  })

  it('announces a terminal state instead of falling silent', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      result: {
        state: 'empty', version: 1, page: 1, pageSize: 10,
        source: {
          state: 'available', source: 'hugging_face_public_api',
          observedAt: OBSERVED_AT, reason: null,
        },
        droppedRows: 0, repositories: [], nextCursor: null, reason: null,
      },
    }))
    vi.stubGlobal('fetch', fetch)
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    const live = document.querySelector('[role="status"][aria-live="polite"]')!
    expect(live.textContent).toBe('')
    submitSearch()
    await waitFor(() => {
      // "No results" must be announced, not represented by returning to silence.
      expect(live.textContent).not.toBe('')
    })
    expect(live.textContent).toMatch(/Подходящих репозиториев нет/u)
  })

  it('announces the failure title together with the reason', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>()
      .mockResolvedValue(json(failed('rate_limited'))))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    submitSearch()
    const alert = await screen.findByRole('alert')
    // The alert carries the framing and the retry, not just a bare sentence.
    expect(alert.textContent).toMatch(/Не удалось прочитать Hugging Face/u)
    expect(alert.textContent).toMatch(/ограничивает частоту запросов/u)
    expect(alert.querySelector('button')).toBeTruthy()
  })

  it('distinguishes unreadable metadata from an absent declaration', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json(listed([repository({
        revision: { state: 'unknown', commit: null, source: 'malformed' },
        license: {
          state: 'unknown', value: null, source: 'malformed', confidence: 'unknown',
        },
      })])),
    ))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    submitSearch()
    // "Unreadable" is a different fact from "not declared".
    expect(await screen.findByText(/Заявлена, но не читается/u)).toBeTruthy()
    expect(screen.getByText(/Сообщённый commit не читается/u)).toBeTruthy()
    expect(screen.queryByText('Не заявлена')).toBeNull()
  })

  it('shows the author-declared license caveat and a formatted observation time', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(listed())))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    submitSearch()
    await screen.findByText('TheBloke/Llama-2-7B-GGUF')
    expect(screen.getByText(/Заявление автора, а не юридическая проверка/u)).toBeTruthy()
    // A raw ISO timestamp is not a user-facing date.
    expect(screen.queryByText(new RegExp(OBSERVED_AT, 'u'))).toBeNull()
  })

  it('keeps internal release vocabulary out of user copy', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>()
      .mockResolvedValue(json(listed([repository({
        gated: { state: 'gated', mode: 'manual' },
      })], 'CURSOR-2'))))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    submitSearch()
    await screen.findByText('TheBloke/Llama-2-7B-GGUF')
    const text = document.body.textContent ?? ''
    for (const forbidden of ['срез', 'slice', '`ollama pull`']) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('states the read-only boundary of the whole section', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(listed())))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    expect(screen.getByText(/Поиск и выбор только читают/u)).toBeTruthy()
    expect(screen.getByText(/Отдельный источник, не каталог выше/u)).toBeTruthy()
  })
})

/* ──────────────────── P2-K exact GGUF file/revision selection ──────────────────── */

function confirmedSelectionResult(overrides: Record<string, unknown> = {}) {
  return {
    result: {
      state: 'confirmed',
      version: 1,
      repository: repository(),
      selection: {
        identity: repository().identity,
        revision: repository().revision,
        filePath: 'llama-2-7b.Q4_K_M.gguf',
        sizeBytes: 4_000,
        sizeSource: 'hugging_face_api_model',
      },
      fit: {
        state: 'calculated',
        contextLength: 8_192,
        basis: 'reported_file_size_only',
        calculatedAt: '2026-08-07T12:00:01.000Z',
        hardware: {
          source: 'application_startup_hardware_probe',
          observedAt: '2026-08-07T11:59:00.000Z',
          confidence: 'estimated',
        },
        verdict: {
          level: 'green', summary: 'fits', contextLength: 8_192,
          modelBytes: 4_000, kvCacheBytes: 0, requiredBytes: 4_000, usableBytes: 1_000_000,
          utilization: 0.004, basis: 'vendor_hint', measured: null,
        },
      },
      reason: null,
      ...overrides,
    },
  }
}

function unknownFitSelectionResult() {
  const unsizedRepository = repository({
    files: {
      state: 'listed', source: 'hugging_face_api_model', totalFiles: 2,
      malformedEntries: 0, truncated: false,
      ggufFiles: [{
        path: 'llama-2-7b.Q4_K_M.gguf', sizeBytes: null,
        sizeSource: 'not_reported',
      }],
    },
  })
  return confirmedSelectionResult({
    repository: unsizedRepository,
    selection: {
      identity: unsizedRepository.identity,
      revision: unsizedRepository.revision,
      filePath: 'llama-2-7b.Q4_K_M.gguf',
      sizeBytes: null,
      sizeSource: 'not_reported',
    },
    fit: {
      state: 'unknown',
      contextLength: 8_192,
      basis: 'size_not_reported',
      verdict: null,
      reason: 'size_not_reported',
    },
  })
}

function refusedSelectionResult(reason: string) {
  return { result: { state: 'refused', version: 1, repository: repository(), selection: null, fit: null, reason } }
}

function failedSelectionResult(reason: string) {
  return { result: { state: 'failed', version: 1, repository: null, selection: null, fit: null, reason } }
}

/** Routes a mocked fetch by path, so search and selection responses never collide. */
function routedFetch(handlers: {
  search?: (body: unknown) => unknown
  selection?: (body: unknown) => unknown
  download?: (body: unknown, signal: AbortSignal | null) => Response | Promise<Response>
}) {
  return vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : null
    if (url.includes('/discovery/hugging-face/search')) {
      return json((handlers.search ?? (() => listed()))(body))
    }
    if (url.includes('/discovery/hugging-face/selection')) {
      return json((handlers.selection ?? (() => confirmedSelectionResult()))(body))
    }
    if (url.includes('/discovery/hugging-face/download') && handlers.download) {
      return handlers.download(body, init?.signal ?? null)
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
}

async function searchAndOpenFileList() {
  submitSearch()
  await screen.findByText('TheBloke/Llama-2-7B-GGUF')
  return screen.getByRole('button', { name: /Выбрать этот файл/u })
}

describe('P2-K exact GGUF file/revision selection', () => {
  it('sends the exact published identity, immutable revision, file path and current context', async () => {
    let selectionBody: unknown = null
    vi.stubGlobal('fetch', routedFetch({ selection: (body) => {
      selectionBody = body
      return confirmedSelectionResult()
    } }))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    fireEvent.click(await searchAndOpenFileList())
    await screen.findByText('Выбранная цель')

    expect(selectionBody).toEqual({
      identity: repository().identity,
      revision: repository().revision,
      filePath: 'llama-2-7b.Q4_K_M.gguf',
      contextLength: 8_192,
    })
  })

  it('confirms an exact file selection and offers Download but no Install or Pull', async () => {
    vi.stubGlobal('fetch', routedFetch({}))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    const select = await searchAndOpenFileList()

    fireEvent.click(select)
    await waitFor(() => expect(screen.getByText('Выбранная цель')).toBeTruthy())
    const article = screen.getByText('TheBloke/Llama-2-7B-GGUF').closest('article')!
    expect(article.querySelector('[role="status"]')?.textContent)
      .toContain('Выбранная цель: llama-2-7b.Q4_K_M.gguf')
    // The path and size appear twice: once in the file list, once in the confirmed panel.
    expect(screen.getAllByText('llama-2-7b.Q4_K_M.gguf').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText(/4 КБ/u).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Можно явно начать скачивание')).toBeTruthy()
    expect(screen.getAllByText(/apache-2.0/u)).toHaveLength(2)
    expect(screen.getByText(/стартовая проверка железа приложением/u)).toBeTruthy()
    expect(screen.getByText(/оценочная уверенность/u)).toBeTruthy()

    expect(screen.getByRole('button', { name: 'Скачать точный GGUF' })).toBeTruthy()
    for (const name of [/Установить/u, /Install/u, /^Pull$/u]) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })

  it('shows an unknown fit with a reason instead of an optimistic estimate when size is not reported', async () => {
    vi.stubGlobal('fetch', routedFetch({ selection: () => unknownFitSelectionResult() }))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    const select = await searchAndOpenFileList()

    fireEvent.click(select)
    await waitFor(() => expect(
      screen.getByText(/Влезаемость неизвестна: размер файла не сообщён/u),
    ).toBeTruthy())
  })

  it('treats a double activation of Select as one intent', async () => {
    let resolveCount = 0
    let resolve: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/discovery/hugging-face/search')) return json(listed())
      resolveCount += 1
      return new Promise<Response>((r) => { resolve = r })
    }))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    const select = await searchAndOpenFileList()

    fireEvent.click(select)
    fireEvent.click(select)
    fireEvent.click(select)
    expect(resolveCount).toBe(1)
    resolve?.(json(confirmedSelectionResult()))
    await waitFor(() => expect(screen.getByText('Выбранная цель')).toBeTruthy())
  })

  it('recomputes fit when the context window changes, and discards a stale superseded re-check', async () => {
    const pending: Array<{ contextLength: number; resolve: (response: Response) => void }> = []
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes('/discovery/hugging-face/search')) return json(listed())
      const body = JSON.parse(String(init?.body)) as { contextLength: number }
      return new Promise<Response>((resolve) => {
        pending.push({ contextLength: body.contextLength, resolve })
      })
    }))
    const view = render(<HuggingFaceDiscovery contextLength={8_192} />)
    const select = await searchAndOpenFileList()

    fireEvent.click(select)
    await waitFor(() => expect(pending.length).toBe(1))
    expect(pending[0]?.contextLength).toBe(8_192)
    pending[0]?.resolve(json(confirmedSelectionResult()))
    await waitFor(() => expect(screen.getByText('Выбранная цель')).toBeTruthy())

    // Widening the context window re-checks the same confirmed file automatically.
    view.rerender(<HuggingFaceDiscovery contextLength={16_384} />)
    await waitFor(() => expect(pending.length).toBe(2))
    expect(pending[1]?.contextLength).toBe(16_384)

    // Before that re-check settles, the window changes again: this supersedes it.
    view.rerender(<HuggingFaceDiscovery contextLength={32_768} />)
    await waitFor(() => expect(pending.length).toBe(3))
    expect(pending[2]?.contextLength).toBe(32_768)

    // The stale 16_384 response resolves late: it must not be rendered as current.
    pending[1]?.resolve(json(confirmedSelectionResult({
      fit: {
        state: 'calculated', contextLength: 16_384, basis: 'reported_file_size_only',
        calculatedAt: '2026-08-07T12:00:02.000Z',
        hardware: {
          source: 'application_startup_hardware_probe',
          observedAt: '2026-08-07T11:59:00.000Z', confidence: 'estimated',
        },
        verdict: {
          level: 'red', summary: 'stale', contextLength: 16_384,
          modelBytes: 4_000, kvCacheBytes: 0, requiredBytes: 4_000, usableBytes: 1_000,
          utilization: 4, basis: 'vendor_hint', measured: null,
        },
      },
    })))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(screen.queryByText('stale')).toBeNull()

    // The latest 32_768 response resolves and is the one actually shown.
    pending[2]?.resolve(json(confirmedSelectionResult({
      fit: {
        state: 'calculated', contextLength: 32_768, basis: 'reported_file_size_only',
        calculatedAt: '2026-08-07T12:00:03.000Z',
        hardware: {
          source: 'application_startup_hardware_probe',
          observedAt: '2026-08-07T11:59:00.000Z', confidence: 'estimated',
        },
        verdict: {
          level: 'green', summary: 'current window', contextLength: 32_768,
          modelBytes: 4_000, kvCacheBytes: 0, requiredBytes: 4_000, usableBytes: 1_000_000,
          utilization: 0.004, basis: 'vendor_hint', measured: null,
        },
      },
    })))
    await waitFor(() => expect(screen.getByText(/выбранный контекст 32k/u)).toBeTruthy())
  })

  it('supersedes the initial pending selection when the context changes', async () => {
    const pending: Array<{
      contextLength: number
      signal: AbortSignal
      resolve: (response: Response) => void
    }> = []
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(
      async (input, init) => {
        const url = String(input)
        if (url.includes('/discovery/hugging-face/search')) return json(listed())
        const body = JSON.parse(String(init?.body)) as { contextLength: number }
        return new Promise<Response>((resolve) => {
          pending.push({ contextLength: body.contextLength, signal: init!.signal!, resolve })
        })
      },
    ))
    const view = render(<HuggingFaceDiscovery contextLength={8_192} />)
    fireEvent.click(await searchAndOpenFileList())
    await waitFor(() => expect(pending).toHaveLength(1))
    const article = screen.getByText('TheBloke/Llama-2-7B-GGUF').closest('article')!
    await waitFor(() => expect(
      article.querySelector('[role="status"]')?.textContent,
    ).toBe('Проверяем…'))

    view.rerender(<HuggingFaceDiscovery contextLength={32_768} />)
    await waitFor(() => expect(pending).toHaveLength(2))
    expect(pending.map((request) => request.contextLength)).toEqual([8_192, 32_768])
    expect(pending[0]?.signal.aborted).toBe(true)

    pending[1]?.resolve(json(confirmedSelectionResult({
      fit: {
        state: 'calculated', contextLength: 32_768,
        basis: 'reported_file_size_only',
        calculatedAt: '2026-08-07T12:00:03.000Z',
        hardware: {
          source: 'application_startup_hardware_probe',
          observedAt: '2026-08-07T11:59:00.000Z', confidence: 'estimated',
        },
        verdict: {
          level: 'green', summary: 'current', contextLength: 32_768,
          modelBytes: 4_000, kvCacheBytes: 0, requiredBytes: 4_000,
          usableBytes: 1_000_000, utilization: 0.004,
          basis: 'vendor_hint', measured: null,
        },
      },
    })))
    await waitFor(() => expect(screen.getByText(/выбранный контекст 32k/u)).toBeTruthy())
    expect(screen.queryByText(/выбранный контекст 8k/u)).toBeNull()

    pending[0]?.resolve(json(confirmedSelectionResult()))
    await Promise.resolve()
    expect(screen.getByText(/выбранный контекст 32k/u)).toBeTruthy()
  })

  it('shows a typed refusal with retry when a fresh re-check no longer confirms the target', async () => {
    let attempts = 0
    vi.stubGlobal('fetch', routedFetch({
      selection: () => {
        attempts += 1
        return attempts === 1
          ? refusedSelectionResult('file_not_in_current_inventory')
          : confirmedSelectionResult()
      },
    }))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    const select = await searchAndOpenFileList()

    fireEvent.click(select)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Повторная проверка больше не находит этот файл в перечне.')
    const article = screen.getByText('TheBloke/Llama-2-7B-GGUF').closest('article')!
    expect(article.querySelector('[role="status"]')?.textContent)
      .toContain('Повторная проверка больше не находит этот файл в перечне.')
    const retry = screen.getByRole('button', { name: 'Повторить' })
    expect(retry).toBeTruthy()
    fireEvent.click(retry)
    await screen.findByText('Выбранная цель')
    expect(article.querySelector('[role="status"]')?.textContent)
      .toContain('Выбранная цель: llama-2-7b.Q4_K_M.gguf')
  })

  it('shows a redacted transport failure without leaking provider detail', async () => {
    vi.stubGlobal('fetch', routedFetch({
      selection: () => failedSelectionResult('provider_unavailable'),
    }))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    const select = await searchAndOpenFileList()

    fireEvent.click(select)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Провайдер недоступен.')
    const article = screen.getByText('TheBloke/Llama-2-7B-GGUF').closest('article')!
    expect(article.querySelector('[role="status"]')?.textContent)
      .toContain('Провайдер недоступен.')
  })

  it('restores focus to the active control instead of stranding it on body', async () => {
    let resolve: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/discovery/hugging-face/search')) return json(listed())
      return new Promise<Response>((r) => { resolve = r })
    }))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    const select = await searchAndOpenFileList()

    select.focus()
    fireEvent.click(select)
    resolve?.(json(confirmedSelectionResult()))
    await waitFor(() => expect(screen.getByText('Выбранная цель')).toBeTruthy())
    await waitFor(() => expect(document.activeElement).not.toBe(document.body))

    const change = screen.getByRole('button', { name: 'Выбрать другой файл' })
    fireEvent.click(change)
    await waitFor(() => expect(document.activeElement).toBe(select))
  })

  it('shows the legal caveat when the fresh selection read newly declares a license', async () => {
    vi.stubGlobal('fetch', routedFetch({
      search: () => listed([repository({
        license: {
          state: 'unknown', value: null,
          source: 'not_reported', confidence: 'unknown',
        },
      })]),
    }))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    const select = await searchAndOpenFileList()
    expect(screen.queryByText(/Заявление автора, а не юридическая проверка/u)).toBeNull()

    fireEvent.click(select)
    await screen.findByText('Выбранная цель')
    expect(screen.getAllByText(/Заявление автора, а не юридическая проверка/u))
      .toHaveLength(1)
  })

  it('does not offer a file selection for an unsupported or unknown-verdict repository', async () => {
    vi.stubGlobal('fetch', routedFetch({
      search: () => listed([repository({
        files: {
          state: 'listed', source: 'hugging_face_api_model', totalFiles: 1,
          malformedEntries: 0, truncated: false, ggufFiles: [],
        },
        verdict: {
          state: 'unsupported', scope: 'exact_gguf_file_only',
          basis: 'complete_listing_without_gguf', reason: null, requiresExactFileSelection: true,
        },
      })]),
    }))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    submitSearch()
    await screen.findByText('TheBloke/Llama-2-7B-GGUF')
    expect(screen.queryByRole('button', { name: /Выбрать этот файл/u })).toBeNull()
  })

  it('does not offer selection from a truncated or malformed inventory', async () => {
    for (const files of [
      { truncated: true, malformedEntries: 0 },
      { truncated: false, malformedEntries: 1 },
    ]) {
      const view = render(<HuggingFaceDiscovery contextLength={8_192} />)
      vi.stubGlobal('fetch', routedFetch({
        search: () => listed([repository({
          files: {
            ...repository().files,
            ...files,
          },
        })]),
      }))
      submitSearch()
      await screen.findByText('TheBloke/Llama-2-7B-GGUF')
      expect(screen.queryByRole('button', { name: /Выбрать этот файл/u })).toBeNull()
      view.unmount()
    }
  })

  it('reopens the disclosure when newer same-key evidence becomes selectable', async () => {
    const unsupported = repository({
      files: {
        state: 'listed', source: 'hugging_face_api_model', totalFiles: 1,
        malformedEntries: 0, truncated: false, ggufFiles: [],
      },
      verdict: {
        state: 'unsupported', scope: 'exact_gguf_file_only',
        basis: 'complete_listing_without_gguf', reason: null,
        requiresExactFileSelection: true,
      },
    })
    const supported = repository({ observedAt: '2026-08-09T13:00:00.000Z' })
    const view = render(
      <RepositoryCard repository={unsupported as unknown as HuggingFaceRepository} contextLength={8_192} />,
    )
    expect(screen.getByRole('button', { name: /Файлы GGUF/u }).getAttribute('aria-expanded'))
      .toBe('false')

    view.rerender(
      <RepositoryCard repository={supported as unknown as HuggingFaceRepository} contextLength={8_192} />,
    )
    await waitFor(() => expect(
      screen.getByRole('button', { name: /Файлы GGUF/u }).getAttribute('aria-expanded'),
    ).toBe('true'))
    expect(screen.getByRole('button', { name: /Выбрать этот файл/u })).toBeTruthy()
  })

  it('clears an already confirmed target when newer same-key evidence arrives', async () => {
    let searchCount = 0
    vi.stubGlobal('fetch', routedFetch({ search: () => {
      searchCount += 1
      return listed([repository({
        observedAt: searchCount === 1
          ? OBSERVED_AT
          : '2026-08-09T13:00:00.000Z',
      })])
    } }))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    fireEvent.click(await searchAndOpenFileList())
    await screen.findByText('Выбранная цель')

    submitSearch('newer evidence')
    await waitFor(() => expect(screen.queryByText('Выбранная цель')).toBeNull())
    expect(screen.getByRole('button', { name: /Выбрать этот файл/u })).toBeTruthy()
  })

  it('discards an in-flight selection when a newer sample replaces the same repository key', async () => {
    let selectionSignal: AbortSignal | null = null
    let resolveSelection: ((response: Response) => void) | undefined
    let searchCount = 0
    const newer = repository({ observedAt: '2026-08-09T13:00:00.000Z' })
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(
      async (input, init) => {
        const url = String(input)
        if (url.includes('/discovery/hugging-face/search')) {
          searchCount += 1
          return json(listed([searchCount === 1 ? repository() : newer]))
        }
        selectionSignal = init?.signal ?? null
        return new Promise<Response>((resolve) => { resolveSelection = resolve })
      },
    ))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    const select = await searchAndOpenFileList()
    fireEvent.click(select)
    await waitFor(() => expect(selectionSignal).not.toBeNull())

    submitSearch('newer evidence')
    await waitFor(() => expect(selectionSignal?.aborted).toBe(true))
    resolveSelection?.(json(confirmedSelectionResult()))
    await Promise.resolve()
    expect(screen.queryByText('Выбранная цель')).toBeNull()
  })

  it('renders the complete selection preview from curated English locale keys', async () => {
    document.documentElement.lang = 'en'
    vi.stubGlobal('fetch', routedFetch({}))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    const input = screen.getByRole('searchbox', { name: 'Search Hugging Face repositories' })
    fireEvent.change(input, { target: { value: 'llama gguf' } })
    fireEvent.submit(input.closest('form')!)
    const select = await screen.findByRole('button', {
      name: /Select the file llama-2-7b\.Q4_K_M\.gguf/u,
    })
    fireEvent.click(select)
    await screen.findByText('Selected target')

    expect(screen.getByText(/reported by the Hugging Face file metadata API/u)).toBeTruthy()
    expect(screen.getByText(/not a measured or guaranteed fit/u)).toBeTruthy()
    expect(screen.getByText(/application startup hardware probe/u)).toBeTruthy()
    expect(screen.getByText(/estimated confidence/u)).toBeTruthy()
    const text = document.body.textContent ?? ''
    for (const forbidden of ['Выбранная цель', 'Скачивание', 'влезаемости']) {
      expect(text).not.toContain(forbidden)
    }
  })
})

function downloadEvents(
  terminal: Record<string, unknown> = {
    type: 'completed', seq: 3,
    data: {
      version: 1, state: 'completed',
      provenance: {
        version: 1,
        identity: repository().identity,
        revision: repository().revision,
        remotePath: 'llama-2-7b.Q4_K_M.gguf',
        license: repository().license,
        gated: repository().gated,
        sourceUrlPolicy: 'hugging_face_exact_revision_explicit_hosts_v1',
        expectedSizeBytes: 4_000,
        observedSizeBytes: 4_000,
        checksum: {
          algorithm: 'sha256', expectedDigest: 'd'.repeat(64),
          observedDigest: 'd'.repeat(64), relation: 'matched_provider_claim',
        },
        format: { kind: 'gguf', magic: 'GGUF', version: 3, inspection: 'bounded_header_only' },
        artifact: { state: 'managed_staging', id: '11111111-1111-4111-8111-111111111111' },
        observedAt: OBSERVED_AT,
        terminalState: 'completed',
      },
    },
  },
): Response {
  const events = [
    { type: 'state', seq: 0, data: { version: 1, state: 'preparing' } },
    {
      type: 'progress', seq: 1,
      data: { version: 1, state: 'downloading', completedBytes: 2_000, totalBytes: 4_000 },
    },
    { type: 'state', seq: 2, data: { version: 1, state: 'verifying' } },
    terminal,
  ]
  const body = events.map((event) => `id: ${String(event.seq)}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

async function confirmTarget() {
  fireEvent.click(await searchAndOpenFileList())
  await screen.findByText('Выбранная цель')
  return screen.getByRole('button', { name: 'Скачать точный GGUF' })
}

describe('P2-L exact GGUF download projection', () => {
  it('starts only on explicit Download, sends the exact confirmed tuple and shows provenance', async () => {
    let body: unknown = null
    let calls = 0
    vi.stubGlobal('fetch', routedFetch({
      download: (input) => {
        calls += 1
        body = input
        return downloadEvents()
      },
    }))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    const download = await confirmTarget()
    expect(calls).toBe(0)

    download.focus()
    fireEvent.click(download)
    expect(await screen.findByText('Staging artifact скачан и проверен')).toBeTruthy()
    expect(calls).toBe(1)
    expect(body).toEqual({
      identity: repository().identity,
      revision: repository().revision,
      filePath: 'llama-2-7b.Q4_K_M.gguf',
      contextLength: 8_192,
    })
    expect(screen.getByText(new RegExp('d'.repeat(64), 'u'))).toBeTruthy()
    expect(screen.getByText(/совпал с LFS claim/u)).toBeTruthy()
    expect(screen.getByText(/не установлен, не подтверждён runtime/u)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Установить|Install|Pull/u })).toBeNull()
    await waitFor(() => {
      expect(document.activeElement?.textContent).toContain('Staging artifact скачан и проверен')
    })
  })

  it('collapses duplicate activation and cancels one connection-owned stream', async () => {
    let calls = 0
    let signal: AbortSignal | null = null
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const event = {
          type: 'progress', seq: 0,
          data: { version: 1, state: 'downloading', completedBytes: 512, totalBytes: null },
        }
        controller.enqueue(encoder.encode(`id: 0\ndata: ${JSON.stringify(event)}\n\n`))
      },
    })
    vi.stubGlobal('fetch', routedFetch({
      download: (_body, currentSignal) => {
        calls += 1
        signal = currentSignal
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      },
    }))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    const download = await confirmTarget()
    fireEvent.click(download)
    fireEvent.click(download)
    fireEvent.click(download)
    expect(await screen.findByText(/Общий размер остаётся неизвестным/u)).toBeTruthy()
    expect(calls).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Отменить скачивание' }))
    const cancelled = await screen.findByText('Скачивание отменено')
    expect(cancelled).toBeTruthy()
    expect(signal?.aborted).toBe(true)
    expect(screen.getByRole('button', { name: 'Повторить скачивание' })).toBeTruthy()
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Скачивание отменено'))
  })

  it('discards terminal frames from a cancelled attempt after an immediate retry', async () => {
    let releaseOld!: () => void
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve })
    let calls = 0
    let oldSignal: AbortSignal | null = null
    const encoder = new TextEncoder()
    const oldStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const progress = {
          type: 'progress', seq: 0,
          data: { version: 1, state: 'downloading', completedBytes: 512, totalBytes: null },
        }
        controller.enqueue(encoder.encode(`id: 0\ndata: ${JSON.stringify(progress)}\n\n`))
      },
      async pull(controller) {
        await oldGate
        const late = {
          type: 'failed', seq: 1,
          data: { version: 1, state: 'failed', reason: 'checksum_mismatch' },
        }
        controller.enqueue(encoder.encode(`id: 1\ndata: ${JSON.stringify(late)}\n\n`))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', routedFetch({
      download: (_body, signal) => {
        calls += 1
        if (calls === 1) {
          oldSignal = signal
          return new Response(oldStream, { headers: { 'content-type': 'text/event-stream' } })
        }
        return downloadEvents()
      },
    }))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    fireEvent.click(await confirmTarget())
    expect(await screen.findByText(/Общий размер остаётся неизвестным/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Отменить скачивание' }))
    expect(await screen.findByText('Скачивание отменено')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Повторить скачивание' }))
    expect(await screen.findByText('Staging artifact скачан и проверен')).toBeTruthy()
    expect(calls).toBe(2)
    expect(oldSignal?.aborted).toBe(true)

    releaseOld()
    await waitFor(() => {
      expect(screen.getByText('Staging artifact скачан и проверен')).toBeTruthy()
      expect(screen.queryByText(/SHA-256 не совпал/u)).toBeNull()
    })
  })

  it('exposes preparing, known progress, verifying and failed focus through scoped live semantics', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    const encoder = new TextEncoder()
    const send = (event: Record<string, unknown>) => {
      const seq = Number(event.seq)
      streamController.enqueue(encoder.encode(`id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`))
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller },
    })
    vi.stubGlobal('fetch', routedFetch({
      download: () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    }))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    fireEvent.click(await confirmTarget())

    await screen.findAllByText('Повторно проверяем точную цель…')
    const preparing = screen.getAllByRole('status').find(
      (node) => node.textContent === 'Повторно проверяем точную цель…',
    )
    expect(preparing).toBeTruthy()
    expect(preparing?.getAttribute('aria-live')).toBe('polite')

    send({
      type: 'progress', seq: 0,
      data: { version: 1, state: 'downloading', completedBytes: 2_000, totalBytes: 4_000 },
    })
    const meter = await screen.findByRole('meter', { name: 'Прогресс скачивания точного GGUF' })
    expect(meter.getAttribute('aria-valuenow')).toBe('50')
    expect(screen.getByText(/2 КБ \/ 4 КБ/u)).toBeTruthy()

    send({ type: 'state', seq: 1, data: { version: 1, state: 'verifying' } })
    expect(await screen.findAllByText('Проверяем checksum и заголовок GGUF…')).toHaveLength(2)
    const verifying = screen.getAllByRole('status').find(
      (node) => node.textContent === 'Проверяем checksum и заголовок GGUF…',
    )
    expect(verifying?.getAttribute('aria-live')).toBe('polite')

    send({
      type: 'failed', seq: 2,
      data: { version: 1, state: 'failed', reason: 'checksum_mismatch' },
    })
    const failure = await screen.findByRole('alert')
    expect(failure.getAttribute('aria-live')).toBe('polite')
    expect(failure.textContent).toContain('SHA-256 не совпал')
    await waitFor(() => expect(document.activeElement).toBe(failure))
  })

  it('renders strict refused and failed reasons while retaining the local Marketplace row', async () => {
    const cases = [
      [
        { type: 'refused', seq: 3, data: { version: 1, state: 'refused', reason: 'redirect_not_allowed' } },
        /origin вне явной HTTPS policy/u,
      ],
      [
        { type: 'failed', seq: 3, data: { version: 1, state: 'failed', reason: 'checksum_mismatch' } },
        /SHA-256 не совпал/u,
      ],
    ] as const
    for (const [event, message] of cases) {
      const view = render(<HuggingFaceDiscovery contextLength={8_192} />)
      vi.stubGlobal('fetch', routedFetch({ download: () => downloadEvents(event) }))
      fireEvent.click(await confirmTarget())
      expect(await screen.findByText(message)).toBeTruthy()
      expect(screen.getByText('TheBloke/Llama-2-7B-GGUF')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Повторить скачивание' })).toBeTruthy()
      await waitFor(() => expect(document.activeElement?.textContent).toMatch(message))
      view.unmount()
    }
  })

  it('uses curated English download copy without bilingual hardcode', async () => {
    document.documentElement.lang = 'en'
    vi.stubGlobal('fetch', routedFetch({ download: () => downloadEvents() }))
    render(<HuggingFaceDiscovery contextLength={8_192} />)
    const input = screen.getByRole('searchbox', { name: 'Search Hugging Face repositories' })
    fireEvent.change(input, { target: { value: 'llama gguf' } })
    fireEvent.submit(input.closest('form')!)
    fireEvent.click(await screen.findByRole('button', { name: /Select the file/u }))
    const download = await screen.findByRole('button', { name: 'Download exact GGUF' })
    fireEvent.click(download)
    expect(await screen.findByText('Downloaded and verified staging artifact')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Скачивание')
  })
})
