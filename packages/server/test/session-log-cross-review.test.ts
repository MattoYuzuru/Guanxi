/**
 * Fixes for the GPT/Codex cross-family review of K2 (REVIEW-GPT.md, R1–R6).
 * Each test reproduces the reviewer's scenario and fails without its fix.
 * Every secret here is a generated fake.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import { SecretScrubber } from '../src/egress/scrubber.ts'
import { SessionLog, SessionLogError } from '../src/session-log/log.ts'
import { querySessionLog } from '../src/session-log/query-tool.ts'
import { sessionLogRoutes } from '../src/session-log/routes.ts'
import { openDb } from '../src/store/db.ts'

/** The Node server's request env with a loopback peer, for routes that check it. */
export const LOOPBACK_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }

function fake(): string {
  return `fake-${randomBytes(12).toString('hex')}`
}

function prompt(text: string) {
  return { type: 'prompt' as const, data: { origin: 'typed' as const, messageId: 'm1', text, attachmentCount: 0 } }
}

function code(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof SessionLogError, String(error))
    return error.code
  }
  assert.fail('expected the call to throw')
}

describe('R1: event identifiers never carry a secret', () => {
  it('refuses a secret in spanId, parentSpanId, jobId, the idempotency key or the session id, and stores nothing', () => {
    const db = openDb(':memory:')
    const scrubber = new SecretScrubber()
    const secret = fake()
    scrubber.register('secret://test/id', secret)
    const log = new SessionLog({ db, scrubber })
    const handle = log.open('s-ids', { kind: 'agent' })
    const head = () => (db.prepare("SELECT last_seq FROM sessions WHERE id = 's-ids'").get() as { last_seq: number }).last_seq
    const before = head()
    assert.equal(code(() => handle.append({ ...prompt('harmless'), spanId: `tool:${secret}` })), 'invalid_event')
    assert.equal(code(() => handle.append({ ...prompt('harmless'), parentSpanId: `step:${secret}` })), 'invalid_event')
    assert.equal(code(() => handle.append({ ...prompt('harmless'), jobId: secret })), 'invalid_event')
    assert.equal(code(() => handle.append(prompt('harmless'), { idempotencyKey: secret })), 'invalid_event')
    assert.equal(code(() => log.open(`s-${secret}`, { kind: 'agent' })), 'invalid_event')
    assert.equal(head(), before)
    const stored = JSON.stringify(db.prepare('SELECT * FROM session_events').all()) +
      JSON.stringify(db.prepare('SELECT * FROM sessions').all())
    assert.equal(stored.includes(secret), false)
  })

  it('hides a value registered after the write in every returned identifier: reads, query tool, HTTP', async () => {
    const db = openDb(':memory:')
    const scrubber = new SecretScrubber()
    const late = fake()
    const log = new SessionLog({ db, scrubber })
    const handle = log.open('s-late-ids', { kind: 'agent' })
    handle.append({ ...prompt('needle in a span'), spanId: `tool:${late}`, parentSpanId: `step:${late}`, jobId: late })
    scrubber.register('secret://test/late', late)

    for (const audience of ['person', 'local_agent', 'remote_agent'] as const) {
      assert.equal(JSON.stringify(log.readAll('s-late-ids', audience)).includes(late), false, audience)
    }
    assert.equal(JSON.stringify(querySessionLog(log, 's-late-ids', 'remote_agent', { limit: 100 })).includes(late), false)
    assert.equal(JSON.stringify(log.search('needle', { audience: 'person' })).includes(late), false)

    const app = new Hono()
    app.route('/api/sessions', sessionLogRoutes(() => log))
    for (const path of ['/events?after=0', '/export', '/spans', '']) {
      const response = await app.request(`/api/sessions/s-late-ids${path}`, {}, LOOPBACK_ENV)
      assert.equal(response.status, 200, path)
      assert.equal((await response.text()).includes(late), false, path)
    }
    const listed = await app.request('/api/sessions', {}, LOOPBACK_ENV)
    assert.equal((await listed.text()).includes(late), false)
  })
})
