import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { RELAY_RUNTIME_PROBE, type LocalInferenceJob, type RemoteAttemptOffer, type SignedDispatchGrant, type SignedDispatchEvent } from '@guanxi/contract/federation'
import { canonical, hash, signValue } from '../../src/federation/crypto.ts'
import { ConnectionJudgeModel } from '../../src/relay/judge-model.ts'
import { fakeRender, fakeTokens } from '../fixtures/fake-llama-server.ts'
import { RemoteRelayRuntime } from '../../src/relay/remote-runtime.ts'
import { requestAsync } from '../../src/relay/budget.ts'
import { remoteFixture, until, type Sent } from './remote-fixture.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const rendered = (prompt: string) => fakeRender(prompt, { template: 'chat' }, false)
const exact = (prompt: string) => fakeTokens(rendered(prompt), true)
const grants = (sent: Sent[]) => sent.filter(s => s.path === '/attempts/dispatch').map(s => (s.body as SignedDispatchGrant).grant)
const events = (f: Awaited<ReturnType<typeof remoteFixture>>) => {
  try {
    return f.target.db.prepare('SELECT payload FROM remote_dispatch_events ORDER BY id,seq').all().map(row => (JSON.parse(String(row.payload)) as SignedDispatchEvent).entry.event)
  } catch { return [] }   // the ledger is created at the first dispatch
}
const terminals = (f: Awaited<ReturnType<typeof remoteFixture>>) => events(f).flatMap(e => e.kind === 'terminal' ? [e] : [])
async function code(promise: Promise<unknown>): Promise<string> {
  try { await promise } catch (error) { return String((error as { code?: unknown }).code ?? (error as Error).message) }
  return 'resolved'
}

test('a relay model call executes on the executor, is counted by its llama-server exactly and the child ledger holds the remote tokens', async t => {
  const f = await remoteFixture(t), r = await f.relay()
  const prompt = 'Summarize the plan for the fixture.'
  const reply = await r.call(prompt)
  assert.equal(reply.text, '{"action":"handoff"}')
  assert.equal(reply.inputTokens, exact(prompt), 'the executor evaluated exactly the tokens it counted')
  assert.equal(reply.inputTruncated, false)
  const posts = await f.completions()
  assert.equal(posts.length, 1); assert.equal(posts[0]!.body.prompt, rendered(prompt))
  // The counted bytes, the granted bytes and the evaluated bytes are one string.
  const counts = f.sent.filter(s => s.path === '/attempts/runtime/count').map(s => (s.body as { content: string }).content)
  const [grant] = grants(f.sent)
  assert.equal(grants(f.sent).length, 1)
  assert.ok(counts.includes(prompt)); assert.equal(grant!.job.messages[0]!.content, prompt)
  assert.deepEqual(grant!.job.counted, { contentSha256: sha(prompt), renderedSha256: sha(rendered(prompt)), tokens: exact(prompt),
    digest: grant!.job.counted!.digest, contextTokens: 16000 })
  assert.equal(sha(posts[0]!.body.prompt), grant!.job.counted!.renderedSha256)
  // The remote tokens are the child run's ledger, atomically with its completion; the relay run records none of them.
  const child = grant!.offer.runId
  assert.equal(f.home.runs.get(child).state, 'completed'); assert.equal(f.home.runs.get(child).session_id, 'relay-session')
  const rows = f.costs(child)
  assert.equal(rows.length, 1); assert.equal(rows[0]!.entry_key, `remote-dispatch:${grant!.offer.id}`)
  assert.equal(rows[0]!.input_tokens, exact(prompt)); assert.equal(rows[0]!.output_tokens, fakeTokens('{"action":"handoff"}', false))
  assert.equal(f.costs('relay').length, 0); assert.equal(f.home.runs.get('relay').state, 'working')
  // The relay run's trace links the call to its child, written under the relay's own fence.
  const notes = f.home.log.readAll('relay-session', 'person').filter(e => e.type === 'agent.note').map(e => (e.data as { text: string }).text)
  assert.ok(notes.some(text => text.includes('remote_call') && text.includes(child) && text.includes(grant!.offer.id)), JSON.stringify(notes))
  assert.equal((Reflect.get(f.home.federation.attemptDispatch!, 'waiters') as Map<string, unknown>).size, 0, 'no waiter outlives its call')
  // Only the relay run was ever pinned; the child's pin is derived from it, never separately.
  assert.equal(f.pins.length, 1); assert.equal(f.pins[0]!.runId, 'relay')
  assert.throws(() => f.target.federation.replicas.binding(child), /unknown_stream/)
  // The home counted and rendered nothing itself: it has no llama-server and only the executor's fake saw a request.
  assert.ok((await f.fake.count('/tokenize')) >= 2)
  assert.equal(f.tg.snapshot().activeLease, null); assert.equal(f.hg.snapshot().activeLease, null)
})

test('a model call settles with the F2 events and without any permit of the home hardware', async t => {
  const f = await remoteFixture(t), r = await f.relay()
  let during: unknown = 'unset'
  f.rules.push(path => { if (path === '/attempts/dispatch') during = f.hg.snapshot().activeLease })
  await r.call('Check the home governor.')
  assert.equal(during, null, 'the home governor holds nothing while the executor works')
  for (const path of ['/attempts/runtime/observe', '/attempts/runtime/count', '/attempts/offers', '/attempts/dispatch', '/attempts/renew', '/attempts/events']) {
    assert.ok(f.seen.includes(path), path)
  }
})

test('the synchronous exact count only recalls answers the executor already gave and refuses everything else', async t => {
  const f = await remoteFixture(t), r = await f.relay()
  await r.model.countAsync!('counted string')
  assert.equal(r.model.count('counted string'), exact('counted string'))
  assert.throws(() => r.model.count('counted string '), /runtime_count_invalid/, 'one byte different is a different, uncounted string')
  assert.throws(() => r.model.count('never counted'), /runtime_count_invalid/)
  // An uncounted prompt cannot reach the dispatcher either: nothing is offered.
  assert.equal(await code(r.call('never counted either', { prime: false })), 'provider_failed')
  assert.equal(f.seen.includes('/attempts/offers'), false); assert.equal((await f.completions()).length, 0)
})

