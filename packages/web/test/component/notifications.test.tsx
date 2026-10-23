import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationBell } from '../../src/features/notifications/NotificationBell.tsx'
import { NotificationsPage } from '../../src/features/notifications/NotificationsPage.tsx'
import { NotificationsProvider } from '../../src/features/notifications/NotificationsProvider.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'
import { fixtureConnection } from '../browser/fixtures/session-features-api.ts'
import {
  CONNECTION_ID, FakeNode, OTHER_CONNECTION_ID, T0, allWireAvailable, notification, notificationId,
} from '../fixtures/notifications-server.ts'
import { counterKeys, installNodeFetch } from '../helpers/notifications-fetch.ts'

const NOW = T0 + 3_600_000

function seed(): FakeNode {
  return new FakeNode([
    notification(1, { severity: 'warning' }),
    notification(2, { kind: 'forecast', severity: 'info', facts: { window: 'seven_day', threshold: null, remainingPercent: 31, forecast: { exhaustsAt: '2026-10-23T12:30:00.000Z', before: 'reset' } } }),
    notification(3, { kind: 'exhausted', severity: 'critical', facts: { window: 'balance', threshold: null, remainingPercent: 0, resetsAt: null, confidence: 'estimated' } }),
    notification(4, { state: 'read' }),
    notification(5, { state: 'acted', actions: ['open', 'wake_leads'] }),
  ])
}

function mount(node: FakeNode, options: { pollMs?: number; connections?: boolean } = {}) {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const fetchMock = installNodeFetch(node, (path) => path === '/api/connections'
    ? { status: 200, body: { connections: [fixtureConnection(CONNECTION_ID, 'Claude'), fixtureConnection(OTHER_CONNECTION_ID, 'DeepSeek')], costs: [], vault: { unlocked: false, unattendedAvailable: false } } }
    : null)
  window.history.replaceState(null, '', '/notifications')
  const view = render(<NotificationsProvider pollMs={options.pollMs ?? 3_600_000} newKey={counterKeys()}>
    <NotificationBell />
    <NotificationsPage />
  </NotificationsProvider>)
  return { ...view, fetchMock }
}

const rows = () => screen.queryAllByTestId('notification-row')
const rowOf = (n: number) => rows().find((row) => row.getAttribute('data-notification-id') === notificationId(n))!
const bell = () => screen.getByTestId('notification-bell')
const bellCount = () => screen.getByTestId('notification-bell-count').textContent
const status = () => screen.getByTestId('notifications-status').textContent
const button = (scope: HTMLElement | Screen, name: string | RegExp) => within(scope as HTMLElement).getByRole('button', { name })
type Screen = typeof screen
const reasonOf = (element: HTMLElement) => (element.getAttribute('aria-describedby') ?? '').split(' ')
  .map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
const ready = async () => { await waitFor(() => expect(screen.queryByTestId('notifications-loading')).toBeNull()) }
const enabledActionButtons = (row: HTMLElement) => within(row).getAllByRole('button').filter((item) => !(item as HTMLButtonElement).disabled)

