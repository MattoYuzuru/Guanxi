import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  CompletionProbeEvidence,
  CompletionProbeResponse,
  ModelDetail,
  RuntimeSnapshot,
} from '@guanxi/contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CompletionProbe } from '../../src/features/models/CompletionProbe.tsx'
import { RuntimeProvider } from '../../src/features/health/RuntimeContext.tsx'
import { api } from '../../src/lib/api.ts'
import { runtimeSnapshotFixture } from '../fixtures/runtime.ts'
import { setActiveLocale } from '../../src/lib/locale.ts'

const AT = '2026-08-03T00:00:00.000Z'

function model(): ModelDetail {
  const fit = {
    level: 'green' as const,
    summary: 'fixture fit',
    contextLength: 8_192,
    modelBytes: 4_000,
    kvCacheBytes: 1_000,
    requiredBytes: 5_000,
    usableBytes: 10_000,
    utilization: 0.5,
    basis: 'estimate' as const,
    measured: null,
  }
  return {
    name: 'fixture:latest',
    digest: 'sha256:fixture',
    sizeBytes: 4_000,
    modifiedAt: AT,
    family: 'fixture',
    parameterSize: '1B',
    quantization: 'Q4',
    contextLength: 32_768,
    contextLimit: {
      state: 'declared', value: 32_768, source: 'ollama_api_tags',
      observedAt: AT, confidence: 'declared',
    },
    capabilities: ['completion'],
    descriptor: {
      reference: {
        state: 'canonical', provider: 'ollama', original: 'fixture:latest',
        normalized: 'fixture:latest',
      },
      artifact: { state: 'exact_digest', digest: 'sha256:fixture' },
      installation: {
        state: 'installed', source: 'ollama_api_tags', observedAt: AT,
        confidence: 'observed',
      },
      capabilities: {
        state: 'declared', reason: null, observedAt: AT, declarations: [],
      },
      freshness: {
        state: 'fresh', source: 'provider', observedAt: AT,
        validatedAt: AT, expiresAt: '2026-08-03T00:15:00.000Z', offline: false,
      },
    },
    isCloud: false,
    fit,
    modelInfo: {},
    template: null,
    systemPrompt: null,
    license: null,
    fitByContext: [fit],
  }
}

function evidence(
  overrides: Partial<CompletionProbeEvidence> = {},
): CompletionProbeEvidence {
  return {
    status: 'verified',
    reason: 'terminal_response',
    capability: 'completion',
    source: 'runtime_probe',
    confidence: 'verified',
    observedAt: AT,
    completedAt: AT,
    durationMs: 0,
    basis: {
      state: 'exact', keyVersion: 1, probeDefinitionVersion: 1,
      provider: 'ollama', normalizedModelReference: 'fixture:latest',
      artifactDigest: 'sha256:fixture', runtimeVersion: '0.12.6',
      contextLength: 8_192, id: `sha256:${'a'.repeat(64)}`,
    },
    historical: false,
    ...overrides,
  } as CompletionProbeEvidence
}

function runtime(operationState: 'idle' | 'queued' | 'running'): RuntimeSnapshot {
  return runtimeSnapshotFixture((snapshot) => {
    snapshot.governor.activeLease = null
    snapshot.governor.queued = []
    if (operationState === 'queued') {
      snapshot.governor.queued = [{
        ticketId: 'probe-ticket',
        owner: { kind: 'operation', operationId: 'probe-operation' },
        operation: 'model_probe',
        model: { provider: 'ollama', name: 'fixture:latest' },
        requestedContext: 8_192,
        priority: 'normal',
        enqueuedAt: AT,
        reason: 'single_permit_busy',
      }]
    }
    if (operationState === 'running') {
      snapshot.governor.activeLease = {
        leaseId: 'probe-lease', ticketId: 'probe-ticket',
        owner: { kind: 'operation', operationId: 'probe-operation' },
        operation: 'model_probe',
        model: { provider: 'ollama', name: 'fixture:latest' },
        requestedContext: 8_192,
        acquiredAt: AT,
        state: 'active',
      }
    }
  })
}

function renderProbe(operationState: 'idle' | 'queued' | 'running' = 'idle') {
  return render(
    <RuntimeProvider loader={async () => runtime(operationState)}>
      <CompletionProbe model={model()} contextLength={8_192} />
    </RuntimeProvider>,
  )
}

afterEach(() => vi.restoreAllMocks())