test('an executor that evaluates other tokens than it counted fails the call closed and nothing is accepted', async t => {
  const f = await remoteFixture(t, { fake: { evaluatedSkew: 1 } }), r = await f.relay()
  assert.equal(await code(r.call('Mismatch fixture.')), 'provider_failed')
  const [terminal] = terminals(f)
  assert.equal(terminal!.outcome, 'failed'); assert.equal(terminal!.reason, 'truncation_protocol'); assert.equal(terminal!.content, '')
  const child = grants(f.sent)[0]!.offer.runId
  assert.equal(f.home.runs.get(child).state, 'failed'); assert.equal(f.costs(child).length, 0)
})

test('tampered counted evidence is refused by the executor before the model sees a token', async t => {
  const f = await remoteFixture(t), r = await f.relay(), content = 'Tampered evidence fixture.'
  await r.model.countAsync!(content)
  const real = { contentSha256: sha(content), renderedSha256: sha(rendered(content)), tokens: exact(content), digest: '', contextTokens: 16000 }
  real.digest = (await f.llama.observe(f.llama.model, new AbortController().signal)).digest
  const dispatch = async (counted: typeof real) => {
    const childId = `tamper-${sha(canonical(counted)).slice(0, 8)}`
    f.home.runs.create({ id: childId, sessionId: 'relay-session' })
    const offer = f.home.federation.prepareDispatch(childId, 'target', { kind: 'local_inference', model: 'fixture', context: 16000, outputTokens: 1000,
      deadline: f.home.time + 30_000, messages: [{ role: 'user', content }], counted }, 4000, { runId: 'relay', epoch: 1 })
    const channel = f.channel('home'), receipt = await channel.offer(offer)
    await channel.dispatch(f.home.federation.grantDispatch(offer.id, receipt))
    const terminal = await f.home.federation.attemptDispatch!.awaitTerminal(offer.id, AbortSignal.timeout(5000), () => undefined, 5)
    return terminal
  }
  for (const [name, counted, reason] of [
    ['rendering hash', { ...real, renderedSha256: sha('another rendering') }, 'runtime_counter_mismatch'],
    ['token count', { ...real, tokens: real.tokens + 1 }, 'runtime_counter_mismatch'],
    ['model digest', { ...real, digest: 'sha256:' + '0'.repeat(64) }, 'runtime_identity_changed'],
    ['window', { ...real, contextTokens: 8000 }, 'runtime_identity_changed'],
  ] as const) {
    const terminal = await dispatch(counted)
    assert.equal(terminal.outcome, 'failed', name); assert.equal(terminal.reason, reason, name)
  }
  assert.equal((await f.completions()).length, 0, 'no tampered request reached /completion')
  // The identical, untampered evidence still dispatches: the refusals above are specific to the tamper.
  assert.equal((await dispatch(real)).outcome, 'completed'); assert.equal((await f.completions()).length, 1)
})

test('a counted job without a pinned relay parent, or for another model, never dispatches', async t => {
  const f = await remoteFixture(t), r = await f.relay()
  const counted = { contentSha256: sha('x'), renderedSha256: sha('y'), tokens: 5, digest: 'sha256:d', contextTokens: 16000 }
  const job = { kind: 'local_inference' as const, model: 'fixture', context: 16000, outputTokens: 100, deadline: f.home.time + 30_000, messages: [{ role: 'user' as const, content: 'x' }], counted }
  f.home.runs.create({ id: 'orphan', sessionId: 'relay-session' })
  assert.throws(() => f.home.federation.prepareDispatch('orphan', 'target', job, 4000), /dispatch_binding/, 'the home refuses to build one')
  // A misbehaving home that signs one anyway: the executor refuses it on its own.
  f.target.federation.replicas.bind({ streamId: 'orphan', kind: 'run', sessionId: 'relay-session', ownerAccountId: 'owner', homeNodeId: 'home', homeEpoch: 1 })
  const plain = { ...job }; delete (plain as { counted?: unknown }).counted
  const offer = f.home.federation.prepareDispatch('orphan', 'target', plain, 4000)
  const receipt = await f.channel('home').offer(offer), grant = f.home.federation.grantDispatch(offer.id, receipt)
  const edited = { ...grant.grant, job, jobHash: hash(job) }
  await assert.rejects(f.target.federation.receiveDispatch(f.homeCtx, { grant: edited, signature: signValue(f.home.keys.privateKey, edited) }), /dispatch_binding/)
  assert.equal((await f.completions()).length, 0); assert.equal(r.run.id, 'relay')
})

test('an observation older than the host maximum age is refused, not refreshed silently, and nothing is offered', async t => {
  const f = await remoteFixture(t, { maximumAgeMs: 10_000 }), r = await f.relay()
  await r.model.countAsync!('fresh enough')
  f.home.time += 20_000; f.target.time += 20_000
  assert.throws(() => r.model.count('fresh enough'), /runtime_observation_stale/)
  assert.equal(await code(r.model.countAsync!('another string')), 'runtime_observation_stale')
  const offers = f.seen.filter(p => p === '/attempts/offers').length
  assert.equal(await code(r.call('stale call')), 'runtime_observation_stale')
  assert.equal(f.seen.filter(p => p === '/attempts/offers').length, offers)
  // A fresh observation makes the same meter usable again: staleness is about time, not a latched failure.
  await r.model.observe(); assert.equal(r.model.count('fresh enough'), exact('fresh enough'))
})

