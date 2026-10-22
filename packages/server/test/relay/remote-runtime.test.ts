import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { RELAY_RUNTIME_PROBE, type SignedDispatchGrant, type SignedDispatchEvent } from '@guanxi/contract/federation'
import { canonical, hash, signValue } from '../../src/federation/crypto.ts'
import { ConnectionJudgeModel } from '../../src/relay/judge-model.ts'
import { fakeRender, fakeTokens } from '../fixtures/fake-llama-server.ts'
import { remoteFixture, until, type Sent } from './remote-fixture.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const rendered = (prompt: string) => fakeRender(prompt, { template: 'chat' }, false)
const exact = (prompt: string) => fakeTokens(rendered(prompt), true)
const grants = (sent: Sent[]) => sent.filter(s => s.path === '/attempts/dispatch').map(s => (s.body as SignedDispatchGrant).grant)
const events = (f: Awaited<ReturnType<typeof remoteFixture>>) => f.target.db.prepare('SELECT payload FROM remote_dispatch_events ORDER BY id,seq').all()
  .map(row => (JSON.parse(String(row.payload)) as SignedDispatchEvent).entry.event)
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
      deadline: f.home.time + 30_000, messages: [{ role: 'user', content }], counted }, 4000, 'relay')
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
  const f = await remoteFixture(t, { fake: { completionDelayMs: 600 }, cancelWaitMs: 150 }), r = await f.relay()
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

test('cancel without an ACK is retried until the holder window ends, and only then does the call settle', async t => {
  const f = await remoteFixture(t, { fake: { completionDelayMs: 3000 }, cancelWaitMs: 300 }), r = await f.relay()
  f.rules.push(path => { if (path === '/attempts/dispatch-cancel') throw new Error('fixture partition') })
  const abort = new AbortController(), call = r.call('Cancel into a partition.', { signal: abort.signal }).catch((error: unknown) => error)
  await until(async () => (await f.fake.count('/completion')) === 1)
  const started = Date.now()
  abort.abort()
  assert.ok((await call) instanceof Error)
  assert.ok(Date.now() - started >= 280, `settled after ${Date.now() - started} ms, before the cancel window`)
  assert.ok(f.seen.filter(p => p === '/attempts/dispatch-cancel').length >= 2, 'the cancel was retried')
  const [grant] = grants(f.sent)
  assert.equal(f.home.runs.get(grant!.offer.runId).state, 'canceled')
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
