import { fireEvent, render, screen, within } from '@testing-library/react'
import type { CatalogSourceHealth, Health, RuntimeCurrentFitReason } from '@alamo/contract'
import { describe, expect, it, vi } from 'vitest'
import { OllamaHealthNotice } from '../../src/features/health/HealthGate.tsx'
import { RuntimeStatusView } from '../../src/features/health/RuntimeStatus.tsx'
import { CatalogSourceNotice } from '../../src/features/launcher/LauncherPage.tsx'
import {
  RUNTIME_OBSERVED_AT,
  runtimeActiveLease,
  runtimeModel,
  runtimeSnapshotFixture,
} from '../fixtures/runtime.ts'

function health(state: 'reachable' | 'unavailable' | 'incompatible'): Health {
  return {
    ok: true,
    appVersion: 'test',
    application: {
      state: 'reachable',
      source: 'application_http',
      observedAt: RUNTIME_OBSERVED_AT,
    },
    ollama: {
      installed: state !== 'unavailable',
      running: state === 'reachable',
      state,
      source: 'ollama_api_version',
      observedAt: RUNTIME_OBSERVED_AT,
      version: state === 'reachable' ? '0.1' : null,
      host: 'http://fixture.invalid',
      installHint: null,
    },
    hardware: {
      platform: 'darwin',
      arch: 'arm64',
      cpuModel: 'fixture',
      cpuCores: 8,
      totalMemoryBytes: 16_000_000_000,
      usableMemoryBytes: 12_000_000_000,
      accelerator: 'metal',
      acceleratorName: 'fixture',
      unifiedMemory: true,
      freeDiskBytes: null,
    },
    network: {
      ollamaComReachable: null,
      checkedAt: null,
      status: 'unknown',
      source: 'not_checked',
    },
  }
}

function renderRuntime(data = runtimeSnapshotFixture()) {
  const view = render(
    <RuntimeStatusView
      data={data}
      error={null}
      loading={false}
      refreshing={false}
      onRetry={() => undefined}
    />,
  )
  fireEvent.click(screen.getByText('Показать сведения о runtime'))
  return view
}

