/**
 * P2 (D-203): the runtime poll rebuilds the snapshot every time (new observedAt, a new memory
 * sample), so structural sharing cannot keep its identity. Only the status items may re-render
 * for it; the sidebar and the route content render nothing for a poll that changes nothing they
 * show. Real App, real RuntimeProvider and real wire snapshots; renders are counted at the
 * sidebar component and at the chat route's prewarm hook (called once per ChatPage render).
 */
import { act, render, screen } from '@testing-library/react'
import { SESSION_ROUTES } from '@guanxi/contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActiveLocale } from '../../src/lib/locale.ts'
import { ThemeProvider } from '../../src/lib/theme.tsx'
import { App } from '../../src/App.tsx'
import { RUNTIME_IDLE_POLL_INTERVAL_MS } from '../../src/features/health/useRuntimePolling.ts'
import { browserSettings, runtimeBrowserSnapshot } from '../browser/fixtures/runtime-snapshot.ts'

const counts = vi.hoisted(() => ({ sidebar: 0, route: 0 }))
vi.mock('../../src/features/shell/ShellSidebar.tsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/shell/ShellSidebar.tsx')>()
  return { ...actual, ShellSidebar: (props: Parameters<typeof actual.ShellSidebar>[0]) => { counts.sidebar += 1; return actual.ShellSidebar(props) } }
})
vi.mock('../../src/features/chat/useModelPrewarm.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/chat/useModelPrewarm.ts')>()
  return { ...actual, useModelPrewarm: (options: Parameters<typeof actual.useModelPrewarm>[0]) => { counts.route += 1; return actual.useModelPrewarm(options) } }
})

const observedAt = '2026-10-23T12:00:00.000Z'
const health = {
  ok: true, appVersion: 'test',
  application: { state: 'reachable', source: 'application_http', observedAt },
  ollama: { installed: true, installSource: 'runtime_response', running: true, state: 'reachable', source: 'ollama_api_version', observedAt, version: 'test', host: 'http://127.0.0.1:11434', installHint: null },
  hardware: { platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8, totalMemoryBytes: 16_000_000_000, usableMemoryBytes: 12_000_000_000, accelerator: 'metal', acceleratorName: 'fixture', unifiedMemory: true, freeDiskBytes: null },
  network: { ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked' },
}

let poll = 0
/** A fresh snapshot per poll, as the node builds it: new observation time and memory sample. */
function snapshot() {
  poll += 1
  const at = new Date(Date.parse(observedAt) + poll * RUNTIME_IDLE_POLL_INTERVAL_MS).toISOString()
  const original = runtimeBrowserSnapshot()
  // Every observation in a snapshot shares one time, as the node writes it.
  const base = JSON.parse(JSON.stringify(original).replaceAll(original.observedAt, at)) as typeof original
  const bytes = 8_000_000_000 + poll * 100_000_000
  return {
    ...base,
    host: { ...base.host,
      availableFields: [...base.host.availableFields, 'available_memory_bytes'],
      missingFields: base.host.missingFields.filter((field: string) => field !== 'available_memory_bytes'),
      sample: { ...base.host.sample,
        availableMemoryBytes: { bytes, source: 'apple_host_available_memory', observedAt: at, confidence: 'observed', basis: 'system_available_memory_advisory' } } },
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  setActiveLocale('en')
  poll = 0
  counts.sidebar = 0; counts.route = 0
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input instanceof Request ? input.url : input), window.location.origin).pathname
    if (path === '/api/health') return json(health)
    if (path === '/api/runtime') return json(snapshot())
    if (path === '/api/settings') return json(browserSettings({ locale: 'en', localeSource: 'user_setting' }))
    if (path === '/api/models') return json({ models: [] })
    if (path === '/api/threads/models') return json({ groups: [] })
    if (path === '/api/workspaces') return json({ workspaces: [] })
    if (path === '/api/threads') return json({ ownershipVersion: 1, scope: 'projectless', chats: [] })
    if (path === SESSION_ROUTES.page()) return json({ sessions: [], nextCursor: null, omitted: { withheld: false, catchingUp: false } })
    if (path === '/api/projects') return json({ projects: [] })
    return json({ code: 'internal_error', message: path, details: null }, 500)
  }))
  window.history.replaceState(null, '', '/chat')
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('runtime poll rendering (P2)', () => {
  it('a poll with a new observation time and memory sample re-renders the status items only', async () => {
    render(<ThemeProvider><App /></ThemeProvider>)
    for (let tick = 0; tick < 8; tick++) await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const memory = () => screen.getByRole('button', { name: /^Memory/u }).textContent
    expect(counts.sidebar).toBeGreaterThan(0)
    expect(counts.route).toBeGreaterThan(0)
    const before = { sidebar: counts.sidebar, route: counts.route, memory: memory(), polls: poll }
    for (let round = 0; round < 3; round++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(RUNTIME_IDLE_POLL_INTERVAL_MS) })
    }
    expect(poll).toBeGreaterThanOrEqual(before.polls + 3)
    // The strip shows the new sample …
    expect(memory()).not.toBe(before.memory)
    // … and nothing else rendered for it.
    expect(counts.sidebar).toBe(before.sidebar)
    expect(counts.route).toBe(before.route)
  })
})
