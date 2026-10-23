import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationBell } from '../../src/features/notifications/NotificationBell.tsx'
import { NotificationsPage } from '../../src/features/notifications/NotificationsPage.tsx'
import { NotificationsProvider } from '../../src/features/notifications/NotificationsProvider.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'
import { FakeNode, T0, notification, notificationId } from '../fixtures/notifications-server.ts'
import { counterKeys, installNodeFetch } from '../helpers/notifications-fetch.ts'

const LIST = /^GET \/api\/notifications$/u
const NOW = T0 + 3_600_000

beforeEach(() => {
  setActiveLocale('en')
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  window.history.replaceState(null, '', '/notifications')
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const timers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const mountProvider = (node: FakeNode, props: { pollMs: number; maxPollMs: number }) => {
  installNodeFetch(node)
  return render(<NotificationsProvider {...props} newKey={counterKeys()}><NotificationBell /></NotificationsProvider>)
}

describe('polling schedule', () => {
  it('backs off exponentially on failed ticks up to the cap, and returns to the base interval after a success', async () => {
    timers()
    const node = new FakeNode([notification(1)])
    node.unreachable = true
    mountProvider(node, { pollMs: 1000, maxPollMs: 8000 })
    await advance(0)
    expect(node.count(LIST)).toBe(1) // the first read fails: next delay 2000
    await advance(1999)
    expect(node.count(LIST)).toBe(1)
    await advance(1)
    expect(node.count(LIST)).toBe(2) // fails again: next delay 4000
    await advance(3999)
    expect(node.count(LIST)).toBe(2)
    await advance(1)
    expect(node.count(LIST)).toBe(3) // next delay 8000, the cap
    await advance(8000)
    expect(node.count(LIST)).toBe(4)
    await advance(7999)
    expect(node.count(LIST)).toBe(4) // still the cap, not 16000 and not shorter
    node.unreachable = false
    await advance(1)
    expect(node.count(LIST)).toBe(5) // succeeds: next delay is the base again
    await advance(999)
    expect(node.count(LIST)).toBe(5)
    await advance(1)
    expect(node.count(LIST)).toBe(6)
    expect(screen.getByTestId('notification-bell-count').textContent).toBe('1 unread')
  })

  it('does not read while the document is hidden, and reads once when it becomes visible again', async () => {
    timers()
    const node = new FakeNode([notification(1)])
    mountProvider(node, { pollMs: 1000, maxPollMs: 8000 })
    await advance(0)
    expect(node.count(LIST)).toBe(1)
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await advance(10_000)
    expect(node.count(LIST)).toBe(1)
    state.mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await advance(0)
    expect(node.count(LIST)).toBe(2)
    await advance(1000)
    expect(node.count(LIST)).toBe(3)
  })

  it('stops completely on unmount: no timer left and no read after it', async () => {
    timers()
    const node = new FakeNode([notification(1)])
    const view = mountProvider(node, { pollMs: 1000, maxPollMs: 8000 })
    await advance(0)
    expect(node.count(LIST)).toBe(1)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
    await advance(60_000)
    expect(node.count(LIST)).toBe(1)
  })

  it('unmounting while a read is in flight schedules nothing afterwards', async () => {
    timers()
    const node = new FakeNode([notification(1)])
    const release = node.hold(LIST)
    const view = mountProvider(node, { pollMs: 1000, maxPollMs: 8000 })
    await advance(0)
    view.unmount()
    release()
    await advance(60_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(node.count(LIST)).toBe(1)
  })
})

describe('dead node behind a dev proxy', () => {
  it('an empty 5xx or a gateway status is offline, not a generic server error', async () => {
    for (const failure of [{ status: 500, body: '' }, { status: 502, body: '' }, { status: 504, body: '' }]) {
      const node = new FakeNode([notification(1)])
      node.failWhile(LIST, failure)
      installNodeFetch(node)
      const view = render(<NotificationsProvider pollMs={3_600_000}><NotificationBell /><NotificationsPage /></NotificationsProvider>)
      const banner = await screen.findByTestId('notifications-offline')
      expect(banner.textContent).toContain('node_unreachable')
      expect(screen.queryByTestId('notifications-error')).toBeNull()
      view.unmount()
    }
  })

  it('a parseable answer from the node stays a server answer', async () => {
    const node = new FakeNode([notification(1)])
    node.failWhile(LIST, { status: 503, body: { code: 'notifications_unavailable' } })
    installNodeFetch(node)
    render(<NotificationsProvider pollMs={3_600_000}><NotificationBell /><NotificationsPage /></NotificationsProvider>)
    expect((await screen.findByTestId('notifications-error')).textContent).toContain('notifications_unavailable')
    expect(screen.queryByTestId('notifications-offline')).toBeNull()
  })
})

describe('bell wording', () => {
  it('says "more unread on the node" instead of "at least 0" when the loaded unread rows are all handled', async () => {
    const node = new FakeNode([])
    node.failWhile(LIST, { status: 200, body: { notifications: [], nextCursor: notificationId(1) } })
    installNodeFetch(node)
    render(<NotificationsProvider pollMs={3_600_000}><NotificationBell /></NotificationsProvider>)
    expect((await screen.findByTestId('notification-bell-count')).textContent).toBe('more unread on the node')
    expect(screen.getByTestId('notification-bell').textContent).not.toMatch(/at least 0/u)
  })
})