test('replayed, forged, re-signed and re-attributed evidence is not evidence for this request', async t => {
  const f = await remoteFixture(t), r = await f.relay()
  const binding = { homeNodeId: 'home', executorNodeId: 'target', model: 'fixture', run: null }
  // Capture a genuine answer to an earlier request.
  let captured: unknown
  f.afters.push(async (path, response) => { if (path === '/attempts/runtime/observe') captured = await response.clone().json() })
  const channel = f.channel('home')
  await channel.relayObserve({ binding, challenge: 'first-challenge' })
  await until(() => captured !== undefined)
  const signed = captured as { entry: Record<string, unknown>; signature: string }
  const respond = (body: unknown) => f.overrides.push(async path => path === '/attempts/runtime/observe' ? Response.json(body) : undefined)
  respond(signed)
  assert.equal(await code(channel.relayObserve({ binding, challenge: 'second-challenge' })), 'relay_evidence_mismatch', 'a replayed answer carries the old challenge')
  f.overrides.length = 0
  for (const [name, body] of [
    ['forged signature', { ...signed, signature: 'A'.repeat(86) }],
    ['edited digest', { entry: { ...signed.entry, digest: 'sha256:other', challenge: 'second-challenge' }, signature: signed.signature }],
    ['signed by the home itself', { entry: { ...signed.entry, challenge: 'second-challenge' }, signature: signValue(f.home.keys.privateKey, { ...signed.entry, challenge: 'second-challenge' }) }],
    ['re-attributed executor', (() => { const entry = { ...signed.entry, challenge: 'second-challenge', executorNodeId: 'home' }; return { entry, signature: signValue(f.target.keys.privateKey, entry) } })()],
    ['other binding', (() => { const entry = { ...signed.entry, challenge: 'second-challenge', binding: { ...binding, model: 'elsewhere' } }; return { entry, signature: signValue(f.target.keys.privateKey, entry) } })()],
  ] as const) {
    respond(body)
    const failure = await code(channel.relayObserve({ binding, challenge: 'second-challenge' }))
    assert.ok(['invalid_signature', 'relay_evidence_mismatch'].includes(failure), `${name}: ${failure}`)
    f.overrides.length = 0
  }
  // The same defects at the relay layer surface as an unknown identity, never as facts.
  respond(signed)
  assert.equal(await code(r.model.observe()), 'runtime_identity_unknown')
  f.overrides.length = 0
  assert.ok((await r.model.observe()).tokens > 0)
})

test('an executor without the relay runtime capability, a revoked peer or an unreachable node yields no facts', async t => {
  const none = await remoteFixture(t, { noRelayRuntime: true })
  assert.equal(await code(none.relay()), 'runtime_meter_unavailable')
  assert.equal(none.seen.some(p => p.startsWith('/attempts/runtime')), false, 'capability absent: no relay request was even sent')
  const down = await remoteFixture(t)
  down.rules.push(path => { if (path.startsWith('/attempts/runtime')) throw new Error('fixture partition') })
  assert.equal(await code(down.relay()), 'runtime_meter_unavailable')
  const revoked = await remoteFixture(t)
  revoked.target.federation.revokePeer('home')
  assert.equal(await code(revoked.relay()), 'runtime_meter_unavailable')
  assert.equal((await none.completions()).length + (await down.completions()).length + (await revoked.completions()).length, 0)
})

test('the executor refuses unpinned runs, a wrong epoch, other models and real content before a run exists', async t => {
  const unpinned = await remoteFixture(t)
  unpinned.withholdPin()
  assert.equal(await code(unpinned.relay()), 'runtime_identity_unknown')
  const epoch = await remoteFixture(t)
  epoch.pinWithEpoch(7)
  assert.equal(await code(epoch.relay()), 'runtime_identity_unknown')
  const f = await remoteFixture(t), channel = f.channel('home')
  const binding = { homeNodeId: 'home', executorNodeId: 'target', model: 'fixture', run: null }
  assert.equal(await code(channel.relayCount({ binding, challenge: 'c1', content: 'real prompt text' })), 'peer_refused')
  const probe = await channel.relayCount({ binding, challenge: 'c2', content: RELAY_RUNTIME_PROBE })
  assert.equal(probe.count!.tokens, exact(RELAY_RUNTIME_PROBE))
  assert.equal(await code(channel.relayObserve({ binding: { ...binding, model: 'other-model' }, challenge: 'c3' })), 'peer_refused')
  assert.equal(await code(channel.relayObserve({ binding: { ...binding, homeNodeId: 'target' }, challenge: 'c4' })), 'wrong_executor')
  // Counted content must come from a run pinned for this home.
  assert.equal(await code(channel.relayObserve({ binding: { ...binding, run: { runId: 'nope', sessionId: 's', fence: { attemptId: 'a', epoch: 1, token: 1 } } }, challenge: 'c5' })), 'peer_refused')
  assert.equal((await f.completions()).length, 0)
})

test('a changed model, build or window invalidates the meter and its remembered counts and dispatches nothing', async t => {
  const f = await remoteFixture(t), r = await f.relay()
  await r.model.countAsync!('remembered')
  for (const [name, patch] of [['window', { nCtx: 8000 }], ['build', { buildInfo: 'b1-other' }]] as const) {
    await f.fake.configure(patch)
    assert.equal(await code(r.model.observe()), 'runtime_identity_changed', name)
    await f.fake.configure({ nCtx: 16000, buildInfo: 'b0-fixture' })
  }
  await f.fake.configure({ buildInfo: 'b1-other' })
  assert.equal(await code(r.model.observe()), 'runtime_identity_changed')
  assert.throws(() => r.model.count('remembered'), /runtime_count_invalid/, 'an answer counted under the previous build is not an answer under this one')
  const offers = f.seen.filter(p => p === '/attempts/offers').length
  assert.equal(await code(r.call('after the change')), 'provider_failed', 'the dispatch-time observation saw another build')
  assert.equal(await code(r.model.observe()), 'runtime_identity_changed')
  assert.equal(f.seen.filter(p => p === '/attempts/offers').length, offers); assert.equal((await f.completions()).length, 0)
})

test('the grant expires while the executor prepares: no stale dispatch reaches /completion and nothing is accepted', async t => {
  const f = await remoteFixture(t), r = await f.relay(), prompt = 'Expire before the POST.'
  await r.model.countAsync!(prompt)
  await f.fake.configure({ tokenizeDelayMs: 400 })
  const before = await f.fake.count('/tokenize')
  const call = r.call(prompt, { prime: false }).catch((error: unknown) => error)
  await until(async () => (await f.fake.count('/tokenize')) > before)
  f.clock.mono += 10_000                  // the holder's TTL elapsed while its tokenizer answered
  const outcome = await call
  assert.ok(outcome instanceof Error)
  assert.equal((await f.completions()).length, 0, 'the executor must not POST after the grant expired')
  const [grant] = grants(f.sent)
  assert.equal(f.target.federation.attemptDispatch!.state(grant!.id).status, 'lost')
  assert.notEqual(f.home.runs.get(grant!.offer.runId).state, 'completed'); assert.equal(f.costs(grant!.offer.runId).length, 0)
  await f.target.federation.attemptDispatch!.settled(grant!.id)
  assert.equal(f.tg.snapshot().activeLease, null)
})

