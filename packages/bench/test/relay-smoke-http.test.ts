import assert from 'node:assert/strict'
import test from 'node:test'
import { relayStartInputSchema, sessionEventsQuery } from '@guanxi/contract'
import { HttpRelaySource, SmokeSourceError, isDefinitiveStartRefusal, loopbackOrigin } from '../src/relay-smoke-source.ts'
import { memoryStore, runSmoke } from '../src/relay-smoke-run.ts'
import { ARM, serve } from './relay-smoke-rig.ts'
import { config } from './relay-smoke-helpers.ts'

test('the HTTP source drives a full cohort through the owner API shapes and labels it recorded', async () => {
  const rig = await serve()
  try {
    const source = new HttpRelaySource({ [ARM]: { url: rig.url } })
    const result = await runSmoke(config({ endpoint: { url: rig.url } }), { source, now: rig.clock.now, sleep: async () => {}, store: memoryStore() })
    assert.equal(result.exitCode, 0, JSON.stringify(result.summary.document))
    assert.equal(result.measurement!.declaredOrigin, 'recorded_observation')
    assert.equal(result.report!.realEvidenceCredit, 0)
    assert.equal(result.summary.trials[0]!.cycles, 5)
    assert.equal(result.summary.trials[0]!.ledgerRead, false, 'no home database configured: ledger groups stay unknown')
    assert.ok(rig.requests.some(r => r.startsWith('POST /api/relay')))
    assert.ok(rig.requests.filter(r => r.includes('/events?')).length >= 2, 'events are paged')
    assert.ok(rig.requests.every(r => !r.includes('..')))
  } finally { await rig.close() }
})

test('transport failures are fixed codes and never echo the response body', async () => {
  for (const [mode, code] of [['http500', 'relay_http_failed'], ['html', 'response_invalid'], ['status', 'response_invalid']] as const) {
    const rig = await serve({ corrupt: mode })
    try {
      const source = new HttpRelaySource({ [ARM]: { url: rig.url } })
      const input = relayStartInputSchema.parse({ key: 'k1', projectId: 'p', connectionId: 'c', model: 'm', consent: 'full-access', domains: [], caps: { cycles: 3, tokens: null, moneyMicros: 0, wallMs: null },
        plan: { revision: 'r', base: 'a'.repeat(40), goal: 'g', protectedPaths: [], items: [{ id: 'I01', title: 't', dependsOn: [], acceptance: ['node'], protectedPaths: [] }] } })
      const error = await source.start(ARM, input).then(() => null, e => e as SmokeSourceError)
      assert.equal(error?.code, code, mode)
      assert.ok(!String(error?.message).includes('LEAK-MARKER') && !String(error?.stack).includes('LEAK-MARKER'))
    } finally { await rig.close() }
  }
  const rig = await serve({ corrupt: 'events' })
  try {
    const source = new HttpRelaySource({ [ARM]: { url: rig.url } })
    await source.start(ARM, relayStartInputSchema.parse({ key: 'k2', projectId: 'p', connectionId: 'c', model: 'm', consent: 'full-access', domains: [], caps: { cycles: 3, tokens: null, moneyMicros: 0, wallMs: null },
      plan: { revision: 'r', base: 'a'.repeat(40), goal: 'g', protectedPaths: [], items: [{ id: 'I01', title: 't', dependsOn: [], acceptance: ['node'], protectedPaths: [] }] } }))
    const status = await source.status(ARM, 'k2')
    await assert.rejects(source.events(ARM, status.sessionId!, 0), { code: 'response_invalid' })
  } finally { await rig.close() }
  await assert.rejects(new HttpRelaySource({ [ARM]: { url: 'http://127.0.0.1:1' } }).status(ARM, 'k'), { code: 'endpoint_unreachable' })
  await assert.rejects(new HttpRelaySource({ [ARM]: { url: 'http://127.0.0.1:1' } }).status('other', 'k'), { code: 'arm_endpoint_unknown' })
})

test('only loopback http origins are accepted, redirects are refused', async () => {
  for (const bad of ['http://example.com', 'http://10.0.0.1:80', 'https://127.0.0.1', 'http://127.0.0.1/x', 'http://127.0.0.1/?a=1', 'http://u:p@127.0.0.1', 'ftp://127.0.0.1', 'nope']) {
    assert.throws(() => loopbackOrigin(bad), { code: 'endpoint_invalid' }, bad)
  }
  assert.equal(loopbackOrigin('http://localhost:4551').hostname, 'localhost')
  let init: RequestInit | undefined
  const source = new HttpRelaySource({ [ARM]: { url: 'http://127.0.0.1:4551' } }, { transport: (async (_u: unknown, i?: RequestInit) => { init = i; return new Response(JSON.stringify({ code: 'relay_not_found' }), { status: 404 }) }) as typeof fetch })
  await assert.rejects(source.status(ARM, 'x'), { code: 'relay_not_found' })
  assert.equal(init?.redirect, 'error')
})


