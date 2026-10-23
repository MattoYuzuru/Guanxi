import { fireEvent, render, screen, within } from '@testing-library/react'
import { PRODUCT_NAME, type Health } from '@guanxi/contract'
import { describe, expect, it } from 'vitest'
import { ShellBreadcrumb, ShellStatusItems } from '../../src/features/shell/ShellStatus.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'
import { formatBytes, formatTime } from '../../src/lib/format.ts'
import { runtimeSnapshotFixture } from '../fixtures/runtime.ts'

const observedAt = '2026-10-22T12:00:00.000Z'
const health = (state: 'reachable' | 'unavailable' | 'incompatible' = 'reachable'): Health => ({
  ok: true,
  appVersion: 'test',
  application: { state: 'reachable', source: 'application_http', observedAt },
  ollama: {
    installed: true, installSource: 'runtime_response', running: state === 'reachable', state,
    source: 'ollama_api_version', observedAt, version: 'test', host: 'http://127.0.0.1:11434',
    installHint: state === 'unavailable' ? { command: 'ollama serve', docsUrl: 'https://ollama.com' } : null,
  },
  hardware: {
    platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8, totalMemoryBytes: 16_000_000_000,
    usableMemoryBytes: 12_000_000_000, accelerator: 'metal', acceleratorName: 'fixture', unifiedMemory: true, freeDiskBytes: null,
  },
  network: { ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked' },
} as Health)

const triggers = () => within(screen.getByTestId('shell-status-items')).getAllByRole('button')

describe('shell status items (D-202, D-203, D-204)', () => {
  it('renders the centralized product brand through English and Russian locale lookup', () => {
    setActiveLocale('en')
    const english = render(<ShellBreadcrumb page="Projects" />)
    expect(screen.getByRole('link', { name: PRODUCT_NAME })).toBeTruthy()
    expect(screen.getByText('Projects').getAttribute('aria-current')).toBe('page')
    english.unmount()
    setActiveLocale('ru')
    render(<ShellBreadcrumb page="Проекты" />)
    expect(screen.getByRole('link', { name: PRODUCT_NAME })).toBeTruthy()
    setActiveLocale('en')
  })

  it('shows every unsampled fact as an icon named Unknown, never 0, with no mode switch and no Retry', () => {
    setActiveLocale('en')
    const { container } = render(<ShellStatusItems runtime={null} stale={false} health={health()} />)
    const names = triggers().map(button => button.getAttribute('aria-label'))
    expect(names).toEqual(['This device: Unknown', 'Memory: Unknown', 'Runtime: Unknown', 'Quota: Unknown', 'Keep awake: Unknown', 'Power: Unknown'])
    expect(container.textContent).not.toMatch(/\b0\b/u)
    // The Developer/Visual split is gone (D-204) and nothing offers a manual reload (D-203).
    expect(screen.queryAllByRole('button', { name: /^(Developer|Visual)$/u })).toHaveLength(0)
    expect(screen.queryAllByText('Open a workspace first.')).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: /retry|refresh/iu })).toHaveLength(0)
  })

  it('emphasises the available memory and keeps source, time and the stale state in one sentence without middle dots', () => {
    setActiveLocale('en')
    const runtime = runtimeSnapshotFixture()
    render(<ShellStatusItems runtime={runtime} stale health={health()} />)
    const available = runtime.host.sample.availableMemoryBytes.bytes
    const stale = `(last sample ${formatTime(runtime.observedAt)})`
    // A stale value keeps its number but is marked and named as the last sample, never as current.
    const memory = screen.getByRole('button', { name: available === null ? 'Memory: Unknown' : `Memory: ${formatBytes(available)} ${stale}` })
    if (available !== null) expect(memory.querySelector('.gx-status-item-value')?.textContent).toBe(formatBytes(available))
    expect(memory.closest('[data-slot="status-item"]')?.hasAttribute('data-stale')).toBe(true)
    expect(memory.querySelectorAll('.gx-status-item-unknown')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: `This device ${stale}` }))
    const device = screen.getByRole('dialog')
    expect(within(device).getByText(`${runtime.host.profile.platform} ${runtime.host.profile.arch}`)).toBeTruthy()
    const footnote = device.querySelector('.gx-popover-footnote')!
    expect(footnote.textContent).toContain(formatTime(runtime.observedAt))
    expect(footnote.textContent).toContain('did not answer the latest read')
    expect(device.textContent).not.toContain('·')
    expect(within(device).queryAllByRole('button', { name: /retry|refresh/iu })).toHaveLength(0)
  })

  it('marks a stale health answer on the runtime icon', () => {
    setActiveLocale('en')
    render(<ShellStatusItems runtime={null} stale={false} health={health()} healthStale />)
    expect(screen.getByRole('button', { name: 'Runtime: Unknown (last health answer kept)' })).toBeTruthy()
  })

  it('marks an unreachable Ollama on the runtime icon and says what to do, without a Retry', () => {
    setActiveLocale('en')
    render(<ShellStatusItems runtime={runtimeSnapshotFixture()} stale={false} health={health('unavailable')} />)
    // The state is in the name and the visible value, not only in the colour and the dot.
    const runtime = screen.getByRole('button', { name: 'Runtime: Ollama off' })
    expect(runtime.closest('[data-slot="status-item"]')?.getAttribute('data-tone')).toBe('warning')
    expect(runtime.querySelectorAll('.gx-icon-button-badge')).toHaveLength(1)
    fireEvent.click(runtime)
    const popover = screen.getByTestId('shell-runtime-popover')
    expect(popover.textContent).toContain('Ollama is not reachable')
    expect(within(popover).getByText('ollama serve')).toBeTruthy()
    expect(popover.textContent).toContain('Guanxi checks again by itself.')
    expect(within(popover).queryAllByRole('button', { name: /retry|check again/iu })).toHaveLength(0)
  })

  it('puts the supplied inbox entry after the facts and keeps quota, keep-awake and power unknown', () => {
    setActiveLocale('en')
    render(<ShellStatusItems runtime={runtimeSnapshotFixture()} stale={false} health={health()} inbox={<a href="/notifications">3 unread</a>} />)
    expect(screen.getByRole('button', { name: 'Runtime' }).closest('[data-slot="status-item"]')?.hasAttribute('data-stale')).toBe(false)
    expect(within(screen.getByTestId('shell-status-items')).getByRole('link', { name: '3 unread' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /: Unknown$/u }).map(button => button.getAttribute('aria-label')))
      .toEqual(['Quota: Unknown', 'Keep awake: Unknown', 'Power: Unknown'])
  })
})