test('losing the relay fence while a call is pending cancels it at the executor and settles only after the ACK', async t => {
  const f = await remoteFixture(t, { fake: { completionDelayMs: 4000 } }), r = await f.relay(), order: string[] = []
  f.afters.push(path => { if (path === '/attempts/dispatch-cancel') order.push('ack') })
  const call = r.call('Pending when the fence is lost.').then(() => order.push('settled:ok'), () => order.push('settled:error'))
  await until(async () => (await f.fake.count('/completion')) === 1)
  f.home.runs.cancel('relay')            // the relay attempt is no longer the home's execution fence
  await call
  assert.deepEqual(order, ['ack', 'settled:error'], 'the call settled only after the executor acknowledged the cancel')
  const [grant] = grants(f.sent)
  assert.equal(f.target.federation.attemptDispatch!.state(grant!.id).status, 'canceled')
  assert.equal(f.home.runs.get(grant!.offer.runId).state, 'canceled'); assert.equal(f.costs(grant!.offer.runId).length, 0)
  await until(async () => (await f.fake.aborted()) >= 1)
  await f.target.federation.attemptDispatch!.settled(grant!.id)
  assert.equal(f.tg.snapshot().activeLease, null); assert.equal((await f.completions()).length, 1, 'nothing was dispatched after the loss')
})

test('a relay fence lost before the call dispatches nothing and creates no child run', async t => {
  const f = await remoteFixture(t), r = await f.relay()
  await r.model.countAsync!('lost before')
  f.home.runs.cancel('relay')
  const runs = (f.home.db.prepare('SELECT COUNT(*) n FROM durable_runs').get() as { n: number }).n
  const runtimeRequests = f.seen.filter(p => p.startsWith('/attempts/runtime')).length
  assert.equal(await code(r.model.countAsync!('counted after the loss')), 'stale_lease', 'evidence is neither requested nor used under a deposed attempt')
  assert.equal(await code(r.model.observe()), 'stale_lease')
  assert.equal(f.seen.filter(p => p.startsWith('/attempts/runtime')).length, runtimeRequests, 'no relay request left the home after the loss')
  assert.equal(await code(r.call('lost before', { prime: false })), 'provider_failed')
  assert.equal((f.home.db.prepare('SELECT COUNT(*) n FROM durable_runs').get() as { n: number }).n, runs)
  assert.equal(f.seen.includes('/attempts/offers'), false); assert.equal((await f.completions()).length, 0)
})

test('the final fence check, the request shape check and the signed dispatch request share one synchronous stretch', async t => {
  const f = await remoteFixture(t), r = await f.relay()
  let queued = false, atRequest: boolean | undefined
  f.probes.push(path => { if (path === '/attempts/dispatch') atRequest = queued })
  await r.call('One stretch.', { onStarted: () => queueMicrotask(() => { queued = true }) })
  assert.equal(atRequest, false, 'a microtask queued by the fenced start observation ran before the request was issued')
  assert.equal(queued, true)
})

test('an executor that disappears leaves the child interrupted and the call failed, never completed', async t => {
  const f = await remoteFixture(t, { fake: { completionDelayMs: 600 }, ttlMs: 300, safetyMs: 50 }), r = await f.relay()
  let down = false
  f.rules.push(() => { if (down) throw new Error('fixture partition') })
  const call = r.call('The executor vanishes.').catch((error: unknown) => error)
  await until(async () => (await f.fake.count('/completion')) === 1)
  down = true                                   // renewals, events and cancels all fail from now on
  const partitioned = f.seen.length
  f.home.time += 5_000                          // the child's lease (granted for one holder TTL) lapses; the relay's does not
  const outcome = await call
  assert.ok(outcome instanceof Error)
  const [grant] = grants(f.sent), child = grant!.offer.runId
  assert.equal(f.home.runs.get(child).state, 'interrupted'); assert.equal(f.costs(child).length, 0)
  assert.equal(f.home.runs.get('relay').state, 'working')
  assert.ok(f.seen.slice(partitioned).filter(p => p === '/handshake').length >= 2, 'the cancel was attempted and retried; it only reaches the executor after negotiation')
})

test('cancel without an ACK is retried until the holder window ends, and by then the executor holder has fenced itself', async t => {
  const f = await remoteFixture(t, { fake: { completionDelayMs: 3000 }, ttlMs: 400, safetyMs: 50 }), r = await f.relay()
  f.rules.push(path => { if (path === '/attempts/dispatch-cancel') throw new Error('fixture partition') })
  const abort = new AbortController(), call = r.call('Cancel into a partition.', { signal: abort.signal }).catch((error: unknown) => error)
  await until(async () => (await f.fake.count('/completion')) === 1)
  const [grant] = grants(f.sent), started = Date.now()
  abort.abort()
  setTimeout(() => { f.clock.mono += 10_000 }, 80)    // the wait stands for real elapsed time: the holder's TTL passes on its own clock
  assert.ok((await call) instanceof Error)
  assert.ok(Date.now() - started >= 380, `settled after ${Date.now() - started} ms, before the holder window`)
  assert.ok(f.seen.filter(p => p === '/attempts/dispatch-cancel').length >= 2, 'the cancel was retried')
  assert.notEqual(f.target.federation.attemptDispatch!.state(grant!.id).status, 'running', 'the holder is no longer running when the call settles')
  assert.equal(f.home.runs.get(grant!.offer.runId).state, 'canceled')
  await f.target.federation.attemptDispatch!.settled(grant!.id)
  assert.equal(f.tg.snapshot().activeLease, null)
})

