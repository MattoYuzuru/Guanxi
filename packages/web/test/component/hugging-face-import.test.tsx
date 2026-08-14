import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HuggingFaceDownloadProvenance } from '@alamo/contract'
import { HuggingFaceImportControl } from '../../src/features/models/HuggingFaceImportControl.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'

const originalFetch = globalThis.fetch
const ARTIFACT_ID = '11111111-1111-4111-8111-111111111111'
const OBSERVED_AT = '2026-08-09T12:00:00.000Z'

afterEach(() => {
  vi.stubGlobal('fetch', originalFetch)
  setActiveLocale('ru')
})

function artifact(): HuggingFaceDownloadProvenance {
  return {
    version: 1,
    identity: {
      provider: 'hugging_face', owner: 'Owner', name: 'Model',
      repositoryId: 'Owner/Model', comparisonKey: 'owner/model',
    },
    revision: { state: 'exact_commit', commit: 'a'.repeat(40), source: 'hugging_face_api_model' },
    remotePath: 'model.gguf',
    license: {
      state: 'declared', value: 'apache-2.0',
      source: 'hugging_face_model_tags', confidence: 'declared',
    },
    gated: { state: 'open', mode: null },
    sourceUrlPolicy: 'hugging_face_exact_revision_explicit_hosts_v1',
    expectedSizeBytes: 16,
    observedSizeBytes: 16,
    checksum: {
      algorithm: 'sha256', expectedDigest: 'c'.repeat(64), observedDigest: 'c'.repeat(64),
      relation: 'matched_provider_claim',
    },
    format: { kind: 'gguf', magic: 'GGUF', version: 3, inspection: 'bounded_header_only' },
    artifact: { state: 'managed_staging', id: ARTIFACT_ID },
    observedAt: OBSERVED_AT,
    terminalState: 'completed',
  }
}

function event(type: string, data: Record<string, unknown>, seq = 0) {
  return { type, seq, data: { version: 1, ...data } }
}

function probeEvidence(status: 'verified' | 'degraded' = 'verified') {
  return {
    status,
    reason: status === 'verified' ? 'terminal_response' : 'provider_error',
    capability: 'completion', source: 'runtime_probe',
    confidence: status === 'verified' ? 'verified' : 'degraded',
    observedAt: OBSERVED_AT, completedAt: OBSERVED_AT, durationMs: 0,
    historical: false,
    basis: {
      state: 'exact', keyVersion: 1, probeDefinitionVersion: 1,
      provider: 'ollama', normalizedModelReference: 'owner/model:latest',
      artifactDigest: 'manifest-digest', runtimeVersion: '0.32.0',
      contextLength: 8_192, id: `sha256:${'d'.repeat(64)}`,
    },
  }
}

function successEvents() {
  const target = 'owner/model:latest'
  const digest = 'manifest-digest'
  return [
    event('state', { state: 'preparing', phase: 'validating_artifact' }, 0),
    event('state', { state: 'importing', phase: 'creating_model' }, 1),
    event('state', { state: 'verifying', phase: 'observing_installation' }, 2),
    event('state', { state: 'probing', phase: 'running_completion_probe' }, 3),
    event('completed', {
      state: 'completed',
      provenance: {
        version: 1,
        source: artifact(),
        targetModelName: target,
        create: {
          endpoint: '/api/create', input: 'uploaded_sha256_blob_files_map',
          terminalStatus: 'success', startedAt: OBSERVED_AT, terminalAt: OBSERVED_AT,
        },
        installation: {
          source: 'ollama_api_tags', normalizedModelReference: target, digest,
          runtimeVersion: '0.32.0', observedAt: OBSERVED_AT,
        },
        probe: probeEvidence(),
        staging: { artifactId: ARTIFACT_ID, retention: 'deleted_after_verified_success' },
        completedAt: OBSERVED_AT,
      },
    }, 4),
  ]
}

