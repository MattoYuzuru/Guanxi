/** SIGTERM while a remote dispatch is generating: the executor must abort the llama-server request, close within the named
 * stop bound, and a restarted executor must serve the home's retry. Two real `ms1-live start` processes on loopback; the
 * fixture model call is the only work in flight (no acceptance gate, no container). */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MS1_LIVE_STOP_BOUND_MS, stopBoundMsFor } from '../../src/index.ts'
import { runBoundedStop } from '../../src/ms1-live/stop.ts'
import { createLiveWorld, until } from './live-world.ts'

const MARGIN_MS = 3_000
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('SIGTERM aborts an in-flight dispatch, exits within the bound and a restarted executor serves the retry', { timeout: 240_000 }, async t => {
  const w = await createLiveWorld(t, { fake: { completionDelayMs: 60_000 } })
  await w.registerProject()
  const started = await w.startRelay('live-shutdown', 2)
  assert.equal(started.status, 202, JSON.stringify(started.body))
  await until(async () => (await w.fake.count('/completion')) >= 1, 'the delayed completion to reach the fake llama-server', 60_000)
  const interrupted = (await w.fake.requests('/completion'))[0]!
  assert.equal(await w.fake.aborted(), 0, 'nothing has been aborted before the signal')

  const signalAt = Date.now()
  assert.equal(w.executor.child.kill('SIGTERM'), true)
  const deadline = signalAt + MS1_LIVE_STOP_BOUND_MS + MARGIN_MS
  while (w.executor.alive && Date.now() < deadline) await sleep(25)
  const elapsed = Date.now() - signalAt
  assert.equal(w.executor.alive, false,
    `executor did not exit within ${MS1_LIVE_STOP_BOUND_MS + MARGIN_MS} ms; events: ${w.executor.events.map(event => JSON.stringify(event)).join(' ')}\n${w.executor.stderr.join('').slice(-2000)}`)
  assert.ok(elapsed <= MS1_LIVE_STOP_BOUND_MS + MARGIN_MS, `executor took ${elapsed} ms`)
  const exit = await w.executor.exit
  assert.equal(exit.code, 0, `clean stop exits 0 (signal ${exit.signal})\n${w.executor.stderr.join('').slice(-2000)}`)
  assert.equal(w.executor.events.some(event => event.event === 'stop'), false, 'a clean close emits no forced stop line')

  // The outbound fetch to the attached llama-server was aborted, and the durable holder is what a crash leaves (no terminal
  // protocol message, no invented cancel): the home's holder lease is what ends it.
  await until(async () => (await w.fake.aborted()) >= 1, 'the fake llama-server to observe the client disconnect', 10_000)
  const holders = w.executor.rows<{ status: string }>('SELECT status FROM remote_dispatch_holders')
  assert.ok(holders.length >= 1, 'the dispatch holder was durably recorded before the model call')
  assert.ok(holders.every(holder => holder.status !== 'completed' && holder.status !== 'canceled'), JSON.stringify(holders))
  assert.equal((await w.fake.count('/completion')), 1, 'the aborted call was not retried on the dead executor')

  // A restart (the operator's `systemctl --user restart`) is reachable again; the home's transient-call retry re-sends the
  // interrupted prompt to it. Asserting the retry and one further call proves the relay continues; the acceptance gates that
  // would turn that into a completed run need the K4 container image, which this sandbox does not provide.
  await w.fake.configure({ completionDelayMs: 0 })
  w.executor.spawn()
  await w.executor.wait('started')
  await until(async () => (await w.fake.requests('/completion')).some(request => request.body.prompt === interrupted.body.prompt),
    'the home retry to reach the restarted executor', 90_000)
  const retriedAt = await w.fake.count('/completion')
  await until(async () => (await w.fake.count('/completion')) > retriedAt, 'the relay to continue after the retry', 60_000)
  assert.equal(await w.fake.aborted(), 1, 'the restarted executor completed the retry instead of aborting it')
  const status = await w.relayStatus('live-shutdown')
  assert.notEqual(status.status, 'failed', JSON.stringify(status))
  assert.notEqual(status.status, 'canceled', JSON.stringify(status))
})