const START_INPUT = () => relayStartInputSchema.parse({ key: 'k1', projectId: 'p', connectionId: 'c', model: 'm', consent: 'full-access', domains: [], caps: { cycles: 3, tokens: null, moneyMicros: 0, wallMs: null },
  plan: { revision: 'r', base: 'a'.repeat(40), goal: 'g', protectedPaths: [], items: [{ id: 'I01', title: 't', dependsOn: [], acceptance: ['node'], protectedPaths: [] }] } })
const STATUS = { key: 'k1', runId: null, sessionId: null, status: 'preparing', error: null, source: 'start-owner', observedAt: '2026-11-01T00:00:00.000Z', confidence: 'observed', runtime: null, runtimeAgeMs: null, meter: null, reserves: null }
/** A transport that answers after `delayMs` unless its signal fires first, and records the deadline it was given. */
const slowTransport = (delayMs: number) => (async (_url: unknown, init?: RequestInit) => {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs)
    init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
  })
  return new Response(JSON.stringify(STATUS), { status: 202 })
}) as typeof fetch

test('the start and stop deadlines are far longer than an ordinary request, and a timeout is reported as a timeout', async () => {
  const source = new HttpRelaySource({ [ARM]: { url: 'http://127.0.0.1:4551' } }, { transport: slowTransport(150), timeoutMs: 20, startTimeoutMs: 2000, stopTimeoutMs: 2000 })
  await assert.doesNotReject(source.start(ARM, START_INPUT()), 'a start slower than a status request still completes')
  await assert.doesNotReject(source.stop(ARM, 'k1'), 'so does a stop')
  await assert.rejects(source.status(ARM, 'k1'), { code: 'timeout' })
  const tight = new HttpRelaySource({ [ARM]: { url: 'http://127.0.0.1:4551' } }, { transport: slowTransport(150), timeoutMs: 2000, startTimeoutMs: 20 })
  await assert.rejects(tight.start(ARM, START_INPUT()), { code: 'timeout' })
  const defaults = new HttpRelaySource({ [ARM]: { url: 'http://127.0.0.1:4551' } }, { transport: slowTransport(1) })
  await assert.doesNotReject(defaults.start(ARM, START_INPUT()))
})

test('a transport failure or timeout is not a definitive refusal; a coded relay answer is', () => {
  for (const code of ['timeout', 'endpoint_unreachable', 'response_invalid', 'relay_http_failed', 'aborted', 'relay_not_found']) assert.equal(isDefinitiveStartRefusal(code), false, code)
  for (const code of ['runtime_meter_unavailable', 'relay_project_unavailable', 'relay_policy_invalid', 'egress_not_ready', 'content_withheld', 'judge_config_invalid', 'relay_idempotency_conflict', 'validation_failed']) assert.equal(isDefinitiveStartRefusal(code), true, code)
})

test('the relay codes the routes can answer with are kept, not flattened to a generic failure', async () => {
  for (const code of ['relay_project_unavailable', 'relay_policy_invalid', 'egress_not_ready', 'content_withheld', 'judge_config_invalid']) {
    const source = new HttpRelaySource({ [ARM]: { url: 'http://127.0.0.1:4551' } }, { transport: (async () => new Response(JSON.stringify({ code }), { status: 503 })) as typeof fetch })
    await assert.rejects(source.start(ARM, START_INPUT()), { code })
  }
})

test('the events request satisfies the inspector query contract', async () => {
  const seen: string[] = []
  const source = new HttpRelaySource({ [ARM]: { url: 'http://127.0.0.1:4551' } }, { transport: (async (url: URL) => { seen.push(String(url)); return new Response(JSON.stringify({ sessionId: 's1', events: [], nextAfter: 0, lastSeq: 0, hasMore: false })) }) as typeof fetch })
  await source.events(ARM, 's1', 41)
  const url = new URL(seen[0]!)
  const query = sessionEventsQuery.parse(Object.fromEntries(url.searchParams))
  assert.deepEqual([query.after, query.limit, query.eventVersion], [41, 500, 3])
})
