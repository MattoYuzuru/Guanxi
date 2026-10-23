/**
 * Mounts the in-memory notification node (test/fixtures/notifications-server.ts) behind
 * Playwright routes, on top of the shared mock node for the shell, so the bell, the center and
 * the rest of the product see one consistent world.
 */
import type { Page, Route } from '@playwright/test'
import { FIXTURE_CONNECTION, FIXTURE_LOCAL_CONNECTION, createSessionFeaturesFixture, fixtureConnection, installSessionFeaturesApi, type SessionFeaturesFixture } from './session-features-api.ts'
import { FakeNode, T0, notification } from '../../fixtures/notifications-server.ts'

export { FakeNode, T0, notification }

/** The demo inbox: every severity and kind, an estimated fact, an unknown percentage, read and acted rows. */
export function demoRows() {
  return [
    notification(1, { severity: 'warning', facts: { window: 'five_hour', threshold: 10, remainingPercent: 9 } }),
    notification(2, { kind: 'forecast', severity: 'info', facts: { window: 'seven_day', threshold: null, remainingPercent: 31, forecast: { exhaustsAt: '2026-10-23T12:30:00.000Z', before: 'dependent_run_eta', runId: 'run-0042' } } }),
    notification(3, { kind: 'exhausted', severity: 'critical', facts: { window: 'balance', threshold: null, remainingPercent: 0, resetsAt: null, confidence: 'estimated', source: 'guanxi.local_metering' } }),
    notification(4, { state: 'read', facts: { window: 'daily', threshold: 20, remainingPercent: null } }),
    notification(5, { state: 'acted', actions: ['open', 'wake_leads'], facts: { window: 'rate_tokens', threshold: 5, remainingPercent: 4 } }),
  ]
}

export async function installNotificationsApi(
  page: Page,
  node: FakeNode,
  overrides: Partial<SessionFeaturesFixture> = {},
): Promise<SessionFeaturesFixture> {
  const fixture = createSessionFeaturesFixture({
    connections: [fixtureConnection(FIXTURE_CONNECTION, 'Claude'), fixtureConnection(FIXTURE_LOCAL_CONNECTION, 'DeepSeek')],
    ...overrides,
    extra: async (route: Route, url: URL, method: string) => {
      if (!url.pathname.startsWith('/api/notifications')) return (await overrides.extra?.(route, url, method)) ?? false
      const request = route.request()
      let reply
      try {
        reply = await node.handle(method, url.pathname, Object.fromEntries(url.searchParams), request.headers(), method === 'POST' ? request.postDataJSON() : null)
      } catch {
        await route.abort('connectionrefused')
        return true
      }
      await route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) })
      return true
    },
  })
  await installSessionFeaturesApi(page, fixture)
  // The page reads the clock for snooze presets and relative ages; pin it next to the node's.
  await page.clock.setFixedTime(T0 + 3_600_000)
  return fixture
}
