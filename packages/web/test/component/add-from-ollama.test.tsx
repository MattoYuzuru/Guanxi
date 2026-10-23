import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AddFromOllama } from '../../src/features/models/AddFromOllama.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'

const originalFetch = globalThis.fetch

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sse(...events: unknown[]): Response {
  const body = events.map((event, index) =>
    `id: ${index}\nevent: guanxi\ndata: ${JSON.stringify(event)}\n\n`,
  ).join('')
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  })
}

function preview(reference = 'https://ollama.com/library/qwen3:8b') {
  return {
    preview: {
      inputKind: reference.startsWith('https://') ? 'official_page_url' : 'model_name',
      displayValue: reference,
      normalizedModelName: 'qwen3:8b',
    },
  }
}

function installedModel() {
  return {
    name: 'qwen3:8b', digest: 'sha256:fixture', sizeBytes: 1,
    modifiedAt: '2026-08-04T00:00:00.000Z', family: 'qwen3',
    parameterSize: '8B', quantization: 'Q4', contextLength: 8_192,
    capabilities: [], isCloud: false,
    fit: {
      level: 'unknown', summary: 'unknown', contextLength: 8_192,
      modelBytes: 1, kvCacheBytes: 1, requiredBytes: 2, usableBytes: 1,
      utilization: 2, basis: 'estimate', measured: null,
    },
  }
}

afterEach(() => {
  vi.stubGlobal('fetch', originalFetch)
})