test('a cancel window shorter than the holder TTL cannot be configured, and a hanging cancel is bounded by the window', async t => {
  const f = await remoteFixture(t)
  assert.throws(() => new RemoteRelayRuntime({ federation: f.home.federation, runs: f.home.runs, executorNodeId: 'target', model: 'fixture', cancelWaitMs: 100 }), /relay_policy_invalid/,
    'the guarantee needs the window to cover the holder TTL')
  const slow = await remoteFixture(t, { fake: { completionDelayMs: 3000 }, ttlMs: 300, safetyMs: 50 }), r = await slow.relay()
  slow.rules.push(async path => { if (path === '/attempts/dispatch-cancel') await new Promise(resolve => setTimeout(resolve, 60_000).unref()) })
  const abort = new AbortController(), call = r.call('Hanging cancel.', { signal: abort.signal }).catch((error: unknown) => error)
  await until(async () => (await slow.fake.count('/completion')) === 1)
  const started = Date.now()
  abort.abort()
  assert.ok((await call) instanceof Error)
  assert.ok(Date.now() - started < 5000, 'a request that never answers cannot hold the relay past the window')
})

test('the executor never blocks its event loop on the synchronous bridge while serving a remote call', async t => {
  const f = await remoteFixture(t), original = Atomics.wait
  let waits = 0
  Atomics.wait = ((...args: Parameters<typeof Atomics.wait>) => { waits++; return original(...args) }) as typeof Atomics.wait
  try {
    const r = await f.relay()
    await r.call('No blocking wait on either node.')
    assert.equal(waits, 0)
    assert.equal(f.target.federation.attemptDispatch!.state(grants(f.sent)[0]!.id).status, 'completed')
  } finally { Atomics.wait = original }
})

test('no request exceeds the hard ceiling: H tokens dispatch, H plus one is refused before anything is offered', async t => {
  const f = await remoteFixture(t), r = await f.relay()
  const base = exact(''), words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')
  const H = 14_800
  const atCeiling = words(H - base)
  assert.equal(exact(atCeiling), H)
  const reply = await r.call(atCeiling)
  assert.equal(reply.inputTokens, H)
  const posts = await f.completions()
  assert.ok(posts.every(post => fakeTokens(post.body.prompt, true) <= H))
  const offers = f.seen.filter(p => p === '/attempts/offers').length
  assert.equal(await code(r.call(words(H - base + 1))), 'provider_failed', 'K3 wraps the context_ceiling refusal of the final prepared request')
  assert.equal(f.seen.filter(p => p === '/attempts/offers').length, offers); assert.equal((await f.completions()).length, 1)
  // Input plus the output reserve must also fit the loaded window, at the home before anything is offered...
  const big = words(15_500 - base)
  assert.equal(await code(r.call(big, { maxInput: 16_000, maxOutput: 1000 })), 'provider_failed')
  assert.equal(f.seen.filter(p => p === '/attempts/offers').length, offers); assert.equal((await f.completions()).length, 1)
})

test('the executor enforces the loaded window itself, whatever the home asked for', async t => {
  const f = await remoteFixture(t), r = await f.relay(), content = 'Window enforced by the executor.'
  await r.model.countAsync!(content)
  const seen = await f.llama.observe(f.llama.model, new AbortController().signal)
  const counted = { contentSha256: sha(content), renderedSha256: sha(rendered(content)), tokens: exact(content), digest: seen.digest, contextTokens: 16000 }
  f.home.runs.create({ id: 'greedy', sessionId: 'relay-session' })
  const offer = f.home.federation.prepareDispatch('greedy', 'target', { kind: 'local_inference', model: 'fixture', context: 16000, outputTokens: 16000,
    deadline: f.home.time + 30_000, messages: [{ role: 'user', content }], counted }, 4000, { runId: 'relay', epoch: 1 })
  const channel = f.channel('home'), receipt = await channel.offer(offer)
  await channel.dispatch(f.home.federation.grantDispatch(offer.id, receipt))
  const terminal = await f.home.federation.attemptDispatch!.awaitTerminal(offer.id, AbortSignal.timeout(5000), () => undefined, 5)
  assert.equal(terminal.outcome, 'failed'); assert.equal(terminal.reason, 'context_ceiling'); assert.equal((await f.completions()).length, 0)
  // A claimed window larger (or smaller) than the loaded one is refused too, even with every count and hash true.
  for (const claimed of [1_000_000, 8000]) {
    const id = `window-${claimed}`
    f.home.runs.create({ id, sessionId: 'relay-session' })
    const bigger = f.home.federation.prepareDispatch(id, 'target', { kind: 'local_inference', model: 'fixture', context: claimed, outputTokens: 500, deadline: f.home.time + 30_000,
      messages: [{ role: 'user', content }], counted }, 4000, { runId: 'relay', epoch: 1 })
    const receipt2 = await channel.offer(bigger)
    await channel.dispatch(f.home.federation.grantDispatch(bigger.id, receipt2))
    const refused = await f.home.federation.attemptDispatch!.awaitTerminal(bigger.id, AbortSignal.timeout(5000), () => undefined, 5)
    assert.equal(refused.outcome, 'failed', String(claimed)); assert.equal(refused.reason, 'context_ceiling', String(claimed))
  }
  assert.equal((await f.completions()).length, 0, 'the executor posted nothing for a window it does not have')
})

test('the host sees one session per start: an unbound use of the factory refuses and closing a session stops its calls', async t => {
  const f = await remoteFixture(t)
  assert.throws(() => f.remote.transport, /runtime_meter_unavailable/)
  assert.equal(await code(f.remote.observe()), 'runtime_meter_unavailable')
  const r = await f.relay()
  await r.prepared.release!()
  assert.equal(await code(r.call('after close', { prime: false })), 'provider_failed')
  assert.equal(await code(r.model.countAsync!('after close')), 'relay_stopped')
})

test('the judge model cannot be given a meter that needs a runtime transport, so a count never pairs with another runtime', async t => {
  const f = await remoteFixture(t), r = await f.relay()
  assert.throws(() => new ConnectionJudgeModel(f.h.connections, 'local', r.prepared.meter as never, f.home.scrubber, async () => null, 1000), /judge_config_invalid/)
})