test('SIGTERM on the home during a remote call records the stop, not a retry, and settles its pin journal', { timeout: 240_000 }, async t => {
  const w = await createLiveWorld(t, { fake: { completionDelayMs: 60_000 } })
  await w.registerProject()
  const started = await w.startRelay('live-home-stop', 2)
  assert.equal(started.status, 202, JSON.stringify(started.body))
  await until(async () => (await w.fake.count('/completion')) >= 1, 'the delayed completion to reach the fake llama-server', 60_000)
  const row = w.home.one<{ run_id: string; session_id: string }>('SELECT run_id, session_id FROM relay_public_starts WHERE key=?', 'live-home-stop')
  assert.ok(row, 'the relay start is recorded')
  assert.equal(w.home.child.kill('SIGTERM'), true)
  const exit = await w.home.exit
  assert.equal(exit.code, 0, `a clean home stop exits 0 (signal ${exit.signal})\n${w.home.stderr.join('').slice(-2000)}`)
  assert.equal(w.home.events.some(event => event.event === 'stop'), false, 'the home has no forced stop line')
  const events = w.home.rows<{ type: string; payload: string }>('SELECT type, payload FROM session_events WHERE session_id=? ORDER BY seq', row!.session_id)
  const notes = events.filter(event => event.type === 'agent.note').map(event => JSON.parse((JSON.parse(event.payload) as { text: string }).text) as Record<string, unknown>)
  assert.equal(notes.some(note => note['relay'] === 'call_retry'), false, 'a graceful stop is not a transient failure')
  const errors = events.filter(event => event.type === 'error').map(event => (JSON.parse(event.payload) as { code: string }).code)
  assert.equal(errors.at(-1), 'relay_stopped', JSON.stringify(errors))
  assert.equal(w.home.count('SELECT COUNT(*) n FROM federation_relay_pin_journal'), 0, 'the acknowledged unpin deleted its journal row')
})

test('the home role installs no forced stop bound while the executor keeps it', () => {
  assert.equal(stopBoundMsFor('home', undefined), undefined)
  assert.equal(stopBoundMsFor('home', 25), undefined, 'a requested bound is still refused for the home role')
  assert.equal(stopBoundMsFor('executor', undefined), MS1_LIVE_STOP_BOUND_MS)
  assert.equal(stopBoundMsFor('executor', 25), 25)
  assert.equal(stopBoundMsFor(undefined, 25), 25, 'a plain start keeps its caller-requested bound')
  assert.equal(stopBoundMsFor(undefined, undefined), undefined)
})

test('a close past the stop bound emits exactly one forced JSON line and exits non-zero', async () => {
  let finish!: () => void
  const closing = new Promise<void>(resolve => { finish = resolve })
  const lines: string[] = [], exits: number[] = []
  const startedAt = Date.now()
  runBoundedStop(() => closing, { boundMs: 20, flushMs: 5, exit: code => exits.push(code),
    forced: () => lines.push(JSON.stringify({ event: 'stop', forced: true })) })
  await until(() => exits.length > 0, 'the forced exit', 2_000)
  assert.ok(Date.now() - startedAt >= 20, 'the forced path waits for the bound')
  assert.deepEqual(lines, ['{"event":"stop","forced":true}'])
  assert.deepEqual(exits, [1])
  finish()
  await sleep(20)
  assert.deepEqual(exits, [1], 'a close that settles after the bound never turns the forced stop into a clean exit')
})

test('a close inside the stop bound exits zero without a forced line', async () => {
  const lines: string[] = [], exits: number[] = []
  runBoundedStop(async () => undefined, { boundMs: 500, flushMs: 5, exit: code => exits.push(code), forced: () => lines.push('unexpected') })
  await until(() => exits.length > 0, 'the clean exit', 2_000)
  assert.deepEqual(exits, [0])
  assert.deepEqual(lines, [])
})