describe('manual completion probe', () => {
  it('never runs on mount, hover, rerender or unmount and confirms from the keyboard', async () => {
    const probe = vi.spyOn(api, 'completionProbe')
    const view = renderProbe()
    const launch = screen.getByRole('button', { name: 'Просмотреть условия и запустить проверку completion' })
    fireEvent.mouseOver(launch)
    view.rerender(
      <RuntimeProvider loader={async () => runtime('idle')}>
        <CompletionProbe model={model()} contextLength={8_192} />
      </RuntimeProvider>,
    )
    expect(probe).not.toHaveBeenCalled()

    launch.focus()
    fireEvent.keyDown(launch, { key: 'Enter' })
    fireEvent.click(launch)
    const dialog = await screen.findByRole('dialog', { name: 'Ненадолго загрузить и проверить модель?' })
    expect(dialog.getAttribute('aria-describedby')).toBe('completion-probe-confirmation')
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Запустить проверку' }),
    ))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(launch))
    expect(probe).not.toHaveBeenCalled()
    view.unmount()
    expect(probe).not.toHaveBeenCalled()
  })

  it.each(['queued', 'running'] as const)(
    'projects %s, gives Cancel focus and aborts only the request-scoped probe',
    async (operationState) => {
      let signal: AbortSignal | undefined
      vi.spyOn(api, 'completionProbe').mockImplementation((_name, _body, requestSignal) => {
        signal = requestSignal
        return new Promise((_resolve, reject) => requestSignal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        ))
      })
      renderProbe(operationState)
      const launch = screen.getByRole('button', { name: /Просмотреть условия/u })
      fireEvent.click(launch)
      fireEvent.click(await screen.findByRole('button', { name: 'Запустить проверку' }))
      expect(await screen.findByText(
        operationState === 'queued'
          ? 'Ожидает завершения runtime-работы'
          : 'Выполняется',
      )).toBeTruthy()
      const cancel = screen.getByRole('button', { name: 'Отменить эту проверку completion' })
      await waitFor(() => expect(document.activeElement).toBe(cancel))
      fireEvent.click(cancel)
      await waitFor(() => expect(signal?.aborted).toBe(true))
      expect(await screen.findByText('Отменено')).toBeTruthy()
      expect(screen.getByText('Эта request-scoped проверка отменена.')).toBeTruthy()
      await waitFor(() => expect(document.activeElement).toBe(launch))
    },
  )

  it('shows a fresh verified result, historical reuse and explicit forced rerun', async () => {
    const probe = vi.spyOn(api, 'completionProbe')
      .mockResolvedValueOnce({ evidence: evidence() })
      .mockResolvedValueOnce({ evidence: evidence({ historical: true }) })
      .mockResolvedValueOnce({ evidence: evidence({ observedAt: '2026-08-03T00:01:00.000Z' }) })
    renderProbe()

    const run = async (buttonName: RegExp, confirmName: string) => {
      fireEvent.click(screen.getByRole('button', { name: buttonName }))
      fireEvent.click(await screen.findByRole('button', { name: confirmName }))
    }
    await run(/Просмотреть условия и запустить проверку completion/u, 'Запустить проверку')
    expect(await screen.findByText('Подтверждено')).toBeTruthy()
    expect(screen.getByText(/Ollama вернула конечный непустой/u)).toBeTruthy()

    await run(/Просмотреть условия и запустить проверку completion/u, 'Запустить проверку')
    expect(await screen.findByText('Исторический exact-результат')).toBeTruthy()

    await run(/Просмотреть условия и запустить новую проверку completion/u, 'Запустить новую проверку')
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(3))
    expect(probe.mock.calls[2]?.[1].force).toBe(true)
  })

  it('shows safe failure copy and curated English fallback without verified-green semantics', async () => {
    setActiveLocale('en')
    const degraded = evidence({
      status: 'degraded', reason: 'provider_error', confidence: 'degraded', historical: false,
    })
    vi.spyOn(api, 'completionProbe')
      .mockResolvedValueOnce({ evidence: degraded } as CompletionProbeResponse)
      .mockRejectedValueOnce(new Error('The completion probe could not be completed safely'))
    const view = renderProbe()
    const launch = screen.getByRole('button', { name: /Review and run the completion probe/u })
    fireEvent.click(launch)
    fireEvent.click(await screen.findByRole('button', { name: 'Run probe' }))
    expect(await screen.findByText('Degraded')).toBeTruthy()
    expect(screen.getByText(/not an unsupported claim/u)).toBeTruthy()
    expect(view.container.innerHTML).not.toContain('color-fit-green')

    fireEvent.click(launch)
    fireEvent.click(await screen.findByRole('button', { name: 'Run probe' }))
    expect(await screen.findByText('Request failed')).toBeTruthy()
    expect(screen.getByText('The completion probe could not be completed safely')).toBeTruthy()
    setActiveLocale('ru')
  })

  it('aborts on unmount without applying a late completion', async () => {
    let signal: AbortSignal | undefined
    let resolve!: (value: CompletionProbeResponse) => void
    vi.spyOn(api, 'completionProbe').mockImplementation((_name, _body, requestSignal) => {
      signal = requestSignal
      return new Promise((done) => { resolve = done })
    })
    const view = renderProbe()
    fireEvent.click(screen.getByRole('button', { name: /Просмотреть условия/u }))
    fireEvent.click(await screen.findByRole('button', { name: 'Запустить проверку' }))
    view.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => resolve({ evidence: evidence() }))
  })
})