test('K3 takes no home permit for a remote transport and still requires the pinned federation node label', async t => {
  const f = await remoteFixture(t), call = { runId: 'x', requestId: 'req', background: true as const }
  const request = { model: 'fixture', stream: false, think: false as const, messages: [{ role: 'user' as const, content: 'hi' }], options: { num_ctx: 100, num_predict: 10 } }
  let permit: unknown = 'unset'
  const stub = (host: string, nodeId = 'target') => ({ id: 'llama-server', host, usageSource: 'federation:test', remote: { nodeId },
    chat: async () => { permit = f.hg.snapshot().activeLease; return { model: 'fixture', created_at: '', done: true, message: { role: 'assistant' as const, content: 'ok' } } } })
  assert.equal((await f.h.connections.localChat('local', f.homeConnection.id, request, { ...call, transport: stub('federation://target') })).message?.content, 'ok')
  assert.equal(permit, null)
  for (const host of ['http://127.0.0.1:9', 'federation://elsewhere', 'federation://target/path']) {
    await assert.rejects(f.h.connections.localChat('local', f.homeConnection.id, request, { ...call, transport: stub(host) }))
  }
  // A transport that is not remote still needs a loopback origin and a permit.
  await assert.rejects(f.h.connections.localChat('local', f.homeConnection.id, request, { ...call, transport: { ...stub('federation://target'), remote: undefined } }))
})

test('the executor refuses relay requests from old, read-only, shared, unscoped or foreign peers', async t => {
  const f = await remoteFixture(t), binding = { homeNodeId: 'home', executorNodeId: 'target', model: 'fixture', run: null }
  const request = { binding, challenge: 'c' }, ctx = f.homeCtx
  await assert.rejects(f.target.federation.receiveRelayObserve({ ...ctx, version: { major: 1, minor: 3 } }, request), /contract_feature_unavailable/)
  await assert.rejects(f.target.federation.receiveRelayObserve({ ...ctx, readOnly: true }, request), /contract_read_only/)
  await assert.rejects(f.target.federation.receiveRelayObserve({ ...ctx, identity: f.target.keys.identity }, request), /owner_mismatch/, 'a node cannot ask itself on behalf of the home')
  const { identity: makeIdentity } = await import('../federation/harness.ts')
  for (const [name, overrides, expected] of [
    ['shared device', { trust: 'shared_device', admin: false, scopes: ['attempts'] }, /owner_mismatch/],
    ['no attempts scope', { scopes: ['config'] }, /scope_denied/],
    ['another account', { accountId: 'stranger', scopes: ['attempts'] }, /owner_mismatch/],
  ] as Array<[string, Parameters<typeof makeIdentity>[1], RegExp]>) {
    const peer = makeIdentity('phone-' + name.replace(/ /g, '-'), overrides)
    f.target.federation.trust(peer.identity)
    await assert.rejects(f.target.federation.receiveRelayObserve({ ...ctx, identity: peer.identity }, { binding: { ...binding, homeNodeId: peer.identity.id }, challenge: 'c' }), expected, name)
    await assert.rejects(f.target.federation.receiveRelayCount({ ...ctx, identity: peer.identity }, { binding: { ...binding, homeNodeId: peer.identity.id }, challenge: 'c', content: 'x' }), expected, name)
  }
  // Malformed and extended bodies are not parsed leniently.
  await assert.rejects(f.target.federation.receiveRelayObserve(ctx, { ...request, extra: true }))
  await assert.rejects(f.target.federation.receiveRelayCount(ctx, { binding, challenge: 'c' }))
  f.target.federation.close()
  await assert.rejects(f.target.federation.receiveRelayObserve(ctx, request))
})

test('count evidence exists only on a count and the wire schemas accept nothing extra', async () => {
  const { relayRuntimeEvidenceSchema, countedRequestSchema } = await import('@guanxi/contract/federation')
  const base = { kind: 'observe' as const, binding: { homeNodeId: 'h', executorNodeId: 'e', model: 'm', run: null }, challenge: 'c', executorNodeId: 'e', model: 'm',
    digest: 'd', contextTokens: 10, runtimeVersion: 'v', source: 's', observedAt: 1, count: null }
  assert.ok(relayRuntimeEvidenceSchema.safeParse(base).success)
  const count = { contentSha256: 'a'.repeat(64), renderedSha256: 'b'.repeat(64), tokens: 3 }
  assert.equal(relayRuntimeEvidenceSchema.safeParse({ ...base, count }).success, false, 'observe carries no count')
  assert.equal(relayRuntimeEvidenceSchema.safeParse({ ...base, kind: 'count' }).success, false, 'count needs its count')
  assert.ok(relayRuntimeEvidenceSchema.safeParse({ ...base, kind: 'count', count }).success)
  assert.equal(relayRuntimeEvidenceSchema.safeParse({ ...base, extra: 1 }).success, false)
  assert.equal(countedRequestSchema.safeParse({ ...count, digest: 'd', contextTokens: 10, extra: 1 }).success, false)
  assert.equal(countedRequestSchema.safeParse({ ...count, tokens: 0, digest: 'd', contextTokens: 10 }).success, false)
})

test('the home refuses a terminal result that does not echo the counted rendering and token count, even from a signed executor', async t => {
  const f = await remoteFixture(t), r = await f.relay()
  for (const [name, patch] of [['tokens', { inputTokens: exact('Forged result.') + 1 }], ['rendering', { renderedSha256: sha('another rendering') }], ['source', { source: 'ollama:/api/chat' as const }]] as const) {
    const prompt = `Forged result. ${name}`.replace('result. ', 'result.')
    const real = exact(prompt)
    let hold = true
    f.rules.length = 0
    f.rules.push(path => { if (hold && path === '/attempts/events') throw new Error('fixture partition') })   // only the forged events arrive
    await r.model.countAsync!(prompt)
    const dispatched = grants(f.sent).length
    const call = r.call(prompt, { prime: false }).catch((error: unknown) => error)
    const id = () => grants(f.sent).at(-1)!.id
    await until(() => grants(f.sent).length === dispatched + 1 && terminals(f).length === dispatched + 1)
    const rows = f.target.db.prepare('SELECT payload FROM remote_dispatch_events WHERE id=? ORDER BY seq').all(id()).map(row => (JSON.parse(String(row.payload)) as SignedDispatchEvent))
    const [started, final] = rows
    const entry = { ...final!.entry, event: { ...(final!.entry.event as object), ...patch, ...(name === 'tokens' ? {} : { inputTokens: real }) } } as SignedDispatchEvent['entry']
    const forged = { entry, hash: hash(entry), signature: signValue(f.target.keys.privateKey, entry) }
    const targetCtx = { ...f.homeCtx, identity: f.target.keys.identity }
    hold = false
    f.home.federation.receiveDispatchEvent(targetCtx, started!); f.home.federation.receiveDispatchEvent(targetCtx, forged)
    const outcome = await call
    assert.ok(outcome instanceof Error, `${name}: the forged terminal must not produce a reply`)
    assert.equal((outcome as { code?: string }).code, 'provider_failed', name)
  }
})

