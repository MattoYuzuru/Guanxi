import { fireEvent, render, screen, within } from '@testing-library/react'
import type { CatalogSourceHealth, Health, RuntimeCurrentFitReason } from '@guanxi/contract'
import { describe, expect, it } from 'vitest'
import { RuntimeDetails } from '../../src/features/health/RuntimeStatus.tsx'
import { ShellStatusItems } from '../../src/features/shell/ShellStatus.tsx'
import { CatalogSourceNotice } from '../../src/features/launcher/LauncherPage.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'
import {
  RUNTIME_OBSERVED_AT,
  runtimeActiveLease,
  linuxNvidiaRuntimeSnapshot,
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
      installSource: state !== 'unavailable' ? 'runtime_response' : null,
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

/** The runtime popover body (D-202): the same projections the runtime bar used to disclose. */
function renderRuntime(data = runtimeSnapshotFixture()) {
  return render(<RuntimeDetails snapshot={data} stale={false} />)
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
      snapshot.decisions = snapshot.decisions.slice(0, 1)
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
        snapshot.decisions = snapshot.decisions.slice(0, 1)
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

  it('groups every NVIDIA device with sourced totals/free VRAM and redacted identity', () => {
    renderRuntime(linuxNvidiaRuntimeSnapshot())
    const devices = screen.getByRole('region', { name: 'Устройства NVIDIA' })
    expect(within(devices).getByText('NVIDIA RTX 4090')).toBeTruthy()
    expect(within(devices).getByText('NVIDIA Тестовая GPU')).toBeTruthy()
    expect(devices.textContent).toContain('Индекс устройства у провайдера:2')
    expect(devices.textContent).toContain('Индекс устройства у провайдера:7')
    expect(devices.textContent).toContain('GPU-…12345678')
    expect(devices.textContent).not.toContain('GPU-sensitive-first')
    expect(devices.textContent).toMatch(/Текущая свободная VRAM устройства:0\s*Б/u)
    expect(devices.textContent).toContain('наблюдение из указанного источника')
    expect(devices.textContent).toContain('фиксированный запрос GPU через nvidia-smi')
    expect(devices.textContent).toContain('Наблюдалось:')
    expect(
      screen.getAllByText('Точная identity модели, runtime, контекста и железа неполна').length,
    ).toBe(2)
    expect(screen.getAllByText('Неизвестен').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Это наблюдение не гарантирует fit/).length).toBe(2)
  })

  it('localizes all NVIDIA source states without turning unavailable into empty healthy devices', () => {
    const cases = [
      ['available' as const, 'Телеметрия NVIDIA доступна'],
      ['partial' as const, 'Телеметрия NVIDIA неполна'],
      ['unavailable' as const, 'Телеметрия NVIDIA недоступна'],
    ] as const
    for (const [state, label] of cases) {
      const view = renderRuntime(linuxNvidiaRuntimeSnapshot(state))
      expect(view.container.textContent).toContain(label)
      if (state === 'unavailable') {
        expect(screen.queryByRole('region', { name: 'Устройства NVIDIA' })).toBeNull()
      }
      view.unmount()
    }

    const legacy = renderRuntime(runtimeSnapshotFixture((snapshot) => {
      snapshot.host.nvidia = {
        state: 'unknown', source: 'none', observedAt: snapshot.observedAt,
        devices: [], reason: 'legacy_snapshot',
      }
    }))
    expect(legacy.container.textContent).toContain('неизвестна для этого старого снимка')
    legacy.unmount()

    const unsupported = renderRuntime()
    expect(unsupported.container.textContent).toContain('Телеметрия NVIDIA не поддерживается')
  })

  it('uses English source copy and exposes safe failure reasons', () => {
    setActiveLocale('en')
    const partial = renderRuntime(linuxNvidiaRuntimeSnapshot('partial'))
    expect(partial.container.textContent).toContain('NVIDIA telemetry partial')
    expect(partial.container.textContent).toContain('one or more returned GPU rows were unusable')
    expect(partial.container.textContent).toContain('not safe capacity or a future-admission guarantee')
    partial.unmount()

    const unavailable = renderRuntime(linuxNvidiaRuntimeSnapshot('unavailable'))
    expect(unavailable.container.textContent).toContain('NVIDIA telemetry unavailable')
    expect(unavailable.container.textContent).toContain('no returned GPU row was usable')
    expect(screen.queryByRole('region', { name: 'NVIDIA devices' })).toBeNull()
  })

  it('renders every returned NVIDIA device inside one contained list without a UI ceiling', () => {
    const snapshot = linuxNvidiaRuntimeSnapshot()
    const prototype = snapshot.host.nvidia.devices[0]!
    snapshot.host.nvidia.devices = Array.from({ length: 257 }, (_, index) => ({
      ...structuredClone(prototype),
      providerIndex: index * 2,
      uuid: `GPU-component-${String(index).padStart(12, '0')}`,
      displayName: `NVIDIA device ${index}`,
    }))
    renderRuntime(snapshot)
    const devices = screen.getByRole('region', { name: 'Устройства NVIDIA' })
    expect(within(devices).getAllByRole('listitem')).toHaveLength(257)
    expect(within(devices).getByText('NVIDIA device 256')).toBeTruthy()
    expect(within(devices).getByRole('list').className).toContain('overflow-y-auto')
  })

  it('keeps the confirmed NVIDIA sample unchanged when a later read fails, and leaks no error text', () => {
    const data = linuxNvidiaRuntimeSnapshot()
    const view = render(<RuntimeDetails snapshot={data} stale={false} />)
    const before = screen.getByRole('region', { name: 'Устройства NVIDIA' }).textContent
    view.rerender(<RuntimeDetails snapshot={data} stale />)
    expect(screen.getByRole('region', { name: 'Устройства NVIDIA' }).textContent).toBe(before)
    expect(view.container.textContent).not.toContain('/Users/private')
  })

  it('updates in place with no refreshing caption, no transition alert and no Retry (D-203)', () => {
    const data = runtimeSnapshotFixture()
    const view = render(<RuntimeDetails snapshot={data} stale={false} />)
    expect(view.container.textContent).toContain('fixture:latest')
    view.rerender(<RuntimeDetails snapshot={data} stale />)
    expect(view.container.textContent).toContain('fixture:latest')
    expect(screen.queryAllByRole('status')).toHaveLength(0)
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: /retry|повтор/iu })).toHaveLength(0)
  })

  it('says it is checking before the first sample, and that the node did not answer when none arrived', () => {
    setActiveLocale('en')
    const view = render(<RuntimeDetails snapshot={null} stale={false} />)
    expect(screen.getByRole('status').textContent).toBe('Checking the current runtime sample…')
    view.rerender(<RuntimeDetails snapshot={null} stale />)
    expect(screen.getByRole('status').textContent).not.toBe('Checking the current runtime sample…')
    setActiveLocale('ru')
  })

  it('opens from the runtime status icon with English fallback and curated Russian copy', () => {
    setActiveLocale('en')
    const english = render(<ShellStatusItems runtime={runtimeSnapshotFixture()} stale={false} health={health('reachable')} />)
    const trigger = screen.getByRole('button', { name: 'Runtime' })
    trigger.focus()
    expect(document.activeElement).toBe(trigger)
    fireEvent.click(trigger)
    expect(screen.getByRole('region', { name: 'Runtime and resources' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Live admission' })).toBeTruthy()
    english.unmount()

    setActiveLocale('ru')
    renderRuntime()
    expect(screen.getByRole('heading', { name: 'Текущий admission' })).toBeTruthy()
  })
})

describe('shell health projection', () => {
  it('keeps the shell-oriented Ollama degraded states distinct on the runtime icon', () => {
    const unavailable = render(<ShellStatusItems runtime={runtimeSnapshotFixture()} stale={false} health={health('unavailable')} />)
    const warning = screen.getByRole('button', { name: 'Среда выполнения: Ollama выкл.' })
    expect(warning.closest('[data-slot="status-item"]')?.getAttribute('data-tone')).toBe('warning')
    fireEvent.click(warning)
    expect(screen.getByRole('status').textContent).toContain('Ollama недоступна')
    unavailable.unmount()

    render(<ShellStatusItems runtime={runtimeSnapshotFixture()} stale={false} health={health('incompatible')} />)
    const danger = screen.getByRole('button', { name: 'Среда выполнения: Не поддерж.' })
    expect(danger.closest('[data-slot="status-item"]')?.getAttribute('data-tone')).toBe('danger')
    fireEvent.click(danger)
    expect(screen.getByRole('alert').textContent).toContain('не поддерживается')
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
