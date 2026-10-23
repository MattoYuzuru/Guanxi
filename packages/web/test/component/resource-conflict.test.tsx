import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Job, RuntimeSnapshot } from '@guanxi/contract'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ResourceConflictDialog,
  useResourceConflictDecision,
  type ChatIntentDispatcher,
} from '../../src/features/chat/ResourceConflictDecision.tsx'
import { RuntimeProvider, useRuntimeProjection } from '../../src/features/health/RuntimeContext.tsx'
import { runtimeActiveLease, runtimeSnapshotFixture } from '../fixtures/runtime.ts'
import { setActiveLocale } from '../../src/lib/locale.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function DecisionHarness({ dispatch }: { dispatch: ChatIntentDispatcher }) {
  const runtime = useRuntimeProjection()
  const resource = useResourceConflictDecision(dispatch)
  const [accepted, setAccepted] = useState(0)
  const [rejected, setRejected] = useState(0)

  return (
    <div>
      <span data-testid="runtime-ready">{runtime.data ? 'ready' : 'loading'}</span>
      <span data-testid="accepted">{String(accepted)}</span>
      <span data-testid="rejected">{String(rejected)}</span>
      <button
        type="button"
        onClick={() => {
          void resource.request({
            content: 'fixture prompt',
            idempotencyKey: '11111111-1111-4111-8111-111111111111',
            onAccepted: () => {
              setAccepted((count) => count + 1)
            },
            onRejected: () => {
              setRejected((count) => count + 1)
            },
          })
        }}
      >
        Send fixture
      </button>
      {resource.decision ? (
        <ResourceConflictDialog
          decision={resource.decision}
          onQueue={resource.queue}
          onStopAndSwitch={() => void resource.stopAndSwitch()}
          onClose={resource.close}
        />
      ) : null}
    </div>
  )
}

function renderDecision(
  loader: (signal: AbortSignal) => Promise<RuntimeSnapshot>,
  dispatch: ChatIntentDispatcher,
) {
  return render(
    <RuntimeProvider loader={loader}>
      <DecisionHarness dispatch={dispatch} />
    </RuntimeProvider>,
  )
}

function idleSnapshot() {
  return runtimeSnapshotFixture((snapshot) => {
    snapshot.governor.activeLease = null
    snapshot.governor.queued = []
  })
}

function job(status: Job['status']): Job {
  const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(status)
  return {
    id: 'job-fixture',
    kind: 'inference',
    operation: 'chat',
    status,
    phase: terminal ? null : status,
    idempotencyScope: 'chat:thread-fixture:send:v1',
    idempotencyKey: '22222222-2222-4222-8222-222222222222',
    createdAt: '2026-08-02T12:00:00.000Z',
    startedAt: '2026-08-02T12:00:00.000Z',
    finishedAt: terminal ? '2026-08-02T12:00:01.000Z' : null,
    error:
      status === 'failed'
        ? { category: 'runtime_protocol', code: 'fixture', message: 'safe', retryable: false }
        : null,
    outcome: status === 'completed' ? { code: 'completed', metadata: {} } : null,
    stopReason: status === 'cancelled' ? 'user_requested' : null,
    lastEventSequence: 2,
  }
}

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setActiveLocale('ru')
})

