/** Shared fixture for the MS2 route, plugin and boot tests. Not itself a test file. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { Hono } from 'hono'
import { createKernel } from '@guanxi/kernel'
import type { ActionPorts } from '../src/notifications/actions.ts'
import type { NotificationInbox } from '../src/notifications/inbox.ts'
import { NOTIFICATIONS_SERVICE, notificationsPlugin } from '../src/notifications/plugin.ts'
import { notificationRoutes } from '../src/notifications/routes.ts'
import type { QuotaFact } from '../src/notifications/types.ts'
import { VOICE_SERVICE, voicePlugin, type VoiceGlossary } from '../src/voice/plugin.ts'
import { glossaryRoutes } from '../src/voice/routes.ts'
import type { WorkLedger } from '../src/work/ledger.ts'
import { WORK_SERVICE, workPlugin } from '../src/work/plugin.ts'
import { workRoutes } from '../src/work/routes.ts'

export const PEER = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
export const REMOTE_PEER = { incoming: { socket: { remoteAddress: '192.168.1.20' } } }
/** 2026-10-23T00:00:00.000Z */
export const T0 = Date.parse('2026-10-23T00:00:00.000Z')

export interface CallOptions {
  method?: string
  json?: unknown
  /** Raw body, used for malformed JSON and oversize tests. */
  raw?: string
  headers?: Record<string, string>
  origin?: string
  /** Defaults to a loopback peer. */
  peer?: object | null
}

export async function call(app: Hono, path: string, options: CallOptions = {}) {
  const headers: Record<string, string> = { ...options.headers }
  let body: string | undefined
  if (options.json !== undefined) { body = JSON.stringify(options.json); headers['content-type'] ??= 'application/json' }
  if (options.raw !== undefined) { body = options.raw; headers['content-type'] ??= 'application/json' }
  if (options.origin !== undefined) headers['origin'] = options.origin
  const method = options.method ?? (body === undefined ? 'GET' : 'POST')
  const peer = options.peer === undefined ? PEER : options.peer ?? undefined
  const response = await app.request(path, { method, headers, body }, peer)
  const text = await response.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch { /* Non-JSON bodies keep json null. */ }
  return { status: response.status, headers: response.headers, text, json }
}

export function quotaFact(connectionId: string, remainingPercent: number, overrides: Partial<QuotaFact> = {}): QuotaFact {
  return {
    connectionId, window: 'five_hour', remainingPercent, remainingAbsolute: null, resetsAt: null,
    source: 'local-meter', observedAt: new Date(T0).toISOString(), confidence: 'observed', ...overrides,
  }
}

export interface Ms2Options {
  ports?: Partial<ActionPorts>
  devOrigins?: string[]
}

/** The three plugins on a bare kernel, a controllable clock and route apps for two accounts. */
export async function ms2Fixture(t: TestContext, options: Ms2Options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-ms2-'))
  const clock = { now: T0 }
  const now = () => clock.now
  const paths = {
    notifications: join(dir, 'notifications.sqlite'),
    voice: join(dir, 'voice.sqlite'),
    work: join(dir, 'work.sqlite'),
  }
  const kernel = createKernel()
  const handles = {
    notifications: await kernel.plugin(notificationsPlugin, { databasePath: paths.notifications, now, ports: options.ports }),
    voice: await kernel.plugin(voicePlugin, { databasePath: paths.voice, now }),
    work: await kernel.plugin(workPlugin, { databasePath: paths.work, now }),
  }
  t.after(async () => {
    await kernel.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  const inbox = () => kernel.service<NotificationInbox>(NOTIFICATIONS_SERVICE)
  const glossary = () => kernel.service<VoiceGlossary>(VOICE_SERVICE)
  const ledger = () => kernel.service<WorkLedger>(WORK_SERVICE)
  const devOrigins = options.devOrigins ?? []
  const appFor = (account: string) => new Hono()
    .route('/api/notifications', notificationRoutes(inbox, account, devOrigins))
    .route('/api/voice/glossary', glossaryRoutes(glossary, account, devOrigins))
    .route('/api/work', workRoutes(ledger, account, devOrigins))
  return {
    dir, paths, clock, kernel, handles, inbox, glossary, ledger,
    app: appFor('local'),
    other: appFor('other-account'),
    appFor,
  }
}
