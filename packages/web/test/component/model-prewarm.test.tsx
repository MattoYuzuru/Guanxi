import { StrictMode, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { LocalModel, PrewarmModelResponse, RuntimeSnapshot } from '@guanxi/contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../src/lib/api.ts'
import { RuntimeProvider, useRuntimeProjection } from '../../src/features/health/RuntimeContext.tsx'
import {
  MODEL_PREWARM_DEBOUNCE_MS,
  useModelPrewarm,
} from '../../src/features/chat/useModelPrewarm.ts'
import { runtimeSnapshotFixture } from '../fixtures/runtime.ts'

function model(name: string): LocalModel {
  return {
    name,
    digest: `sha256:${name}`,
    sizeBytes: 2_000_000_000,
    modifiedAt: '2026-08-03T00:00:00.000Z',
    family: 'fixture',
    parameterSize: '3B',
    quantization: 'Q4_K_M',
    contextLength: 32_768,
    capabilities: ['completion'],
    isCloud: false,
    fit: {
      level: 'green',
      summary: 'fixture fit',
      contextLength: 8_192,
      modelBytes: 2_000_000_000,
      kvCacheBytes: 500_000_000,
      requiredBytes: 2_500_000_000,
      usableBytes: 12_000_000_000,
      utilization: 0.21,
      basis: 'estimate',
      measured: null,
    },
  }
}

function result(name: string): PrewarmModelResponse {
  return {
    status: 'warmed',
    reason: 'loaded',
    model: { name, digest: `sha256:${name}` },
    operation: 'chat',
    purpose: 'model_prewarm',
    priority: 'prewarm',
    keepAlive: '2m',
    observedAt: '2026-08-03T00:00:00.000Z',
  }
}

function setVisibility(state: 'visible' | 'hidden', dispatch = true) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
  if (dispatch) document.dispatchEvent(new Event('visibilitychange'))
}

function Harness({ loader }: { loader: (signal: AbortSignal) => Promise<RuntimeSnapshot> }) {
  const [selected, setSelected] = useState(model('model-a:latest'))
  const [enabled, setEnabled] = useState(true)
  return (
    <RuntimeProvider loader={loader}>
      <PrewarmHarness
        selected={selected}
        enabled={enabled}
        onSelect={(name) => setSelected(model(name))}
        onDisable={() => setEnabled(false)}
      />
    </RuntimeProvider>
  )
}

function PrewarmHarness({
  selected,
  enabled,
  onSelect,
  onDisable,
}: {
  selected: LocalModel
  enabled: boolean
  onSelect: (name: string) => void
  onDisable: () => void
}) {
  const runtime = useRuntimeProjection()
  const prewarm = useModelPrewarm({ model: selected, contextLength: 8_192, enabled })
  return (
    <div>
      <span data-testid="phase">{prewarm.phase}:{prewarm.reason ?? 'none'}</span>
      <button type="button" onClick={() => onSelect('model-b:latest')}>B</button>
      <button type="button" onClick={() => onSelect('model-c:latest')}>C</button>
      <button type="button" onClick={onDisable}>Disable</button>
      <button type="button" onClick={() => void runtime.refresh(undefined, true)}>Normal</button>
    </div>
  )
}

describe('New Chat model prewarm debounce owner', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    setVisibility('visible')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    setVisibility('visible', false)
  })

  it('debounces rapid A→B→C and StrictMode rerenders into one final exact command', async () => {
    const calls: string[] = []
    vi.spyOn(api, 'prewarmModel').mockImplementation(async (name) => {
      calls.push(name)
      return result(name)
    })
    const loader = vi.fn(async () => runtimeSnapshotFixture((snapshot) => {
      snapshot.governor.activeLease = null
      snapshot.governor.queued = []
    }))
    render(
      <StrictMode>
        <Harness loader={loader} />
      </StrictMode>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'B' }))
    await act(async () => vi.advanceTimersByTimeAsync(MODEL_PREWARM_DEBOUNCE_MS - 1))
    fireEvent.click(screen.getByRole('button', { name: 'C' }))
    await act(async () => vi.advanceTimersByTimeAsync(MODEL_PREWARM_DEBOUNCE_MS))
    await act(async () => Promise.resolve())
    expect(calls).toEqual(['model-c:latest'])
    expect(screen.getByTestId('phase').textContent).toBe('warmed:loaded')
  })

  it('cancels timers for hidden document and setting off without a command', async () => {
    const prewarm = vi.spyOn(api, 'prewarmModel').mockResolvedValue(result('model-a:latest'))
    const loader = vi.fn(async () => runtimeSnapshotFixture())
    render(<Harness loader={loader} />)

    act(() => setVisibility('hidden'))
    await act(async () => vi.advanceTimersByTimeAsync(MODEL_PREWARM_DEBOUNCE_MS * 2))
    expect(prewarm).not.toHaveBeenCalled()
    expect(screen.getByTestId('phase').textContent).toBe('cancelled:document_hidden')

    act(() => setVisibility('visible'))
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    await act(async () => vi.advanceTimersByTimeAsync(MODEL_PREWARM_DEBOUNCE_MS * 2))
    expect(prewarm).not.toHaveBeenCalled()
    expect(screen.getByTestId('phase').textContent).toBe('skipped:disabled')
  })

  it('aborts the exact active request on unmount and ignores its stale completion', async () => {
    let signal: AbortSignal | undefined
    let resolveRequest: ((value: PrewarmModelResponse) => void) | undefined
    vi.spyOn(api, 'prewarmModel').mockImplementation((_name, _body, requestSignal) => {
      signal = requestSignal
      return new Promise((resolve) => {
        resolveRequest = resolve
      })
    })
    const view = render(<Harness loader={async () => runtimeSnapshotFixture((snapshot) => {
      snapshot.governor.activeLease = null
      snapshot.governor.queued = []
    })} />)
    await act(async () => vi.advanceTimersByTimeAsync(MODEL_PREWARM_DEBOUNCE_MS))
    expect(screen.getByTestId('phase').textContent).toBe('warming:none')
    view.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => resolveRequest?.(result('model-a:latest')))
  })

  it('aborts only prewarm when a normal Runtime intent appears', async () => {
    let prewarmSignal: AbortSignal | undefined
    vi.spyOn(api, 'prewarmModel').mockImplementation((_name, _body, signal) => {
      prewarmSignal = signal
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        )
      })
    })
    const idle = runtimeSnapshotFixture((snapshot) => {
      snapshot.governor.activeLease = null
      snapshot.governor.queued = []
    })
    const normal = runtimeSnapshotFixture()
    const loader = vi
      .fn<(signal: AbortSignal) => Promise<RuntimeSnapshot>>()
      .mockResolvedValueOnce(idle)
      .mockResolvedValueOnce(normal)
    render(<Harness loader={loader} />)
    await act(async () => vi.advanceTimersByTimeAsync(MODEL_PREWARM_DEBOUNCE_MS))
    fireEvent.click(screen.getByRole('button', { name: 'Normal' }))
    await act(async () => Promise.resolve())
    expect(prewarmSignal?.aborted).toBe(true)
    expect(screen.getByTestId('phase').textContent).toBe('cancelled:normal_work_present')
  })
})