describe('resource conflict decision', () => {
  it('keeps no-conflict send on one intent/key and bounds repeated activation', async () => {
    const loader = vi.fn(async () => idleSnapshot())
    const dispatch = vi.fn<ChatIntentDispatcher>((intent, callbacks) => {
      expect(intent.idempotencyKey).toBe('11111111-1111-4111-8111-111111111111')
      callbacks.onAccepted()
    })
    renderDecision(loader, dispatch)
    await screen.findByText('ready')

    const send = screen.getByRole('button', { name: 'Send fixture' })
    fireEvent.click(send)
    fireEvent.click(send)

    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('accepted').textContent).toBe('1')
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('never opens Stop for prewarm alone and hides Stop when normal work is queued behind it', async () => {
    const prewarmOnly = runtimeSnapshotFixture((snapshot) => {
      snapshot.governor.queued = []
      if (snapshot.governor.activeLease) {
        snapshot.governor.activeLease.operation = 'model_prewarm'
        snapshot.governor.activeLease.priority = 'prewarm'
        snapshot.governor.activeLease.owner = {
          kind: 'operation',
          operationId: 'model_prewarm:fixture',
        }
      }
    })
    const queuedNormal = runtimeSnapshotFixture((snapshot) => {
      if (snapshot.governor.activeLease) {
        snapshot.governor.activeLease.operation = 'model_prewarm'
        snapshot.governor.activeLease.priority = 'prewarm'
        snapshot.governor.activeLease.owner = {
          kind: 'operation',
          operationId: 'model_prewarm:fixture',
        }
      }
    })
    const loader = vi
      .fn<(signal: AbortSignal) => Promise<RuntimeSnapshot>>()
      .mockResolvedValueOnce(prewarmOnly)
      .mockResolvedValueOnce(prewarmOnly)
      .mockResolvedValueOnce(queuedNormal)
    const dispatch = vi.fn<ChatIntentDispatcher>((_intent, callbacks) => callbacks.onAccepted())
    renderDecision(loader, dispatch)
    await screen.findByText('ready')

    fireEvent.click(screen.getByRole('button', { name: 'Send fixture' }))
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Send fixture' }))
    const dialog = await screen.findByRole('dialog')
    expect(screen.queryByRole('button', { name: 'Остановить текущую и переключиться' })).toBeNull()
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Поставить после текущей' }),
      ),
    )
    expect(dialog.textContent).not.toContain('model_prewarm:fixture')
  })

  it('shows exact FIFO facts, defaults focus to Queue, traps/restores focus, and queues once', async () => {
    const snapshot = runtimeSnapshotFixture()
    const loader = vi.fn(async () => snapshot)
    const dispatch = vi.fn<ChatIntentDispatcher>((_intent, callbacks) => callbacks.onAccepted())
    const view = renderDecision(loader, dispatch)
    await screen.findByText('ready')
    const send = screen.getByRole('button', { name: 'Send fixture' })
    send.focus()
    fireEvent.click(send)

    const dialog = await screen.findByRole('dialog', { name: 'Конфликт ресурсов перед отправкой' })
    expect(dialog.textContent).toContain('fixture:latest')
    expect(dialog.textContent).toContain('Контекст:8k')
    expect(dialog.textContent).toContain('Позиция 1')
    expect(dialog.textContent).toContain('Позиция 2')
    expect(dialog.textContent).toContain('одним permit')
    expect(dialog.textContent).not.toContain('Parallel')
    const queue = screen.getByRole('button', { name: 'Поставить после текущей' })
    expect(document.activeElement).toBe(queue)
    expect(view.container.hasAttribute('inert')).toBe(true)

    fireEvent.keyDown(document, { key: 'Tab' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(send)
    expect(dispatch).not.toHaveBeenCalled()

    fireEvent.click(send)
    await screen.findByRole('dialog')
    const queueAgain = screen.getByRole('button', { name: 'Поставить после текущей' })
    fireEvent.click(queueAgain)
    fireEvent.click(queueAgain)
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('accepted').textContent).toBe('1')
  })

  it('fresh-verifies one exact Job, observes cancelling to cancelled, then dispatches once', async () => {
    const loader = vi.fn(async () => runtimeSnapshotFixture())
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://fixture')
      const method = (init?.method ?? 'GET').toUpperCase()
      requests.push(`${method} ${url.pathname}`)
      if (method === 'POST') return json({ job: job('cancelling') })
      const reads = requests.filter((item) => item === 'GET /api/jobs/job-fixture').length
      return json({ job: job(reads >= 2 ? 'cancelled' : 'generating') })
    }))
    const dispatch = vi.fn<ChatIntentDispatcher>((_intent, callbacks) => callbacks.onAccepted())
    renderDecision(loader, dispatch)
    await screen.findByText('ready')
    fireEvent.click(screen.getByRole('button', { name: 'Send fixture' }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Остановить текущую и переключиться' }))

    await waitFor(() => expect(requests).toContain('POST /api/jobs/job-fixture/cancel'))
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(requests.filter((item) => item.includes('/cancel'))).toHaveLength(1)
    expect(requests.filter((item) => item === 'GET /api/jobs/job-fixture')).toHaveLength(2)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('dispatches without cancel when the exact active Job is already terminal', async () => {
    const loader = vi.fn(async () => runtimeSnapshotFixture())
    const fetchMock = vi.fn(() => json({ job: job('completed') }))
    vi.stubGlobal('fetch', fetchMock)
    const dispatch = vi.fn<ChatIntentDispatcher>((_intent, callbacks) => callbacks.onAccepted())
    renderDecision(loader, dispatch)
    await screen.findByText('ready')
    fireEvent.click(screen.getByRole('button', { name: 'Send fixture' }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Остановить текущую и переключиться' }))
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('disables Stop for operation ownership and for a stale verification sample', async () => {
    const operationSnapshot = runtimeSnapshotFixture((snapshot) => {
      snapshot.governor.activeLease = runtimeActiveLease({
        kind: 'operation',
        operationId: 'operation-fixture',
      })
    })
    const operationLoader = vi.fn(async () => operationSnapshot)
    const dispatch = vi.fn<ChatIntentDispatcher>()
    const operation = renderDecision(operationLoader, dispatch)
    await screen.findByText('ready')
    fireEvent.click(screen.getByRole('button', { name: 'Send fixture' }))
    await screen.findByRole('dialog')
    expect(
      (screen.getByRole('button', { name: 'Остановить текущую и переключиться' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.getByRole('dialog').textContent).toContain('process-local runtime operation')
    operation.unmount()

    const staleLoader = vi
      .fn<(signal: AbortSignal) => Promise<RuntimeSnapshot>>()
      .mockResolvedValueOnce(runtimeSnapshotFixture())
      .mockRejectedValueOnce(new Error('private endpoint response'))
    renderDecision(staleLoader, dispatch)
    await screen.findByText('ready')
    fireEvent.click(screen.getByRole('button', { name: 'Send fixture' }))
    const stale = await screen.findByRole('dialog')
    expect(stale.textContent).toContain('последний подтверждённый sample')
    expect(stale.textContent).not.toContain('private endpoint')
    expect(
      (screen.getByRole('button', { name: 'Остановить текущую и переключиться' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('does not cancel or dispatch when the active Job changes during fresh verification', async () => {
    const original = runtimeSnapshotFixture()
    const changed = runtimeSnapshotFixture((snapshot) => {
      snapshot.governor.activeLease = runtimeActiveLease({ kind: 'job', jobId: 'job-changed' })
    })
    const loader = vi
      .fn<(signal: AbortSignal) => Promise<RuntimeSnapshot>>()
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(changed)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const dispatch = vi.fn<ChatIntentDispatcher>()
    renderDecision(loader, dispatch)
    await screen.findByText('ready')
    fireEvent.click(screen.getByRole('button', { name: 'Send fixture' }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Остановить текущую и переключиться' }))
    await screen.findByText(/Active owner изменился/u)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(
      (screen.getByRole('button', { name: 'Остановить текущую и переключиться' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('requires explicit retry after cancel failure and keeps one dispatch/key', async () => {
    const loader = vi.fn(async () => runtimeSnapshotFixture())
    let cancelCalls = 0
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
        cancelCalls += 1
        return cancelCalls === 1
          ? json({ code: 'internal_error', message: 'raw private failure', details: null }, 500)
          : json({ job: job('cancelled') })
      }
      return json({ job: job('generating') })
    }))
    const dispatch = vi.fn<ChatIntentDispatcher>((intent, callbacks) => {
      expect(intent.idempotencyKey).toBe('11111111-1111-4111-8111-111111111111')
      callbacks.onAccepted()
    })
    renderDecision(loader, dispatch)
    await screen.findByText('ready')
    fireEvent.click(screen.getByRole('button', { name: 'Send fixture' }))
    await screen.findByRole('dialog')
    const stop = screen.getByRole('button', { name: 'Остановить текущую и переключиться' })
    fireEvent.click(stop)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('снова явно активируйте Stop')
    expect(alert.textContent).not.toContain('raw private failure')
    expect(dispatch).not.toHaveBeenCalled()
    fireEvent.click(stop)
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(cancelCalls).toBe(2)
  })

  it('keeps the dialog and canonical key after a queue command transport failure', async () => {
    const loader = vi.fn(async () => runtimeSnapshotFixture())
    const keys: string[] = []
    let attempt = 0
    const dispatch = vi.fn<ChatIntentDispatcher>((intent, callbacks) => {
      keys.push(intent.idempotencyKey)
      attempt += 1
      if (attempt === 1) callbacks.onCommandError()
      else callbacks.onAccepted()
    })
    renderDecision(loader, dispatch)
    await screen.findByText('ready')
    fireEvent.click(screen.getByRole('button', { name: 'Send fixture' }))
    await screen.findByRole('dialog')
    const queue = screen.getByRole('button', { name: 'Поставить после текущей' })
    fireEvent.click(queue)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('command key сохранён')
    expect(screen.getByTestId('rejected').textContent).toBe('1')
    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.click(queue)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(keys).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
    ])
    expect(screen.getByTestId('accepted').textContent).toBe('1')
  })

  it('route unmount aborts only the caller wait and leaves the shared Runtime request alive', async () => {
    const active = runtimeSnapshotFixture()
    const pending = deferred<RuntimeSnapshot>()
    const signals: AbortSignal[] = []
    const loader = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return signals.length === 1 ? Promise.resolve(active) : pending.promise
    })
    const dispatch = vi.fn<ChatIntentDispatcher>()

    function RouteHarness() {
      const [chatOpen, setChatOpen] = useState(true)
      return (
        <RuntimeProvider loader={loader}>
          <button type="button" onClick={() => setChatOpen(false)}>Leave Chat</button>
          {chatOpen ? <DecisionHarness dispatch={dispatch} /> : <span>Settings fixture</span>}
        </RuntimeProvider>
      )
    }

    render(<RouteHarness />)
    await screen.findByText('ready')
    fireEvent.click(screen.getByRole('button', { name: 'Send fixture' }))
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'Leave Chat' }))
    expect(signals[1]?.aborted).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
    await act(async () => pending.resolve(active))
    expect(screen.getByText('Settings fixture')).toBeTruthy()
  })

  it('updates sampled details without stealing Queue focus and uses English fallback', async () => {
    setActiveLocale('en')
    const active = runtimeSnapshotFixture()
    const updated = runtimeSnapshotFixture((snapshot) => {
      snapshot.governor.queued[0]!.model.name = 'updated-waiter:latest'
    })
    const loader = vi
      .fn<(signal: AbortSignal) => Promise<RuntimeSnapshot>>()
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(updated)
    const dispatch = vi.fn<ChatIntentDispatcher>()
    let refresh!: () => Promise<RuntimeSnapshot>

    function RefreshCapture() {
      const runtime = useRuntimeProjection()
      refresh = () => runtime.refresh(undefined, true)
      return null
    }

    render(
      <RuntimeProvider loader={loader}>
        <RefreshCapture />
        <DecisionHarness dispatch={dispatch} />
      </RuntimeProvider>,
    )
    await screen.findByText('ready')
    fireEvent.click(screen.getByRole('button', { name: 'Send fixture' }))
    const dialog = await screen.findByRole('dialog', { name: 'Resource conflict before sending' })
    const queue = screen.getByRole('button', { name: 'Queue after current' })
    await waitFor(() => expect(document.activeElement).toBe(queue))

    await act(async () => {
      await refresh()
    })
    expect(dialog.textContent).toContain('updated-waiter:latest')
    expect(dialog.textContent).toContain('sampled conflict changed')
    expect(document.activeElement).toBe(queue)
  })
})