describe('Runtime Bar projection', () => {
  it('round-trips active Job ownership, multiple FIFO waiters, exact and unknown-owner rows', () => {
    renderRuntime()

    expect(screen.getByRole('region', { name: 'Runtime и ресурсы' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Текущий admission' })).toBeTruthy()
    expect(screen.getByText('Владелец — Job')).toBeTruthy()
    expect(screen.getByText(/Позиция 1/)).toBeTruthy()
    expect(screen.getByText(/Позиция 2/)).toBeTruthy()
    expect(screen.getByText(/возможен внешний клиент, но это не доказано/)).toBeTruthy()
    expect(screen.getByText(/identity артефакта остаётся неизвестной/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Job|операц/u })).toBeNull()
  })

  it('shows prewarm purpose and lowest priority without claiming a durable Job owner', () => {
    renderRuntime(
      runtimeSnapshotFixture((snapshot) => {
        snapshot.governor.queued = []
        if (snapshot.governor.activeLease) {
          snapshot.governor.activeLease.operation = 'model_prewarm'
          snapshot.governor.activeLease.priority = 'prewarm'
          snapshot.governor.activeLease.owner = {
            kind: 'operation',
            operationId: 'model_prewarm:fixture',
          }
        }
      }),
    )

    expect(screen.getAllByText('Автоматический prewarm модели').length).toBeGreaterThan(0)
    expect(screen.getByText('Prewarm (самый низкий)')).toBeTruthy()
    expect(screen.getByText('Владелец — runtime-операция')).toBeTruthy()
    expect(screen.queryByText('Владелец — Job')).toBeNull()
  })

  it('shows operation owner, idle and closed admission without inventing durable Job history', () => {
    const operation = renderRuntime(
      runtimeSnapshotFixture((snapshot) => {
        snapshot.governor.activeLease = runtimeActiveLease({
          kind: 'operation',
          operationId: 'operation-fixture',
        })
        snapshot.governor.queued = []
      }),
    )
    expect(screen.getByText('Владелец — runtime-операция')).toBeTruthy()
    expect(screen.getByText(/это не история durable Jobs/)).toBeTruthy()
    expect(screen.getByText(/не число hardware devices/)).toBeTruthy()
    operation.unmount()

    renderRuntime(
      runtimeSnapshotFixture((snapshot) => {
        snapshot.governor.activeLease = null
        snapshot.governor.queued = []
        snapshot.governor.accepting = false
        snapshot.models = []
        snapshot.decisions = [
          {
            code: 'empty_sample',
            modelName: null,
            normalizedModelName: null,
            leaseId: null,
            owner: null,
            runtimeDigest: null,
            requestedContext: null,
            observedContext: null,
            identityBasis: 'none',
            artifactIdentity: 'unknown',
          },
        ]
      }),
    )
    expect(screen.getByText('Admission закрыт')).toBeTruthy()
    expect(screen.getByText('В этом sample активный lease не зафиксирован.')).toBeTruthy()
    expect(screen.getByText('Ожидающих live-операций нет.')).toBeTruthy()
  })

  it('distinguishes healthy empty, unavailable, and incompatible Ollama samples', () => {
    const states = [
      runtimeSnapshotFixture((snapshot) => {
        snapshot.governor.activeLease = null
        snapshot.governor.queued = []
        snapshot.models = []
        snapshot.decisions = [{
          code: 'empty_sample', modelName: null, normalizedModelName: null, leaseId: null,
          owner: null, runtimeDigest: null, requestedContext: null, observedContext: null,
          identityBasis: 'none', artifactIdentity: 'unknown',
        }]
      }),
      runtimeSnapshotFixture((snapshot) => {
        snapshot.source = { state: 'unavailable', source: 'ollama_api_ps', observedAt: RUNTIME_OBSERVED_AT, errorCode: 'ollama_unavailable' }
        snapshot.models = null
        snapshot.decisions = [{
          code: 'source_failure', modelName: null, normalizedModelName: null, leaseId: null,
          owner: null, runtimeDigest: null, requestedContext: null, observedContext: null,
          identityBasis: 'none', artifactIdentity: 'unknown',
        }]
      }),
      runtimeSnapshotFixture((snapshot) => {
        snapshot.source = { state: 'incompatible', source: 'ollama_api_ps', observedAt: RUNTIME_OBSERVED_AT, errorCode: 'runtime_protocol' }
        snapshot.models = null
        snapshot.decisions = [{
          code: 'source_failure', modelName: null, normalizedModelName: null, leaseId: null,
          owner: null, runtimeDigest: null, requestedContext: null, observedContext: null,
          identityBasis: 'none', artifactIdentity: 'unknown',
        }]
      }),
    ]
    const expected = [
      'Загруженные модели не наблюдались',
      'Состояние моделей неизвестно, а не пусто',
      'Ответ Ollama несовместим',
    ]

    for (let index = 0; index < states.length; index += 1) {
      const view = renderRuntime(states[index])
      expect(view.container.textContent).toContain(expected[index])
      view.unmount()
    }
  })

  it('distinguishes available-with-missing, partial, unavailable, and unsupported host telemetry', () => {
    const cases = [
      { state: 'available' as const, expected: 'доступна с неизвестными полями', errorCode: null },
      { state: 'partial' as const, expected: 'Host telemetry неполна', errorCode: 'host_probe_malformed' as const },
      { state: 'unavailable' as const, expected: 'Host telemetry недоступна', errorCode: 'host_probe_failed' as const },
      { state: 'unsupported' as const, expected: 'Host telemetry не поддерживается', errorCode: null },
    ]

    for (const fixture of cases) {
      const view = renderRuntime(runtimeSnapshotFixture((snapshot) => {
        snapshot.host.state = fixture.state
        snapshot.host.errorCode = fixture.errorCode
        if (fixture.state === 'unsupported') snapshot.host.sample.source = 'none'
      }))
      expect(view.container.textContent).toContain(fixture.expected)
      view.unmount()
    }
  })

  it('labels current residency as observed without promising future admission', () => {
    renderRuntime(runtimeSnapshotFixture((snapshot) => {
      snapshot.models = [runtimeModel('active_lease', 'observed')]
      snapshot.decisions = [snapshot.decisions[0]]
    }))

    expect(screen.getByText('Только текущая загруженная конфигурация/residency')).toBeTruthy()
    expect(screen.getByText(/не гарантирует fit при будущем admission/)).toBeTruthy()
    expect(screen.getByText(/Выделено runtime/)).toBeTruthy()
    expect(screen.getByText(/Выделено на ускорителе/)).toBeTruthy()
  })

  it('turns stable unknown fit reasons into human-readable explanations', () => {
    const reasons: Array<[Exclude<RuntimeCurrentFitReason, 'observed_current_residency'>, string]> = [
      ['runtime_digest_missing', 'Runtime не сообщил digest'],
      ['runtime_context_missing', 'Runtime не сообщил контекст'],
      ['host_unavailable', 'Host telemetry недоступна'],
      ['host_pressure_unknown', 'Текущий memory pressure неизвестен'],
    ]

    for (const [reason, label] of reasons) {
      const view = renderRuntime(runtimeSnapshotFixture((snapshot) => {
        const model = runtimeModel('active_lease', 'unknown')
        if (model.currentFit.state === 'unknown') model.currentFit.reason = reason
        snapshot.models = [model]
        snapshot.decisions = [snapshot.decisions[0]]
      }))
      expect(view.container.textContent).toContain(label)
      expect(view.container.textContent).not.toContain(reason)
      view.unmount()
    }
  })

  it('keeps memory facts distinct and never formats null as zero', () => {
    renderRuntime()
    const host = screen.getByRole('region', { name: 'Host telemetry' })
    expect(host.textContent).toContain('Всего unified/system memory')
    expect(host.textContent).toContain('Свободные system pages')
    expect(host.textContent).toContain('Старая оценка usable memory')
    expect(host.textContent).toContain('free pages, не safe capacity для новой модели')
    expect(host.textContent).toContain('compatibility estimate, не текущая доступность')
    expect(host.textContent).toContain('Discrete VRAM:Неизвестно')
    expect(host.textContent).not.toContain('Discrete VRAM:0')
    expect(host.textContent).toContain('не сообщает количество accelerator devices')
  })

  it('keeps confirmed content during refresh/failure and exposes only transition alerts', () => {
    const retry = vi.fn()
    const data = runtimeSnapshotFixture()
    const view = render(
      <RuntimeStatusView data={data} error={null} loading={false} refreshing onRetry={retry} />,
    )
    expect(screen.getByRole('status').textContent).toContain('последний подтверждённый sample')
    expect(view.container.textContent).toContain('fixture:latest')
    view.rerender(
      <RuntimeStatusView
        data={data}
        error={new Error('secret endpoint /api/runtime?token=private')}
        loading={false}
        refreshing={false}
        onRetry={retry}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('sample устарел')
    expect(view.container.textContent).toContain('fixture:latest')
    expect(view.container.textContent).not.toContain('secret endpoint')
    fireEvent.click(screen.getByRole('button', { name: 'Повторить runtime-проверку' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('provides keyboard disclosure plus English fallback and curated Russian copy', () => {
    document.documentElement.lang = 'fr'
    const english = render(
      <RuntimeStatusView
        data={runtimeSnapshotFixture()}
        error={null}
        loading={false}
        refreshing={false}
        onRetry={() => undefined}
      />,
    )
    expect(screen.getByRole('region', { name: 'Runtime and resources' })).toBeTruthy()
    const disclosure = screen.getByText('Show runtime details')
    disclosure.focus()
    expect(document.activeElement).toBe(disclosure)
    fireEvent.click(disclosure)
    expect(screen.getByRole('heading', { name: 'Live admission' })).toBeTruthy()
    english.unmount()

    document.documentElement.lang = 'ru'
    renderRuntime()
    expect(screen.getByRole('heading', { name: 'Текущий admission' })).toBeTruthy()
  })
})

describe('shell health projection', () => {
  it('keeps the shell-oriented Ollama degraded states distinct', () => {
    const unavailable = render(
      <OllamaHealthNotice health={health('unavailable')} onRetry={() => undefined} retrying={false} />,
    )
    expect(within(unavailable.container).getByText('Ollama недоступна')).toBeTruthy()
    unavailable.unmount()

    render(
      <OllamaHealthNotice health={health('incompatible')} onRetry={() => undefined} retrying={false} />,
    )
    expect(screen.getByRole('alert').textContent).toContain('несовместимый ответ')
  })
})

describe('catalog source projection', () => {
  it('distinguishes stale cache, bundled fallback, unavailable, and unknown', () => {
    const cases: Array<{ source: CatalogSourceHealth | null; expected: string }> = [
      {
        source: { state: 'stale_cache', source: 'ollama_recommendations_cache', observedAt: RUNTIME_OBSERVED_AT, fetchedAt: '2026-07-30T12:00:00.000Z' },
        expected: 'Устаревший локальный cache каталога',
      },
      {
        source: { state: 'bundled_fallback', source: 'bundled_snapshot', observedAt: RUNTIME_OBSERVED_AT, fetchedAt: RUNTIME_OBSERVED_AT },
        expected: 'Встроенный fallback каталога',
      },
      {
        source: { state: 'unavailable', source: 'none', observedAt: RUNTIME_OBSERVED_AT, fetchedAt: null },
        expected: 'Источник каталога недоступен',
      },
      { source: null, expected: 'Свежесть каталога неизвестна' },
    ]

    for (const fixture of cases) {
      const view = render(<CatalogSourceNotice source={fixture.source} />)
      expect(within(view.container).getByText(fixture.expected)).toBeTruthy()
      view.unmount()
    }
  })
})