beforeEach(() => {
  setActiveLocale('en')
  window.history.replaceState(null, '', '/notifications')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('status-strip bell', () => {
  it('shows loading, then unknown (never 0) when the node has not answered with a valid inbox', async () => {
    const node = seed()
    const release = node.hold(/^GET \/api\/notifications$/u)
    mount(node)
    expect(bellCount()).toBe('Loading…')
    node.failNext(/^GET \/api\/notifications$/u, { status: 500, body: { code: 'internal_error' } })
    release()
    await waitFor(() => expect(bellCount()).toBe('No current data'))
    expect(bell().textContent).not.toMatch(/\b0\b/u)
    expect(bell().getAttribute('data-unread')).toBeNull()
    expect(bell().textContent).toContain('Notifications')
  })

  it('without a provider the entry says it has no data', () => {
    render(<NotificationBell />)
    expect(screen.getByText('No current data')).toBeTruthy()
  })

  it('the unread badge equals the unread rows, before and after marking one read', async () => {
    const node = seed()
    mount(node)
    await waitFor(() => expect(bellCount()).toBe('3 unread'))
    await ready()
    expect(rows()).toHaveLength(3)
    expect(bell().getAttribute('data-unread')).toBe('3')

    fireEvent.click(button(rowOf(2), 'Mark read'))
    await waitFor(() => expect(bellCount()).toBe('2 unread'))
    expect(rows()).toHaveLength(2)
    expect(bell().getAttribute('data-unread')).toBe('2')
    expect(node.count(/^POST .*\/read$/u)).toBe(1)

    for (const target of [1, 3]) fireEvent.click(button(rowOf(target), 'Mark read'))
    await waitFor(() => expect(bellCount()).toBe('None unread'))
    expect(rows()).toHaveLength(0)
    expect(screen.getByText('No unread notifications.')).toBeTruthy()
  })

  it('counts a lower bound when more unread rows exist than the node returns, and the number equals the rows shown', async () => {
    const node = new FakeNode(Array.from({ length: 201 }, (_, index) => notification(index + 1)))
    mount(node)
    await waitFor(() => expect(bellCount()).toBe('at least 200 unread'))
    await ready()
    expect(rows()).toHaveLength(200)
    expect(screen.getByTestId('notifications-paging').textContent).toContain('Showing the newest 200')
    fireEvent.click(screen.getByRole('button', { name: 'Load older notifications' }))
    await waitFor(() => expect(bellCount()).toBe('201 unread'))
    expect(rows()).toHaveLength(201)
    expect(new Set(rows().map((row) => row.getAttribute('data-notification-id'))).size).toBe(201)
  })

  it('announces new arrivals politely, once, and not the first load, a re-read, or the user\'s own change', async () => {
    const node = seed()
    mount(node)
    await waitFor(() => expect(bellCount()).toBe('3 unread'))
    const live = screen.getByTestId('notification-live')
    expect(live.getAttribute('role')).toBe('status')
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.textContent).toBe('')

    // Nothing changed on the node: a re-read announces nothing.
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(node.count(/^GET \/api\/notifications$/u)).toBeGreaterThanOrEqual(2))
    expect(live.textContent).toBe('')

    node.rows.push(notification(6), notification(7))
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(live.textContent).toBe('2 new notifications. 5 unread'))
    expect(bellCount()).toBe('5 unread')

    // Marking a row read changes the count but is not an arrival.
    await ready()
    fireEvent.click(button(rowOf(6), 'Mark read'))
    await waitFor(() => expect(bellCount()).toBe('4 unread'))
    expect(live.textContent).toBe('2 new notifications. 5 unread')

    node.rows.push(notification(8))
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(live.textContent).toBe('1 new notification. 5 unread'))
  })

  it('keeps the last known count visible and marked when a refresh fails', async () => {
    const node = seed()
    mount(node)
    await waitFor(() => expect(bellCount()).toBe('3 unread'))
    node.unreachable = true
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(bell().textContent).toMatch(/3 unread.*last known/u))
  })

  it('polls on its interval', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const node = seed()
      mount(node, { pollMs: 1000 })
      await waitFor(() => expect(bellCount()).toBe('3 unread'))
      node.rows.push(notification(9))
      await act(async () => { await vi.advanceTimersByTimeAsync(1100) })
      await waitFor(() => expect(bellCount()).toBe('4 unread'))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('notification center states', () => {
  it('shows a skeleton with a status while loading', async () => {
    const node = seed()
    const release = node.hold(/^GET \/api\/notifications$/u)
    mount(node)
    expect(screen.getByTestId('notifications-loading')).toBeTruthy()
    expect(screen.getByText('Loading notifications…')).toBeTruthy()
    expect(screen.getByTestId('notifications-loading').querySelector('ol')!.getAttribute('aria-hidden')).toBe('true')
    release()
    await ready()
    expect(rows()).toHaveLength(3)
  })

  it('explains an empty inbox with one action, per filter', async () => {
    const node = new FakeNode([])
    mount(node)
    await ready()
    const empty = screen.getByTestId('notifications-empty')
    expect(within(empty).getByText('No unread notifications.')).toBeTruthy()
    fireEvent.click(within(empty).getByRole('button', { name: 'Show all notifications' }))
    await waitFor(() => expect(screen.getByText(/No notifications yet/u)).toBeTruthy())
    expect(within(screen.getByTestId('notifications-empty')).getAllByRole('button')).toHaveLength(1)
    for (const [filter, text] of [['read', 'No notifications are marked read.'], ['snoozed', 'No notifications are snoozed.'], ['acted', 'No notification has been acted on.']] as const) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${filter === 'acted' ? 'Acted on' : filter}$`, 'iu') }))
      await waitFor(() => expect(screen.getByText(text)).toBeTruthy())
    }
  })

  it('shows an error with source, time, details and a retry that recovers', async () => {
    const node = seed()
    node.failNext(/^GET \/api\/notifications$/u, { status: 503, body: { code: 'notifications_unavailable' } })
    mount(node)
    const error = await screen.findByTestId('notifications-error')
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toContain('Notifications could not be loaded')
    expect(error.textContent).toContain('The notification inbox is not available on this node.')
    expect(error.textContent).toContain('GET /api/notifications')
    expect(error.textContent).toContain('notifications_unavailable')
    expect(bellCount()).toBe('No current data')
    fireEvent.click(within(error).getByRole('button', { name: 'Try again' }))
    await ready()
    expect(rows()).toHaveLength(3)
    expect(screen.queryByTestId('notifications-error')).toBeNull()
    expect(bellCount()).toBe('3 unread')
  })

  it('offline before any answer: says nothing is known, not that the inbox is empty', async () => {
    const node = seed()
    node.unreachable = true
    mount(node)
    const banner = await screen.findByTestId('notifications-offline')
    expect(banner.textContent).toContain('Offline: the node is unreachable (node_unreachable).')
    expect(banner.textContent).toContain('Nothing is known yet')
    expect(screen.queryByTestId('notifications-empty')).toBeNull()
    expect(rows()).toHaveLength(0)
    node.unreachable = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(screen.queryByTestId('notifications-offline')).toBeNull()
  })

  it('offline with data: shows last known rows with their age, disables every network action with the reason, recovers', async () => {
    const node = new FakeNode(seed().rows, allWireAvailable())
    mount(node)
    await ready()
    await waitFor(() => expect(enabledActionButtons(rowOf(1)).length).toBeGreaterThan(0))
    node.unreachable = true
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    const banner = await screen.findByTestId('notifications-offline')
    expect(banner.textContent).toMatch(/as of .*, .*/u)
    expect(rows()).toHaveLength(3)
    for (const row of rows()) {
      const buttons = within(row).getAllByRole('button')
      expect(buttons.length).toBeGreaterThan(0)
      for (const item of buttons) {
        expect((item as HTMLButtonElement).disabled, item.textContent ?? '').toBe(true)
        expect(reasonOf(item)).toContain('Offline: actions need the node.')
      }
    }
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false)
    expect(node.count(/^POST /u)).toBe(0)
    node.unreachable = false
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.queryByTestId('notifications-offline')).toBeNull())
    expect(enabledActionButtons(rowOf(1)).length).toBeGreaterThan(0)
  })

  it('a failed refresh with data shows the code and keeps the rows', async () => {
    const node = seed()
    mount(node)
    await ready()
    node.failNext(/^GET \/api\/notifications$/u, { status: 500, body: { code: 'internal_error' } })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    const stale = await screen.findByTestId('notifications-stale')
    expect(stale.textContent).toContain('internal_error')
    expect(stale.getAttribute('role')).toBe('alert')
    expect(rows()).toHaveLength(3)
  })

  it('pages the All list in steps of 50 with an explicit control, and says when it ends', async () => {
    const node = new FakeNode(Array.from({ length: 120 }, (_, index) => notification(index + 1, { state: 'read' })))
    mount(node)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    await waitFor(() => expect(rows()).toHaveLength(50))
    expect(screen.getByTestId('notifications-paging').textContent).toContain('Showing the newest 50')
    expect(node.requests.at(-1)?.query).toMatchObject({ limit: '50' })
    fireEvent.click(screen.getByRole('button', { name: 'Load older notifications' }))
    await waitFor(() => expect(rows()).toHaveLength(100))
    fireEvent.click(screen.getByRole('button', { name: 'Load older notifications' }))
    await waitFor(() => expect(rows()).toHaveLength(120))
    expect(screen.queryByRole('button', { name: 'Load older notifications' })).toBeNull()
    expect(screen.getByTestId('notifications-paging').textContent).toContain('120 notifications')
    expect(new Set(rows().map((row) => row.getAttribute('data-notification-id'))).size).toBe(120)
    // Newest first.
    expect(rows()[0]!.getAttribute('data-notification-id')).toBe(notificationId(120))
    expect(rows()[119]!.getAttribute('data-notification-id')).toBe(notificationId(1))
  })

  it('keeps loaded older pages when the head is re-read', async () => {
    const node = new FakeNode(Array.from({ length: 70 }, (_, index) => notification(index + 1, { state: 'read' })))
    mount(node)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    await waitFor(() => expect(rows()).toHaveLength(50))
    fireEvent.click(screen.getByRole('button', { name: 'Load older notifications' }))
    await waitFor(() => expect(rows()).toHaveLength(70))
    node.rows.push(notification(71, { state: 'read' }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(rows()).toHaveLength(71))
    expect(rows()[0]!.getAttribute('data-notification-id')).toBe(notificationId(71))
  })

  it('reports a failed page load without losing the rows already shown', async () => {
    const node = new FakeNode(Array.from({ length: 60 }, (_, index) => notification(index + 1, { state: 'read' })))
    mount(node)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    await waitFor(() => expect(rows()).toHaveLength(50))
    node.failNext(/^GET \/api\/notifications$/u, { status: 500, body: { code: 'internal_error' } })
    fireEvent.click(screen.getByRole('button', { name: 'Load older notifications' }))
    await waitFor(() => expect(screen.getByText(/Older notifications could not be loaded \(internal_error\)/u)).toBeTruthy())
    expect(rows()).toHaveLength(50)
    fireEvent.click(screen.getByRole('button', { name: 'Load older notifications' }))
    await waitFor(() => expect(rows()).toHaveLength(60))
  })
})

describe('what every notification shows', () => {
  it('pairs severity with a text label and a shape, not colour alone', async () => {
    mount(seed())
    await ready()
    const expected: Array<[number, string, string]> = [[1, 'Warning', '◆'], [2, 'Info', '●'], [3, 'Critical', '▲']]
    for (const [n, label, glyph] of expected) {
      const severity = within(rowOf(n)).getByTestId('notification-severity')
      expect(severity.textContent).toBe(`${glyph}${label}`)
      const glyphElement = severity.querySelector('[aria-hidden="true"]')!
      expect(glyphElement.textContent).toBe(glyph)
      expect(rowOf(n).getAttribute('data-severity')).toBe(label.toLowerCase())
    }
    expect(new Set(expected.map(([, , glyph]) => glyph)).size).toBe(3)
  })

  it('shows source, observation time and confidence on every row, and unknown values as unknown', async () => {
    mount(seed())
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    await waitFor(() => expect(rows()).toHaveLength(5))
    for (const row of rows()) {
      const facts = within(row).getByTestId('notification-facts')
      const text = (label: string) => within(facts).getByText(label, { selector: 'dt' }).parentElement!.querySelector('dd')!.textContent
      expect(text('Source')).toBe('claude_code.statusline')
      expect(text('Observed')).toMatch(/\d/u)
      expect(['Observed', 'Estimated']).toContain(within(facts).getByTestId('notification-confidence').textContent)
    }
    const exhausted = within(rowOf(3)).getByTestId('notification-facts')
    expect(within(exhausted).getByTestId('notification-confidence').textContent).toBe('Estimated')
    expect(within(exhausted).getByText('Resets').parentElement!.querySelector('dd')!.textContent).toBe('Unknown')
    expect(exhausted.textContent).toContain('Guanxi estimated this')
  })

  it('shows a missing percentage as unknown, never 0', async () => {
    const unknown = new FakeNode([notification(1, { facts: { remainingPercent: null } })])
    mount(unknown)
    await ready()
    const facts = within(rows()[0]!).getByTestId('notification-facts')
    expect(within(facts).getByText('Remaining').parentElement!.querySelector('dd')!.textContent).toBe('Unknown')
    expect(within(rows()[0]!).getByRole('heading').textContent).toContain('amount left is unknown')
  })

  it('prints whole-number percentages whole: 10% is 10%, 100% is 100%, 0% is 0%', async () => {
    mount(new FakeNode([
      notification(1, { facts: { threshold: 10, remainingPercent: 9 } }),
      notification(2, { facts: { threshold: 20, remainingPercent: 100 } }),
      notification(3, { facts: { threshold: 5, remainingPercent: 0 } }),
    ]))
    await ready()
    expect(within(rowOf(1)).getByRole('heading').textContent).toBe('5-hour window: 9% left (alert at 10%)')
    expect(within(rowOf(2)).getByRole('heading').textContent).toBe('5-hour window: 100% left (alert at 20%)')
    expect(within(rowOf(3)).getByRole('heading').textContent).toBe('5-hour window: 0% left (alert at 5%)')
    expect(within(rowOf(2)).getByText('Remaining', { selector: 'dt' }).parentElement!.querySelector('dd')!.textContent).toBe('100%')
    expect(within(rowOf(2)).getByText('Alert threshold', { selector: 'dt' }).parentElement!.querySelector('dd')!.textContent).toBe('20%')
  })

  it('shows the forecast with what it was compared with', async () => {
    mount(seed())
    await ready()
    const facts = within(rowOf(2)).getByTestId('notification-facts')
    expect(facts.textContent).toContain('Projected to run out')
    expect(facts.textContent).toContain('the window reset')
    expect(within(rowOf(2)).getByRole('heading').textContent).toMatch(/7-day window: projected to run out at/u)
  })

  it('renders in Russian with no missing translation and a correct plural', async () => {
    setActiveLocale('ru')
    mount(seed())
    await waitFor(() => expect(bellCount()).toBe('3 непрочитанных'))
    await ready()
    expect(document.body.textContent).not.toMatch(/missing translation|translation variables/u)
    expect(within(rowOf(3)).getByText('Источник')).toBeTruthy()
    expect(within(rowOf(3)).getByText('Наблюдение', { selector: 'dt' })).toBeTruthy()
    expect(within(rowOf(3)).getByTestId('notification-confidence').textContent).toBe('Оценка')
    expect(within(rowOf(3)).getByTestId('notification-severity').textContent).toBe('▲Критично')
    expect(screen.getByRole('button', { name: 'Отложенные' })).toBeTruthy()
  })
})

describe('actions follow what the node reports', () => {
  it('on the shipped node only Open and Snooze are enabled; the rest are disabled with the reason, not hidden', async () => {
    const node = seed()
    mount(node)
    await ready()
    await waitFor(() => expect(node.count(/actions$/u)).toBe(1))
    await waitFor(() => expect(enabledActionButtons(rowOf(1)).map((item) => item.textContent)).toEqual(['Mark read', 'Open', 'Snooze…']))
    const row = rowOf(1)
    expect(within(row).getAllByRole('button').map((item) => item.textContent))
      .toEqual(['Mark read', 'Open', 'Wake leads', 'Switch connection…', 'Pause runs', 'Accept recommendation', 'Snooze…'])
    for (const name of ['Wake leads', 'Switch connection…', 'Pause runs', 'Accept recommendation']) {
      const item = button(row, name)
      expect((item as HTMLButtonElement).disabled).toBe(true)
      expect(reasonOf(item)).toContain('not_configured')
      expect(reasonOf(item)).toContain(name)
    }
    expect(within(row).getByTestId('notification-reasons')).toBeTruthy()
  })

  it('shows an action the web client cannot send as disabled with its reason', async () => {
    const node = new FakeNode([notification(1, { actions: ['open', 'add_prompt', 'raise_budget', 'snooze'] })])
    mount(node)
    await ready()
    await waitFor(() => expect((button(rowOf(1), 'Add prompt') as HTMLButtonElement).disabled).toBe(true))
    expect(reasonOf(button(rowOf(1), 'Add prompt'))).toContain('free text or money intent')
    expect(reasonOf(button(rowOf(1), 'Raise budget'))).toContain('free text or money intent')
    expect((button(rowOf(1), 'Open') as HTMLButtonElement).disabled).toBe(false)
  })

  it('enables exactly the actions the node reports available', async () => {
    const node = new FakeNode([notification(1)], allWireAvailable())
    mount(node)
    await ready()
    await waitFor(() => expect(enabledActionButtons(rowOf(1)).map((item) => item.textContent))
      .toEqual(['Mark read', 'Open', 'Wake leads', 'Switch connection…', 'Pause runs', 'Accept recommendation', 'Snooze…']))
    expect(within(rowOf(1)).queryByTestId('notification-reasons')).toBeNull()
  })

  it('keeps actions disabled while it checks, and when the check fails, until it succeeds', async () => {
    const node = new FakeNode([notification(1)], allWireAvailable())
    const release = node.hold(/actions$/u)
    mount(node)
    await ready()
    expect(reasonOf(button(rowOf(1), 'Open'))).toContain('Checking which actions this node supports')
    expect((button(rowOf(1), 'Open') as HTMLButtonElement).disabled).toBe(true)
    node.failNext(/actions$/u, { status: 500, body: { code: 'internal_error' } })
    release()
    await waitFor(() => expect(reasonOf(button(rowOf(1), 'Open'))).toContain('Could not check which actions this node supports (internal_error)'))
    expect((button(rowOf(1), 'Open') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button(rowOf(1), 'Check again'))
    await waitFor(() => expect((button(rowOf(1), 'Open') as HTMLButtonElement).disabled).toBe(false))
  })

  it('disables everything on an acted row, with the reason, and offers no Mark read', async () => {
    const node = new FakeNode([notification(1, { state: 'acted', actions: ['open', 'wake_leads', 'snooze'] })], allWireAvailable())
    mount(node)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Acted on' }))
    await waitFor(() => expect(rows()).toHaveLength(1))
    await waitFor(() => expect(node.count(/actions$/u)).toBe(1))
    expect(within(rows()[0]!).queryByRole('button', { name: 'Mark read' })).toBeNull()
    for (const item of within(rows()[0]!).getAllByRole('button')) {
      expect((item as HTMLButtonElement).disabled).toBe(true)
      expect(reasonOf(item)).toContain('Already acted on')
    }
  })

  it('Open marks the row read, runs with a key, sends exactly the typed body, and goes to the connection', async () => {
    const node = seed()
    mount(node)
    await ready()
    await waitFor(() => expect((button(rowOf(1), 'Open') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button(rowOf(1), 'Open'))
    await waitFor(() => expect(node.effects['open']).toBe(1))
    const post = node.requests.find((record) => record.method === 'POST' && record.path.endsWith('/actions'))!
    expect(post.body).toEqual({ action: 'open', args: {} })
    expect(post.idempotencyKey).toBe('key-000001')
    await waitFor(() => expect(bellCount()).toBe('2 unread'))
    expect(window.location.pathname).toBe('/settings')
  })

  it('treats a 501 not_configured as a definite answer: no state change, no retained key, next attempt is a new intent', async () => {
    const node = new FakeNode([notification(1)], allWireAvailable())
    mount(node)
    await ready()
    await waitFor(() => expect((button(rowOf(1), 'Wake leads') as HTMLButtonElement).disabled).toBe(false))
    node.availability['wake_leads'] = 'not_configured'
    fireEvent.click(button(rowOf(1), 'Wake leads'))
    const failure = await within(rowOf(1)).findByTestId('notification-failure')
    expect(failure.textContent).toContain('no way to run that action yet (not_configured)')
    expect(failure.textContent).not.toContain('reuses the same request key')
    expect(rowOf(1).getAttribute('data-state')).toBe('unread')
    expect(node.effects['wake_leads']).toBeUndefined()
    fireEvent.click(within(failure).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(node.count(/\/actions$/u)).toBe(3)) // two action posts + the availability read
    const keys = node.requests.filter((record) => record.method === 'POST').map((record) => record.idempotencyKey)
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(2)
    expect(bellCount()).toBe('1 unread')
  })

  it('reuses the Idempotency-Key when the answer was lost, and the effect runs once', async () => {
    const node = new FakeNode([notification(1)], allWireAvailable())
    mount(node)
    await ready()
    await waitFor(() => expect((button(rowOf(1), 'Pause runs') as HTMLButtonElement).disabled).toBe(false))
    node.failNext(/^POST .*\/actions$/u, 'lose')
    fireEvent.click(button(rowOf(1), 'Pause runs'))
    const failure = await within(rowOf(1)).findByTestId('notification-failure')
    expect(failure.textContent).toContain('node is unreachable')
    expect(failure.textContent).toContain('reuses the same request key')
    expect(node.effects['pause_runs']).toBe(1) // the node did it; only the answer was lost
    fireEvent.click(within(failure).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByTestId('notifications-status').textContent).toBe('Pause runs: it had already been done, so nothing new happened.'))
    const posts = node.requests.filter((record) => record.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[0]!.idempotencyKey).toBe(posts[1]!.idempotencyKey)
    expect(posts[0]!.idempotencyKey).toBe('key-000001')
    expect(node.effects['pause_runs']).toBe(1)
    expect(rowOf(1)?.getAttribute('data-state') ?? 'gone').not.toBe('unread')
    await waitFor(() => expect(bellCount()).toBe('None unread'))
  })

  it.each([
    ['500 internal_error', { status: 500, body: { code: 'internal_error' } }],
    ['503 notifications_unavailable', { status: 503, body: { code: 'notifications_unavailable' } }],
    ['409 action_in_progress', { status: 409, body: { code: 'action_in_progress' } }],
    ['409 action_outcome_unknown', { status: 409, body: { code: 'action_outcome_unknown' } }],
    ['an unparseable proxy answer', { status: 502, body: 'bad gateway' }],
  ])('retries after %s with the same key', async (_name, failure) => {
    const node = new FakeNode([notification(1)], allWireAvailable())
    mount(node)
    await ready()
    await waitFor(() => expect((button(rowOf(1), 'Wake leads') as HTMLButtonElement).disabled).toBe(false))
    node.failNext(/^POST .*\/actions$/u, failure)
    fireEvent.click(button(rowOf(1), 'Wake leads'))
    const alert = await within(rowOf(1)).findByTestId('notification-failure')
    expect(alert.textContent).toContain('reuses the same request key')
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(node.effects['wake_leads']).toBe(1))
    const keys = node.requests.filter((record) => record.method === 'POST').map((record) => record.idempotencyKey)
    expect(keys).toEqual(['key-000001', 'key-000001'])
  })

  it('does not reuse the key after a port failure: that attempt is finished, a new click is a new intent', async () => {
    const node = new FakeNode([notification(1)], allWireAvailable())
    mount(node)
    await ready()
    await waitFor(() => expect((button(rowOf(1), 'Wake leads') as HTMLButtonElement).disabled).toBe(false))
    node.failNext(/^POST .*\/actions$/u, { status: 502, body: { code: 'port_failed' } })
    fireEvent.click(button(rowOf(1), 'Wake leads'))
    const alert = await within(rowOf(1)).findByTestId('notification-failure')
    expect(alert.textContent).toContain('attempted and failed on the node')
    expect(alert.textContent).not.toContain('reuses the same request key')
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(node.effects['wake_leads']).toBe(1))
    const keys = node.requests.filter((record) => record.method === 'POST').map((record) => record.idempotencyKey)
    expect(keys).toEqual(['key-000001', 'key-000002'])
  })

  it('shows a stored failed result (status failed) as a failure', async () => {
    const node = new FakeNode([notification(1)], allWireAvailable())
    mount(node)
    await ready()
    await waitFor(() => expect((button(rowOf(1), 'Wake leads') as HTMLButtonElement).disabled).toBe(false))
    node.failNext(/^POST .*\/actions$/u, { status: 200, body: { notificationId: notificationId(1), action: 'wake_leads', status: 'failed', result: { code: 'port_failed' }, duplicate: true } })
    fireEvent.click(button(rowOf(1), 'Wake leads'))
    const alert = await within(rowOf(1)).findByTestId('notification-failure')
    expect(alert.textContent).toContain('port_failed')
    expect(rowOf(1).getAttribute('data-state')).toBe('unread')
  })

  it('a double click sends one request', async () => {
    const node = new FakeNode([notification(1)], allWireAvailable())
    mount(node)
    await ready()
    await waitFor(() => expect((button(rowOf(1), 'Pause runs') as HTMLButtonElement).disabled).toBe(false))
    const release = node.hold(/^POST .*\/actions$/u)
    fireEvent.click(button(rowOf(1), 'Pause runs'))
    await waitFor(() => expect(within(rowOf(1)).getAllByRole('button').some((item) => item.getAttribute('aria-busy') === 'true')).toBe(true))
    fireEvent.click(within(rowOf(1)).getAllByRole('button').find((item) => item.getAttribute('aria-busy') === 'true')!)
    release()
    await waitFor(() => expect(node.effects['pause_runs']).toBe(1))
    expect(node.count(/^POST .*\/actions$/u)).toBe(1)
  })

  it('says so when the action took effect but the updated row could not be read', async () => {
    const node = new FakeNode([notification(1)], allWireAvailable())
    mount(node)
    await ready()
    await waitFor(() => expect((button(rowOf(1), 'Pause runs') as HTMLButtonElement).disabled).toBe(false))
    node.failNext(/^GET \/api\/notifications\/ntf_/u, { status: 500, body: { code: 'internal_error' } })
    fireEvent.click(button(rowOf(1), 'Pause runs'))
    await waitFor(() => expect(status()).toBe('Done, but the updated notification could not be loaded. Refresh to see its state.'))
    expect(node.effects['pause_runs']).toBe(1)
  })

  it('Switch connection needs a choice, offers the other connections only, and sends the identifier', async () => {
    const node = new FakeNode([notification(1)], allWireAvailable())
    mount(node)
    await ready()
    await waitFor(() => expect((button(rowOf(1), 'Switch connection…') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button(rowOf(1), 'Switch connection…'))
    const form = await within(rowOf(1)).findByTestId('switch-form')
    const select = await within(form).findByRole('combobox', { name: 'Fallback connection' })
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['Choose a connection', 'DeepSeek'])
    fireEvent.click(within(form).getByRole('button', { name: 'Switch' }))
    expect(within(form).getByText('Choose a connection first.')).toBeTruthy()
    expect(node.count(/^POST /u)).toBe(0)
    fireEvent.change(select, { target: { value: OTHER_CONNECTION_ID } })
    fireEvent.click(within(form).getByRole('button', { name: 'Switch' }))
    await waitFor(() => expect(node.effects['switch_connection']).toBe(1))
    const post = node.requests.find((record) => record.method === 'POST')!
    expect(post.body).toEqual({ action: 'switch_connection', args: { connectionId: OTHER_CONNECTION_ID } })
  })
})

describe('mark read and snooze', () => {
  it('Mark read posts once, leaves the Unread view, announces it and moves focus to the next row', async () => {
    const node = seed()
    mount(node)
    await ready()
    const first = rows()[0]!
    const markRead = button(first, 'Mark read')
    markRead.focus()
    fireEvent.click(markRead)
    await waitFor(() => expect(status()).toBe('Marked read.'))
    expect(node.count(/^POST .*\/read$/u)).toBe(1)
    expect(rows()).toHaveLength(2)
    await waitFor(() => expect(document.activeElement).toBe(rows()[0]))
    fireEvent.click(screen.getByRole('button', { name: 'Read' }))
    await waitFor(() => expect(rows()).toHaveLength(2)) // the read row from the seed and the one just read
  })

  it('keeps focus on the row itself when the row stays in the list', async () => {
    const node = seed()
    mount(node)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    await waitFor(() => expect(rows()).toHaveLength(5))
    const markRead = button(rowOf(1), 'Mark read')
    markRead.focus()
    fireEvent.click(markRead)
    await waitFor(() => expect(rowOf(1).getAttribute('data-state')).toBe('read'))
    await waitFor(() => expect(document.activeElement).toBe(rowOf(1)))
  })

  it('a failed Mark read stays visible on the row with the code, and can be retried', async () => {
    const node = seed()
    mount(node)
    await ready()
    node.failNext(/^POST .*\/read$/u, { status: 500, body: { code: 'internal_error' } })
    fireEvent.click(button(rowOf(1), 'Mark read'))
    const alert = await within(rowOf(1)).findByTestId('notification-failure')
    expect(alert.textContent).toContain('Mark read failed')
    expect(alert.textContent).toContain('internal_error')
    expect(rowOf(1).getAttribute('data-state')).toBe('unread')
    expect(bellCount()).toBe('3 unread')
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(bellCount()).toBe('2 unread'))
    expect(node.count(/^POST .*\/read$/u)).toBe(2)
  })

  it('a stale slow poll never turns a row the user just read back into unread', async () => {
    const node = seed()
    mount(node)
    await ready()
    const release = node.hold(/^GET \/api\/notifications$/u)
    const stale = node.rows.map((row) => ({ ...row }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    // The held read was taken before the row changed.
    release()
    fireEvent.click(button(rowOf(1), 'Mark read'))
    await waitFor(() => expect(bellCount()).toBe('2 unread'))
    node.rows = stale.map((row) => row.id === notificationId(1) ? { ...row, state: 'unread' as const, updatedAt: row.updatedAt } : row)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(node.count(/^GET \/api\/notifications$/u)).toBeGreaterThan(2))
    expect(bellCount()).toBe('2 unread')
    expect(rows().map((row) => row.getAttribute('data-notification-id'))).not.toContain(notificationId(1))
  })

  it('snoozes with a preset: sends the exact time, moves the row to Snoozed with its deadline, and the form closes', async () => {
    const node = seed()
    mount(node)
    await ready()
    await waitFor(() => expect((button(rowOf(2), 'Snooze…') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button(rowOf(2), 'Snooze…'))
    const form = within(rowOf(2)).getByTestId('snooze-form')
    await waitFor(() => expect(document.activeElement).toBe(within(form).getByRole('button', { name: 'In 1 hour' })))
    fireEvent.click(within(form).getByRole('button', { name: 'In 1 hour' }))
    await waitFor(() => expect(status()).toMatch(/^Snoozed until /u))
    const post = node.requests.find((record) => record.method === 'POST')!
    expect(post.path).toBe(`/api/notifications/${notificationId(2)}/snooze`)
    expect(post.body).toEqual({ untilMs: NOW + 3_600_000 })
    expect(post.idempotencyKey).toBeNull()
    expect(bellCount()).toBe('2 unread')
    fireEvent.click(screen.getByRole('button', { name: 'Snoozed' }))
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(within(rows()[0]!).getByTestId('notification-state').textContent).toMatch(/^Snoozed until /u)
  })

  it('offers "until the window resets" only when a reset time is known and still ahead', async () => {
    const node = new FakeNode([notification(1), notification(2, { facts: { resetsAt: null } })])
    mount(node)
    await ready()
    await waitFor(() => expect((button(rowOf(1), 'Snooze…') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button(rowOf(1), 'Snooze…'))
    expect(within(within(rowOf(1)).getByTestId('snooze-form')).getAllByRole('button').map((item) => item.getAttribute('data-preset')).filter(Boolean))
      .toEqual(['hour', 'fourHours', 'tomorrow', 'reset'])
    fireEvent.click(button(rowOf(2), 'Snooze…'))
    expect(within(within(rowOf(2)).getByTestId('snooze-form')).getAllByRole('button').map((item) => item.getAttribute('data-preset')).filter(Boolean))
      .toEqual(['hour', 'fourHours', 'tomorrow'])
  })

  it('snoozes until a chosen time, and refuses a time that is not in the future without calling the node', async () => {
    const node = seed()
    mount(node)
    await ready()
    await waitFor(() => expect((button(rowOf(1), 'Snooze…') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button(rowOf(1), 'Snooze…'))
    const form = within(rowOf(1)).getByTestId('snooze-form')
    const input = within(form).getByLabelText('Or choose a date and time') as HTMLInputElement
    fireEvent.change(input, { target: { value: '2020-01-01T10:00' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Snooze' }))
    expect(within(form).getByRole('alert').textContent).toBe('Choose a date and time in the future.')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(node.count(/^POST /u)).toBe(0)
    fireEvent.click(within(form).getByRole('button', { name: 'Snooze' }))
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Snooze' }))
    expect(node.count(/^POST /u)).toBe(0)
    const future = new Date(NOW + 5 * 3_600_000)
    const pad = (n: number) => String(n).padStart(2, '0')
    const local = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}`
    fireEvent.change(input, { target: { value: local } })
    fireEvent.click(within(form).getByRole('button', { name: 'Snooze' }))
    await waitFor(() => expect(node.count(/^POST .*\/snooze$/u)).toBe(1))
    expect(node.requests.find((record) => record.method === 'POST')!.body).toEqual({ untilMs: new Date(local).getTime() })
  })

  it('Escape closes the snooze form and returns focus to its button', async () => {
    mount(seed())
    await ready()
    await waitFor(() => expect((button(rowOf(1), 'Snooze…') as HTMLButtonElement).disabled).toBe(false))
    const trigger = button(rowOf(1), 'Snooze…')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const form = within(rowOf(1)).getByTestId('snooze-form')
    fireEvent.keyDown(within(form).getByRole('button', { name: 'In 1 hour' }), { key: 'Escape' })
    expect(within(rowOf(1)).queryByTestId('snooze-form')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('a snoozed row returns to unread when its time passes and the node is read again', async () => {
    const node = seed()
    mount(node)
    await ready()
    await waitFor(() => expect((button(rowOf(1), 'Snooze…') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button(rowOf(1), 'Snooze…'))
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: 'In 1 hour' }))
    await waitFor(() => expect(bellCount()).toBe('2 unread'))
    node.clock = NOW + 3_700_000
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(bellCount()).toBe('3 unread'))
    expect(screen.getByTestId('notification-live').textContent).toBe('1 new notification. 3 unread')
  })
})

describe('the page', () => {
  it('moves focus to its heading when it opens and uses one h1', async () => {
    mount(seed())
    await ready()
    const heading = screen.getByRole('heading', { level: 1, name: 'Notifications' })
    expect(document.activeElement).toBe(heading)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it('filters by state with pressed buttons and keeps the bell independent of the filter', async () => {
    const node = seed()
    mount(node)
    await ready()
    expect(screen.getByRole('button', { name: 'Unread' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Acted on' }))
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(screen.getByRole('button', { name: 'Unread' }).getAttribute('aria-pressed')).toBe('false')
    expect(within(rows()[0]!).getByTestId('notification-state').textContent).toBe('Acted on')
    expect(bellCount()).toBe('3 unread')
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    await waitFor(() => expect(rows()).toHaveLength(5))
    expect(rows().map((row) => row.getAttribute('data-state'))).toEqual(['acted', 'read', 'unread', 'unread', 'unread'])
  })

  it('has only named controls', async () => {
    const node = seed()
    mount(node)
    await ready()
    await waitFor(() => expect(node.count(/actions$/u)).toBe(1))
    for (const control of screen.getAllByRole('button')) expect(control.textContent!.trim().length + (control.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0)
  })
})