test('a count made by a server that is no longer the observed one is refused, not remembered', async t => {
  const f = await remoteFixture(t), r = await f.relay()
  await f.fake.configure({ buildInfo: 'b2-swapped' })                  // swapped after the last observation, before the count
  assert.equal(await code(r.model.countAsync!('counted by someone else')), 'runtime_identity_changed')
  await f.fake.configure({ buildInfo: 'b0-fixture' })
  assert.throws(() => r.model.count('counted by someone else'), /runtime_count_invalid/)
  assert.equal(await r.model.countAsync!('counted by someone else'), exact('counted by someone else'))
})

test('a fence lost inside the fenced start observation, a request that changes at the last check or an abort after negotiation sends no dispatch', async t => {
  const f = await remoteFixture(t), r = await f.relay()
  const mk = (content: string) => ({ model: 'fixture', stream: false, think: false as const, messages: [{ role: 'user' as const, content }], options: { num_ctx: 16000, num_predict: 1000 } })
  const transport = r.prepared.meter.transport!
  for (const text of ['request A', 'request B']) await r.model.countAsync!(text)
  // 1. The R1-fenced start observation fails: its error is the call's, and the request is never signed.
  assert.equal(await code(r.call('request A', { prime: false, onStarted: () => { throw new Error('fence lost') } })), 'provider_failed')
  assert.equal(f.seen.includes('/attempts/dispatch'), false)
  // 2. Both requests were counted, but the one that is about to be sent is not the one that was admitted.
  let n = 0
  await assert.rejects(transport.chat(mk('request A'), r.controller.signal, () => undefined, { authorizeDispatch: async () => undefined, prepare: () => mk(n++ === 0 ? 'request A' : 'request B') }), /runtime_request_changed/)
  assert.equal(f.seen.includes('/attempts/dispatch'), false)
  // 3. The call is aborted while the dispatch is still negotiating: the negotiated request must not follow it.
  const abort = new AbortController()
  let armed = false
  f.afters.push(path => { if (path === '/attempts/offers') armed = true })
  f.rules.push(async path => { if (armed && path === '/handshake') { armed = false; abort.abort(); await new Promise(resolve => setTimeout(resolve, 60)) } })
  await assert.rejects(transport.chat(mk('request A'), abort.signal, () => undefined, { authorizeDispatch: async () => undefined, prepare: () => mk('request A') }))
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(f.seen.includes('/attempts/dispatch'), false, 'nothing was sent after the abort')
  assert.equal((await f.completions()).length, 0)
  // Every abandoned reservation was cancelled and the executor is free.
  assert.equal(f.tg.snapshot().activeLease, null)
})

test('evidence that arrives after the relay fence was lost is neither used nor remembered', async t => {
  const f = await remoteFixture(t), r = await f.relay()
  let armed = true
  f.afters.push(path => { if (armed && path === '/attempts/runtime/count') { armed = false; f.home.runs.cancel('relay') } })
  assert.equal(await code(r.model.countAsync!('counted under a lost fence')), 'stale_lease')
  assert.throws(() => r.model.count('counted under a lost fence'), /runtime_count_invalid/)
  const g = await remoteFixture(t), s = await g.relay()
  let observe = true
  g.afters.push(path => { if (observe && path === '/attempts/runtime/observe') { observe = false; g.home.runs.cancel('relay') } })
  assert.equal(await code(s.model.observe()), 'stale_lease')
})

test('an offer still in flight when the call is aborted is cancelled after it lands, so no reservation outlives the call', async t => {
  const f = await remoteFixture(t), r = await f.relay(), abort = new AbortController()
  await r.model.countAsync!('abort during the offer')
  f.rules.push(async path => { if (path === '/attempts/offers') { setTimeout(() => abort.abort(), 20); await new Promise(resolve => setTimeout(resolve, 100)) } })
  assert.ok((await r.call('abort during the offer', { prime: false, signal: abort.signal }).catch((error: unknown) => error)) instanceof Error)
  const offerId = (f.sent.find(s => s.path === '/attempts/offers')!.body as { id: string }).id
  assert.equal(f.target.federation.attemptOffers!.read('home', offerId).status, 'canceled')
  assert.equal(f.tg.snapshot().activeLease, null); assert.ok(f.seen.includes('/attempts/cancel')); assert.equal(f.seen.includes('/attempts/dispatch'), false)
})