describe('Add from Ollama Marketplace flow', () => {
  it('does nothing on mount/type/paste/close and previews only on explicit keyboard submit', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(preview()))
    vi.stubGlobal('fetch', fetch)
    const view = render(<AddFromOllama installedNames={[]} onInstalled={vi.fn()} />)
    const entry = screen.getByRole('button', { name: /Добавить модель по имени Ollama/u })
    fireEvent.mouseOver(entry)
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(entry)
    const input = screen.getByRole('textbox', { name: 'Имя модели или URL официальной страницы' })
    await waitFor(() => expect(document.activeElement).toBe(input))
    fireEvent.change(input, { target: { value: 'https://ollama.com/library/qwen3:8b' } })
    fireEvent.paste(input, { clipboardData: { getData: () => 'qwen3:8b' } })
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.submit(input.closest('form')!)
    expect(await screen.findByText('qwen3:8b')).toBeTruthy()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/models/imports/ollama-reference/preview')
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      reference: 'https://ollama.com/library/qwen3:8b',
    })
    expect(screen.getByText(/Preview не доказывает availability/u)).toBeTruthy()
    expect(fetch).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(entry))
    view.unmount()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fails closed for invalid input and uses curated English fallback', async () => {
    setActiveLocale('en')
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      code: 'validation_failed', message: 'The Ollama reference is invalid',
      details: { reason: 'invalid_official_url' },
    }, 400))
    vi.stubGlobal('fetch', fetch)
    render(<AddFromOllama installedNames={[]} onInstalled={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Add a model from an Ollama name/u }))
    const input = screen.getByRole('textbox', { name: 'Model name or official page URL' })
    fireEvent.change(input, { target: { value: 'https://evil.test/model' } })
    fireEvent.submit(input.closest('form')!)
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Enter a valid Ollama model name or official HTTPS model-page URL.',
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('dispatches one confirmed target on double activation, projects progress and refreshes Installed truth', async () => {
    const requests: Array<{ url: string; body: unknown }> = []
    const onInstalled = vi.fn()
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
      const url = String(input)
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (url.endsWith('/preview')) return json(preview('QWEN3:8B'))
      if (url.endsWith('/start')) return sse(
        { type: 'progress', seq: 0, data: {
          status: 'pulling manifest', digest: null, totalBytes: null,
          completedBytes: null, percent: null, bytesPerSecond: null, etaSeconds: null,
        } },
        { type: 'progress', seq: 1, data: {
          status: 'downloading', digest: 'sha256:layer', totalBytes: 100,
          completedBytes: 50, percent: 50, bytesPerSecond: 10, etaSeconds: 5,
        } },
        { type: 'done', seq: 2, data: { name: 'qwen3:8b' } },
      )
      if (url === '/api/models') return json({ models: [installedModel()] })
      throw new Error(url)
    })
    vi.stubGlobal('fetch', fetch)
    render(<AddFromOllama installedNames={[]} onInstalled={onInstalled} />)
    fireEvent.click(screen.getByRole('button', { name: /Добавить модель/u }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'QWEN3:8B' } })
    fireEvent.submit(input.closest('form')!)
    const confirm = await screen.findByRole('button', { name: /Подтвердить нормализованную цель/u })
    await waitFor(() => expect(document.activeElement).toBe(confirm))
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(await screen.findByText('Ollama сообщила о завершении pull')).toBeTruthy()
    expect(screen.getByText(/нормализованное имя присутствует/u)).toBeTruthy()
    expect(screen.getByText(/Completion probe/u)).toBeTruthy()
    expect(requests.filter((request) => request.url.endsWith('/start'))).toEqual([{
      url: '/api/models/imports/ollama-reference/start',
      body: { reference: 'QWEN3:8B', confirmedModelName: 'qwen3:8b' },
    }])
    expect(requests.filter((request) => request.url === '/api/models')).toHaveLength(1)
    expect(requests.some((request) => request.url.includes('/probes/completion'))).toBe(false)
    expect(onInstalled).toHaveBeenCalledTimes(1)
  })

  it('projects ordered progress before terminal success', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller },
    })
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/preview')) return json(preview('qwen3:8b'))
      if (url.endsWith('/start')) return new Response(stream, {
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      })
      if (url === '/api/models') return json({ models: [installedModel()] })
      throw new Error(url)
    })
    vi.stubGlobal('fetch', fetch)
    render(<AddFromOllama installedNames={[]} onInstalled={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Добавить модель/u }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'qwen3:8b' } })
    fireEvent.submit(input.closest('form')!)
    fireEvent.click(await screen.findByRole('button', { name: /Подтвердить нормализованную цель/u }))
    const encoder = new TextEncoder()
    streamController.enqueue(encoder.encode(
      `id: 0\nevent: guanxi\ndata: ${JSON.stringify({
        type: 'progress', seq: 0, data: {
          status: 'downloading', digest: 'sha256:layer', totalBytes: 100,
          completedBytes: 25, percent: 25, bytesPerSecond: 10, etaSeconds: 8,
        },
      })}\n\n`,
    ))
    expect(await screen.findByText('Ollama скачивает данные модели.')).toBeTruthy()
    expect(screen.getByLabelText('Прогресс Ollama pull')).toBeTruthy()
    expect(screen.getByText('25%, 25 Б')).toBeTruthy()
    streamController.enqueue(encoder.encode(
      `id: 1\nevent: guanxi\ndata: ${JSON.stringify({
        type: 'done', seq: 1, data: { name: 'qwen3:8b' },
      })}\n\n`,
    ))
    streamController.close()
    expect(await screen.findByText('Ollama сообщила о завершении pull')).toBeTruthy()
  })

  it('keeps refresh failure truthful and pulls again from its own Pull button after a provider error', async () => {
    let pullAttempt = 0
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/preview')) return json(preview('qwen3:8b'))
      if (url.endsWith('/start')) {
        pullAttempt += 1
        if (pullAttempt === 1) return sse({
          type: 'error', seq: 0, data: {
            code: 'upstream_error', message: 'safe server copy', details: null,
          },
        })
        return sse({ type: 'done', seq: 0, data: { name: 'qwen3:8b' } })
      }
      if (url === '/api/models') return json({
        code: 'ollama_unavailable', message: 'redacted', details: null,
      }, 503)
      throw new Error(url)
    })
    vi.stubGlobal('fetch', fetch)
    render(<AddFromOllama installedNames={[]} onInstalled={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Добавить модель/u }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'qwen3:8b' } })
    fireEvent.submit(input.closest('form')!)
    fireEvent.click(await screen.findByRole('button', { name: /Подтвердить нормализованную цель/u }))
    expect(await screen.findByText('Pull завершился ошибкой')).toBeTruthy()
    expect(screen.queryAllByRole('button', { name: /^Повторить/u })).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Скачать' }))
    expect(await screen.findByText(/Обновить Installed не удалось/u)).toBeTruthy()
    expect(screen.queryByText(/sha256/u)).toBeNull()
    expect(pullAttempt).toBe(2)
  })

  it('cancels only the active request, shows cancelled and allows one explicit pull again', async () => {
    let aborted = false
    let pullAttempt = 0
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/preview')) return json(preview('qwen3:8b'))
      if (url.endsWith('/start')) {
        pullAttempt += 1
        if (pullAttempt > 1) return sse({ type: 'error', seq: 0, data: {
          code: 'runtime_protocol', message: 'safe', details: null,
        } })
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new DOMException('cancelled', 'AbortError'))
          }, { once: true })
        })
      }
      throw new Error(url)
    })
    vi.stubGlobal('fetch', fetch)
    render(<AddFromOllama installedNames={[]} onInstalled={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Добавить модель/u }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'qwen3:8b' } })
    fireEvent.submit(input.closest('form')!)
    fireEvent.click(await screen.findByRole('button', { name: /Подтвердить нормализованную цель/u }))
    const cancel = await screen.findByRole('button', { name: 'Отменить этот pull' })
    await waitFor(() => expect(document.activeElement).toBe(cancel))
    fireEvent.click(cancel)
    expect(await screen.findByText('Pull отменён')).toBeTruthy()
    expect(aborted).toBe(true)
    expect(screen.queryAllByRole('button', { name: /^Повторить/u })).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Скачать' }))
    expect(await screen.findByText('Pull завершился ошибкой')).toBeTruthy()
    expect(pullAttempt).toBe(2)
  })

  it('aborts the connection-owned pull on unmount without a late refresh', async () => {
    let pullSignal: AbortSignal | null = null
    const onInstalled = vi.fn()
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/preview')) return json(preview('qwen3:8b'))
      if (url.endsWith('/start')) {
        pullSignal = init?.signal ?? null
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('unmounted', 'AbortError'))
          }, { once: true })
        })
      }
      throw new Error(url)
    })
    vi.stubGlobal('fetch', fetch)
    const view = render(
      <StrictMode>
        <AddFromOllama installedNames={[]} onInstalled={onInstalled} />
      </StrictMode>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Добавить модель/u }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'qwen3:8b' } })
    fireEvent.submit(input.closest('form')!)
    fireEvent.click(await screen.findByRole('button', { name: /Подтвердить нормализованную цель/u }))
    await waitFor(() => expect(pullSignal).not.toBeNull())
    view.unmount()
    await waitFor(() => expect(pullSignal?.aborted).toBe(true))
    expect(fetch.mock.calls.filter(([url]) => String(url) === '/api/models')).toHaveLength(0)
    expect(onInstalled).not.toHaveBeenCalled()
  })
})