function sse(events: unknown[]): Response {
  const body = events.map((item) => `event: alamo\ndata: ${JSON.stringify(item)}\n\n`).join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function fillAndConfirm(target = 'Owner/Model') {
  fireEvent.change(screen.getByRole('textbox', { name: 'Локальная ссылка модели Ollama' }), {
    target: { value: target },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Проверить локальный импорт' }))
  return screen.getByRole('dialog')
}

describe('explicit Hugging Face staged import control', () => {
  it('is inert until explicit confirmation and sends only artifact/target/context', async () => {
    let resolve: ((value: Response) => void) | undefined
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      () => new Promise<Response>((done) => { resolve = done }),
    )
    vi.stubGlobal('fetch', fetch)
    render(<HuggingFaceImportControl artifact={artifact()} contextLength={8_192} />)

    const input = screen.getByRole('textbox', { name: 'Локальная ссылка модели Ollama' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Owner/Model' } })
    expect(fetch).not.toHaveBeenCalled()
    const dialog = fillAndConfirm()
    expect(dialog.textContent).toContain(ARTIFACT_ID)
    expect(dialog.textContent).toContain('Owner/Model')
    for (const name of ['Закрыть подтверждение импорта', 'Назад', 'Создать и проверить']) {
      expect(screen.getByRole('button', { name }).className).toContain('min-h-11')
    }
    expect(fetch).not.toHaveBeenCalled()

    const confirm = screen.getByRole('button', { name: 'Создать и проверить' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0]?.[0])).toBe('/api/models/imports/hugging-face-gguf/start')
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
    expect(body).toEqual({
      artifactId: ARTIFACT_ID, targetModelName: 'Owner/Model', contextLength: 8_192,
    })
    expect(body.path).toBeUndefined()
    expect(body.modelfile).toBeUndefined()
    expect(body.options).toBeUndefined()
    resolve?.(sse([event('cancelled', { state: 'cancelled', reason: 'request_cancelled' })]))
    await screen.findByText('Импорт отменён до create')
  })

  it('claims Installed/runtime only after one exact completed event and refreshes once', async () => {
    const onInstalled = vi.fn()
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(sse(successEvents())))
    render(
      <HuggingFaceImportControl
        artifact={artifact()}
        contextLength={8_192}
        onInstalled={onInstalled}
      />,
    )
    fillAndConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'Создать и проверить' }))

    expect(await screen.findByText('Установлено и проверено runtime')).toBeTruthy()
    expect(screen.getAllByText(/Установка наблюдалась в новом локальном sample/u)).toHaveLength(1)
    expect(screen.getAllByText(/Фиксированный completion probe получил/u)).toHaveLength(1)
    expect(screen.getAllByText(/owner\/model:latest · manifest-digest/u)).toHaveLength(1)
    expect(onInstalled).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Повторить импорт' })).toBeNull()
  })

  it('shows typed no-overwrite conflict without Installed/runtime claims or refresh', async () => {
    const onInstalled = vi.fn()
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(sse([
      event('conflict', {
        state: 'conflict', reason: 'target_preexisting',
        target: {
          state: 'exact', normalizedModelReference: 'owner/model:latest',
          digest: 'existing-digest', observedAt: OBSERVED_AT,
        },
      }),
    ])))
    render(
      <HuggingFaceImportControl
        artifact={artifact()}
        contextLength={8_192}
        onInstalled={onInstalled}
      />,
    )
    fillAndConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'Создать и проверить' }))

    expect(await screen.findByText('Результат импорта требует внимания')).toBeTruthy()
    expect(screen.getByText(/уже существовала/u)).toBeTruthy()
    expect(screen.queryByText(/Установка наблюдалась в новом/u)).toBeNull()
    expect(screen.queryByText(/completion probe получил/u)).toBeNull()
    expect(onInstalled).not.toHaveBeenCalled()
  })

  it('shows invalid target validation and failed probe evidence without a provider-unavailable claim', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 'validation_failed', message: 'invalid', details: { reason: 'invalid_name' },
      }), { status: 400, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(sse([event('failed', {
        state: 'failed', reason: 'probe_not_verified',
        target: {
          state: 'exact', normalizedModelReference: 'owner/model:latest',
          digest: 'manifest-digest', observedAt: OBSERVED_AT,
        },
        probe: probeEvidence('degraded'),
      })])))
    render(<HuggingFaceImportControl artifact={artifact()} contextLength={8_192} />)

    fillAndConfirm('../bad')
    fireEvent.click(screen.getByRole('button', { name: 'Создать и проверить' }))
    expect(await screen.findByText(/Укажите корректную локальную ссылку/u)).toBeTruthy()
    expect(screen.queryByText(/Ollama был недоступен/u)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Повторить импорт' }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', {
      name: 'Локальная ссылка модели Ollama',
    })))
    fillAndConfirm('owner/model:latest')
    fireEvent.click(screen.getByRole('button', { name: 'Создать и проверить' }))
    expect(await screen.findByText('Evidence controlled completion probe')).toBeTruthy()
    expect(screen.getByText(/Неполный результат/u)).toBeTruthy()
    expect(screen.getByText(/Ollama вернула ошибку/u)).toBeTruthy()
    expect(screen.queryByText('Установлено и проверено runtime')).toBeNull()
  })

  it('cancels the owned request without a false clean-cancel claim and keeps retry keyboard-reachable', async () => {
    let signal: AbortSignal | undefined
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const encoder = new TextEncoder()
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => {
      signal = init?.signal ?? undefined
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify(event('state', {
              state: 'importing', phase: 'creating_model',
            }))}\n\n`,
          ))
        },
      })
      return Promise.resolve(new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      }))
    })
    vi.stubGlobal('fetch', fetch)
    render(<HuggingFaceImportControl artifact={artifact()} contextLength={8_192} />)
    fillAndConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'Создать и проверить' }))
    const cancel = await screen.findByRole('button', { name: 'Отменить импорт' })
    expect(cancel.className).toContain('min-h-11')
    fireEvent.click(cancel)
    expect(signal?.aborted).toBe(true)
    streamController?.enqueue(encoder.encode(
      `data: ${JSON.stringify(successEvents().at(-1))}\n\n`,
    ))
    streamController?.close()
    expect(await screen.findByText('Результат импорта требует внимания')).toBeTruthy()
    expect(screen.getByText(/Create мог начаться/u)).toBeTruthy()
    await waitFor(() => expect(document.activeElement).not.toBe(document.body))
    fireEvent.click(screen.getByRole('button', { name: 'Повторить импорт' }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', {
      name: 'Локальная ссылка модели Ollama',
    })))
    expect(screen.queryByText('Установлено и проверено runtime')).toBeNull()
  })

  it('uses curated English fallback for confirmation and terminal provenance', async () => {
    setActiveLocale('en')
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(sse(successEvents())))
    render(<HuggingFaceImportControl artifact={artifact()} contextLength={8_192} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Local Ollama model reference' }), {
      target: { value: 'owner/model:latest' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review local import' }))
    expect(screen.getByRole('dialog').textContent).toContain('documented /api/create')
    fireEvent.click(screen.getByRole('button', { name: 'Create and verify' }))
    expect(await screen.findByText('Installed and runtime verified')).toBeTruthy()
    expect(screen.getAllByText(/fresh local \/api\/tags sample/u)).toHaveLength(1)
  })
})