test('the child pin derives only from a pinned parent at its epoch, and a counted grant must be consistent end to end', async t => {
  const f = await remoteFixture(t), r = await f.relay(), content = 'Pin derivation fixture.'
  await r.model.countAsync!(content)
  const seen = await f.llama.observe(f.llama.model, new AbortController().signal)
  const counted = { contentSha256: sha(content), renderedSha256: sha(rendered(content)), tokens: exact(content), digest: seen.digest, contextTokens: 16000 }
  const job: LocalInferenceJob = { kind: 'local_inference', model: 'fixture', context: 16000, outputTokens: 500, deadline: f.home.time + 30_000, messages: [{ role: 'user', content }], counted }
  const channel = f.channel('home')
  let serial = 0
  const make = async () => {
    const id = `kid-${++serial}`
    f.home.runs.create({ id, sessionId: 'relay-session' })
    const offer = f.home.federation.prepareDispatch(id, 'target', job, 4000, { runId: 'relay', epoch: 1 })
    return { offer, id }
  }
  // Offers: wrong parent epoch, the parent as its own child, and a child that is pinned in its own right.
  const { offer } = await make()
  f.target.federation.replicas.bind({ streamId: 'other-pinned', kind: 'run', sessionId: 'relay-session', ownerAccountId: 'owner', homeNodeId: 'home', homeEpoch: 1 })
  for (const [name, edited] of [['wrong parent epoch', { ...offer, parent: { runId: 'relay', epoch: 2 } }], ['parent as child', { ...offer, runId: 'relay' }],
    ['pinned run as child', { ...offer, runId: 'other-pinned' }], ['unknown parent', { ...offer, parent: { runId: 'nobody', epoch: 1 } }]] as const) {
    await assert.rejects(f.target.federation.receiveAttemptOffer(f.homeCtx, edited), /not_home|unknown_stream/, name)
  }
  assert.equal((await channel.offer(offer)).status, 'reserved', 'the unedited offer is valid')
  await channel.cancelOffer({ offerId: offer.id, homeNodeId: 'home', executorNodeId: 'target' })
  // The home itself refuses a parent without a counted job, a counted job without a parent and a self-parent.
  f.home.runs.create({ id: 'plain', sessionId: 'relay-session' })
  const plain = { ...job }; delete (plain as { counted?: unknown }).counted
  assert.throws(() => f.home.federation.prepareDispatch('plain', 'target', plain, 4000, { runId: 'relay', epoch: 1 }), /dispatch_binding/)
  assert.throws(() => f.home.federation.prepareDispatch('plain', 'target', job, 4000), /dispatch_binding/)
  // Grants: the executor re-checks the same shape on its own.
  const forge = async (editJob: LocalInferenceJob, editOffer: (offer: RemoteAttemptOffer) => RemoteAttemptOffer, pinned = false) => {
    const { offer: fresh } = await make(), receipt = await channel.offer(fresh)
    // Without a parent the child would need a pin of its own; give it one so only the grant's own shape check is left.
    if (pinned) f.target.federation.replicas.bind({ streamId: fresh.runId, kind: 'run', sessionId: 'relay-session', ownerAccountId: 'owner', homeNodeId: 'home', homeEpoch: 1 })
    const granted = f.home.federation.grantDispatch(fresh.id, receipt)
    const edited = { ...granted.grant, job: editJob, jobHash: hash(editJob), offer: editOffer(granted.grant.offer) }
    try { return await f.target.federation.receiveDispatch(f.homeCtx, { grant: edited, signature: signValue(f.home.keys.privateKey, edited) }) }
    finally { await channel.cancelOffer({ offerId: fresh.id, homeNodeId: 'home', executorNodeId: 'target' }) }   // the single executor permit
  }
  const withModel = (model: string): LocalInferenceJob => ({ ...job, model })
  await assert.rejects(forge(plain, o => o), /dispatch_binding/, 'a parent without a counted job')
  await assert.rejects(forge(job, o => { const { parent, ...rest } = o; void parent; return rest }, true), /dispatch_binding/, 'a counted job without a parent')
  await assert.rejects(forge(withModel('another-model'), o => ({ ...o, resource: { ...o.resource, model: 'another-model' } })), /dispatch_binding/, 'a model this executor does not serve')
  await assert.rejects(forge({ ...job, messages: [{ role: 'user', content: 'a different message' }] }, o => o), /dispatch_binding/, 'a message other than the counted one')
  await assert.rejects(forge({ ...job, messages: [{ role: 'system', content }] }, o => o), /dispatch_binding/, 'a counted message that is not a user message')
  assert.equal((await f.completions()).length, 0)
})

test('a string larger than one signed message is reported above every ceiling, never counted, and the packer shrinks it', async t => {
  const f = await remoteFixture(t), r = await f.relay(), huge = 'w '.repeat(600_000)
  const counts = () => f.sent.filter(s => s.path === '/attempts/runtime/count').length
  const before = counts()
  assert.equal(await r.model.countAsync!(huge), Number.MAX_SAFE_INTEGER)
  assert.equal(counts(), before, 'it was never sent')
  assert.throws(() => r.model.count(huge), /runtime_count_invalid/, 'and never remembered')
  const measure = Object.assign((value: string) => r.model.countAsync!(value), { exact: true, async: true as const })
  for (const turns of [[huge, 'older turn', 'newest turn'], ['older turn', huge]]) {
    const out = await requestAsync('head', { turns }, measure, 4000)
    assert.ok(exact(out.text) <= 4000, 'the packed request fits'); assert.ok(out.dropped + out.cut > 0)
  }
})

test('the cancel path sends the cancel for the right resource and a home call deadline abandons a silent executor', async t => {
  const f = await remoteFixture(t, { fake: { completionDelayMs: 3000 }, callDeadlineMs: 150, ttlMs: 400, safetyMs: 50 }), r = await f.relay()
  const call = r.call('Deadline fixture.').catch((error: unknown) => error)
  await until(async () => (await f.fake.count('/completion')) === 1)
  f.home.time += 300                       // the call's wall deadline passes on the home's clock
  assert.ok((await call) instanceof Error)
  const [grant] = grants(f.sent)
  assert.equal(f.home.runs.get(grant!.offer.runId).state, 'canceled'); assert.equal((await f.completions()).length, 1)
  assert.deepEqual(f.sent.filter(s => s.path === '/attempts/dispatch-cancel').map(s => (s.body as { id: string }).id).filter((id, i, all) => all.indexOf(id) === i), [grant!.id])
})

test('the home accepts only an owner-device executor with the attempts scope, and a failed admission closes its session', async t => {
  const f = await remoteFixture(t), { identity: makeIdentity } = await import('../federation/harness.ts')
  assert.throws(() => f.home.federation.relayChannel('nobody'), /unauthenticated/)
  for (const [name, overrides] of [['shared device', { trust: 'shared_device', admin: false, scopes: ['attempts'] }], ['no attempts scope', { scopes: ['config'] }]] as Array<[string, Parameters<typeof makeIdentity>[1]]>) {
    const peer = makeIdentity('exec-' + name.replace(/ /g, '-'), overrides)
    f.home.federation.trust(peer.identity)
    assert.throws(() => f.home.federation.relayChannel(peer.identity.id), /owner_mismatch/, name)
  }
  const sessions: Array<{ observe(reference: string, signal: AbortSignal): Promise<unknown> }> = []
  const open = f.remote.open.bind(f.remote)
  f.remote.open = () => { const session = open(); sessions.push(session); return session }
  f.rules.push(path => { if (path.startsWith('/attempts/runtime')) throw new Error('fixture partition') })
  assert.equal(await code(f.relay()), 'runtime_meter_unavailable')
  assert.equal(sessions.length, 1)
  assert.equal(await code(sessions[0]!.observe(f.remote.model, new AbortController().signal)), 'relay_stopped', 'the failed preparation released its session')
})
