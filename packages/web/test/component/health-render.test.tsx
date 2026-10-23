/**
 * P2 (D-203): the 15 s health poll must not re-render the app when only observation times move.
 * Real health-shaped answers go through the real App, api client and contract validation; the
 * shell and the page are counted at their module boundary.
 */
import { act, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActiveLocale } from '../../src/lib/locale.ts'
import { ThemeProvider } from '../../src/lib/theme.tsx'
import { App } from '../../src/App.tsx'
import { sameHealthFacts } from '../../src/lib/health-facts.ts'

const counts = vi.hoisted(() => ({ shell: 0, page: 0, healthSeen: [] as unknown[] }))
vi.mock('../../src/features/shell/MountedShell.tsx', () => ({
  MountedShell: ({ children, health }: { children: ReactNode; health: unknown }) => {
    counts.shell += 1
    counts.healthSeen.push(health)
    return <div data-testid="shell">{children}</div>
  },
}))
vi.mock('../../src/features/launcher/LauncherPage.tsx', () => ({
  LauncherPage: () => { counts.page += 1; return <p>launcher</p> },
}))
vi.mock('../../src/features/health/RuntimeContext.tsx', () => ({
  RuntimeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

function health(observedAt: string, usableMemoryBytes = 12_000_000_000) {
  return {
    ok: true, appVersion: 'test',
    application: { state: 'reachable', source: 'application_http', observedAt },
    ollama: {
      installed: true, installSource: 'runtime_response', running: true, state: 'reachable',
      source: 'ollama_api_version', observedAt, version: 'test', host: 'http://127.0.0.1:11434', installHint: null,
    },
    hardware: {
      platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8, totalMemoryBytes: 16_000_000_000,
      usableMemoryBytes, accelerator: 'metal', acceleratorName: 'fixture', unifiedMemory: true, freeDiskBytes: null,
    },
    network: { ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked' },
  }
}

let answer = health('2026-10-23T12:00:00.000Z')
beforeEach(() => {
  setActiveLocale('en')
  counts.shell = 0; counts.page = 0; counts.healthSeen = []
  answer = health('2026-10-23T12:00:00.000Z')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input instanceof Request ? input.url : input), window.location.origin).pathname
    if (path === '/api/health') return Response.json(answer)
    return Response.json({ code: 'internal_error', message: path, details: null }, { status: 500 })
  }))
  window.history.replaceState(null, '', '/')
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('health poll rendering (P2)', () => {
  it('a poll that only moves observation times renders nothing; a changed fact renders once', async () => {
    render(<ThemeProvider><App /></ThemeProvider>)
    for (let tick = 0; tick < 5; tick++) await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getAllByText('launcher')).toHaveLength(1)
    const shellBefore = counts.shell, pageBefore = counts.page
    for (const at of ['2026-10-23T12:00:15.000Z', '2026-10-23T12:00:30.000Z', '2026-10-23T12:00:45.000Z']) {
      answer = health(at)
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    }
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/api/health')).length).toBeGreaterThanOrEqual(4)
    expect(counts.shell).toBe(shellBefore)
    expect(counts.page).toBe(pageBefore)
    answer = health('2026-10-23T12:01:00.000Z', 11_000_000_000)
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(counts.shell).toBe(shellBefore + 1)
    expect((counts.healthSeen.at(-1) as { hardware: { usableMemoryBytes: number } }).hardware.usableMemoryBytes).toBe(11_000_000_000)
  })

  it('compares health facts without observation times', () => {
    const first = health('2026-10-23T12:00:00.000Z') as never
    expect(sameHealthFacts(first, health('2026-10-23T12:00:15.000Z') as never)).toBe(true)
    expect(sameHealthFacts(first, health('2026-10-23T12:00:15.000Z', 11_000_000_000) as never)).toBe(false)
    expect(sameHealthFacts(null, first)).toBe(false)
  })
})
