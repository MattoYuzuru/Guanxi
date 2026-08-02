import { fireEvent, render, screen, within } from '@testing-library/react'
import type { CatalogSourceHealth, Health, ListRunningResponse } from '@alamo/contract'
import { describe, expect, it, vi } from 'vitest'
import {
  OllamaHealthNotice,
} from '../../src/features/health/HealthGate.tsx'
import {
  RuntimeStatusView,
} from '../../src/features/health/RuntimeStatus.tsx'
import {
  CatalogSourceNotice,
} from '../../src/features/launcher/LauncherPage.tsx'

const OBSERVED_AT = '2026-08-02T12:00:00.000Z'

function health(state: 'reachable' | 'unavailable' | 'incompatible'): Health {
  return {
    ok: true,
    appVersion: 'test',
    application: {
      state: 'reachable',
      source: 'application_http',
      observedAt: OBSERVED_AT,
    },
    ollama: {
      installed: state !== 'unavailable',
      running: state === 'reachable',
      state,
      source: 'ollama_api_version',
      observedAt: OBSERVED_AT,
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

function runtimeData(models: ListRunningResponse['models']): ListRunningResponse {
  return { models, observedAt: OBSERVED_AT }
}

describe('runtime health projection', () => {
  it('announces checking and an empty sampled observation without claiming unload', () => {
    const checking = render(
      <RuntimeStatusView
        data={null}
        error={null}
        loading
        refreshing={false}
        onRetry={() => undefined}
      />,
    )
    expect(within(checking.container).getByRole('status').textContent).toContain(
      'Проверяем текущий sample /api/ps',
    )
    checking.unmount()

    render(
      <RuntimeStatusView
        data={runtimeData([])}
        error={null}
        loading={false}
        refreshing={false}
        onRetry={() => undefined}
      />,
    )
    expect(screen.getByText('Загруженные модели не наблюдались')).toBeTruthy()
    expect(screen.getByText(/не доказывает, что происходило между наблюдениями/)).toBeTruthy()
  })

  it('shows only sampled running facts with source and observation time', () => {
    render(
      <RuntimeStatusView
        data={runtimeData([
          {
            name: 'fixture:latest',
            digest: 'sha256:fixture',
            sizeBytes: 1_000_000,
            sizeVramBytes: null,
            gpuPercent: null,
            processorLabel: null,
            contextLength: 8_192,
            expiresAt: null,
            source: 'ollama_api_ps',
            observedAt: OBSERVED_AT,
          },
        ])}
        error={null}
        loading={false}
        refreshing={false}
        onRetry={() => undefined}
      />,
    )

    const row = screen.getByRole('listitem')
    expect(within(row).getByText('fixture:latest')).toBeTruthy()
    expect(row.textContent).toContain('ollama_api_ps')
    expect(row.textContent).toContain('Контекст:')
    expect(row.textContent).not.toContain('owner')
    expect(row.textContent).not.toContain('fit')
  })

  it('keeps a failed /api/ps sample degraded and keyboard-retryable', () => {
    const retry = vi.fn()
    render(
      <RuntimeStatusView
        data={null}
        error={new Error('fixture unavailable')}
        loading={false}
        refreshing={false}
        onRetry={retry}
      />,
    )

    expect(screen.getByRole('alert').textContent).toContain(
      'Состояние загруженных моделей недоступно',
    )
    const button = screen.getByRole('button', { name: 'Повторить runtime-проверку' })
    button.focus()
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('keeps the shell-oriented Ollama degraded states distinct', () => {
    const unavailable = render(
      <OllamaHealthNotice
        health={health('unavailable')}
        onRetry={() => undefined}
        retrying={false}
      />,
    )
    expect(within(unavailable.container).getByText('Ollama недоступна')).toBeTruthy()
    expect(unavailable.container.textContent).toContain('ollama_api_version')
    unavailable.unmount()

    render(
      <OllamaHealthNotice
        health={health('incompatible')}
        onRetry={() => undefined}
        retrying={false}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('несовместимый ответ')
  })
})

describe('catalog source projection', () => {
  it('distinguishes stale cache, bundled fallback, unavailable, and unknown', () => {
    const cases: Array<{
      source: CatalogSourceHealth | null
      expected: string
    }> = [
      {
        source: {
          state: 'stale_cache',
          source: 'ollama_recommendations_cache',
          observedAt: OBSERVED_AT,
          fetchedAt: '2026-07-30T12:00:00.000Z',
        },
        expected: 'Устаревший локальный cache каталога',
      },
      {
        source: {
          state: 'bundled_fallback',
          source: 'bundled_snapshot',
          observedAt: OBSERVED_AT,
          fetchedAt: OBSERVED_AT,
        },
        expected: 'Встроенный fallback каталога',
      },
      {
        source: {
          state: 'unavailable',
          source: 'none',
          observedAt: OBSERVED_AT,
          fetchedAt: null,
        },
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
