import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { countedRequestSchema, localInferenceJobSchema, RELAY_RESPONSE_SCHEMA_BYTES, type SignedDispatchEvent, type SignedDispatchGrant } from '@guanxi/contract/federation'
import { FEDERATION_BODY_BYTES, hash, signValue } from '../../src/federation/crypto.ts'
import { schemaDigest, type JsonSchema } from '../../src/relay/json-schema.ts'
import { fakeRender, fakeTokens } from '../fixtures/fake-llama-server.ts'
import { remoteFixture, until, type Sent } from './remote-fixture.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const rendered = (prompt: string) => fakeRender(prompt, { template: 'chat' }, false)
const exact = (prompt: string) => fakeTokens(rendered(prompt), true)
const grants = (sent: Sent[]) => sent.filter(s => s.path === '/attempts/dispatch').map(s => (s.body as SignedDispatchGrant).grant)
const SCHEMA: JsonSchema = { type: 'object', properties: { action: { const: 'tool' }, name: { enum: ['file_read', 'shell'] }, args: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  required: ['action', 'name', 'args'], additionalProperties: false }
const REPLY = '{"action": "tool", "name": "file_read", "args": {"path": "SPEC.md"}}'
const terminals = (f: Awaited<ReturnType<typeof remoteFixture>>) => f.target.db.prepare('SELECT payload FROM remote_dispatch_events ORDER BY id,seq').all()
  .map(row => (JSON.parse(String(row.payload)) as SignedDispatchEvent).entry.event).flatMap(e => e.kind === 'terminal' ? [e] : [])
/** The terminal event of one dispatch (event rows are not ordered across dispatches). */
const terminalOf = (f: Awaited<ReturnType<typeof remoteFixture>>, id: string) => f.target.db.prepare('SELECT payload FROM remote_dispatch_events WHERE id=? ORDER BY seq').all(id)
  .map(row => (JSON.parse(String(row.payload)) as SignedDispatchEvent).entry.event).flatMap(e => e.kind === 'terminal' ? [e] : [])[0]!
async function code(promise: Promise<unknown>): Promise<string> {
  try { await promise } catch (error) { return String((error as { code?: unknown }).code ?? (error as Error).message) }
  return 'resolved'
}

test('a response schema is part of the signed job, the counted chain, the executor\'s request and its signed terminal; a call without one is unchanged', async t => {
  const f = await remoteFixture(t, { fake: { replies: [REPLY] } }), r = await f.relay()
  const prompt = 'Choose a tool for the fixture.'
  const constrained = await r.call(prompt, { responseSchema: SCHEMA })
  assert.equal(constrained.text, REPLY)
  assert.equal(constrained.inputTokens, exact(prompt), 'the schema did not change what the executor evaluated')
  const [grant] = grants(f.sent)
  assert.deepEqual(grant!.job.responseSchema, SCHEMA)
  assert.equal(grant!.job.counted!.responseSchemaSha256, schemaDigest(SCHEMA)); assert.equal(grant!.job.counted!.responseSchemaSha256, hash(SCHEMA), 'the federation canonical hash is the same digest')
  assert.equal(grant!.jobHash, hash(grant!.job), 'the schema is covered by the signed job hash')
  const [post] = await f.completions()
  assert.deepEqual(post!.body, { prompt: rendered(prompt), n_predict: 1000, stream: false, cache_prompt: true, json_schema: SCHEMA })
  assert.deepEqual(Object.keys(post!.body), ['prompt', 'n_predict', 'stream', 'cache_prompt', 'json_schema'])
  // A grammar writes a reply's keys in the schema's own order, so the order must survive the signed job and the executor (`args` after `name`).
  const sent = (post!.body as unknown as { json_schema: { properties: object; required: string[] } }).json_schema
  assert.deepEqual(Object.keys(sent.properties), ['action', 'name', 'args'], 'property order is the sender\'s, not alphabetical')
  assert.deepEqual(sent.required, ['action', 'name', 'args']); assert.deepEqual(Object.keys(sent), Object.keys(SCHEMA))
  const terminal = terminalOf(f, grant!.id)
  assert.equal(terminal.outcome, 'completed'); assert.equal(terminal.responseSchemaSha256, schemaDigest(SCHEMA)); assert.equal(terminal.renderedSha256, sha(rendered(prompt)))
  // Without a schema nothing of this appears anywhere.
  const plain = await r.call('Choose without a grammar.')
  assert.equal(plain.text, REPLY)
  const second = grants(f.sent)[1]!, [, plainPost] = await f.completions(), plainTerminal = terminalOf(f, second.id)
  assert.equal('responseSchema' in second.job, false); assert.equal('responseSchemaSha256' in second.job.counted!, false)
  assert.equal('json_schema' in plainPost!.body, false); assert.equal('responseSchemaSha256' in plainTerminal, false)
})

test('the wire accepts a schema only together with its hash and only within the bound, and the digest of a schema is computed the same way on both nodes', () => {
  const counted = { contentSha256: sha('c'), renderedSha256: sha('r'), tokens: 3, digest: 'sha256:x', contextTokens: 100 }
  const job = { kind: 'local_inference' as const, model: 'm', context: 100, outputTokens: 10, deadline: 1, messages: [{ role: 'user' as const, content: 'c' }] }
  assert.equal(localInferenceJobSchema.safeParse({ ...job, counted, responseSchema: SCHEMA }).success, false, 'a schema without its hash in the counted chain')
  assert.ok(localInferenceJobSchema.safeParse({ ...job, counted: { ...counted, responseSchemaSha256: schemaDigest(SCHEMA) }, responseSchema: SCHEMA }).success)
  assert.equal(localInferenceJobSchema.safeParse({ ...job, counted: { ...counted, responseSchemaSha256: schemaDigest(SCHEMA) } }).success, false, 'a hash with no schema')
  assert.equal(localInferenceJobSchema.safeParse({ ...job, responseSchema: SCHEMA }).success, false, 'a schema on a job that is not a counted relay call')
  assert.equal(localInferenceJobSchema.safeParse({ ...job, counted: { ...counted, responseSchemaSha256: 'nope' }, responseSchema: SCHEMA }).success, false)
  const huge = { enum: ['x'.repeat(RELAY_RESPONSE_SCHEMA_BYTES)] }
  assert.equal(localInferenceJobSchema.safeParse({ ...job, counted: { ...counted, responseSchemaSha256: schemaDigest(huge) }, responseSchema: huge }).success, false, 'over the bound')
  assert.equal(localInferenceJobSchema.safeParse({ ...job, responseSchema: 'json' }).success, false); assert.equal(localInferenceJobSchema.safeParse({ ...job, counted, extra: 1 }).success, false)
  assert.equal(countedRequestSchema.safeParse({ ...counted, responseSchemaSha256: sha('s') }).success, true)
})

test('the executor refuses a job whose schema is not the one its counted chain names, and a changed schema is a different request', async t => {
  const f = await remoteFixture(t, { fake: { replies: [REPLY] } }), r = await f.relay(), content = 'Pinned schema fixture.'
  await r.model.countAsync!(content)
  const digest = (await f.llama.observe(f.llama.model, new AbortController().signal)).digest
  const real = { contentSha256: sha(content), renderedSha256: sha(rendered(content)), tokens: exact(content), digest, contextTokens: 16000 }
  const other: JsonSchema = { ...SCHEMA, required: ['action'] }
  const dispatch = async (name: string, job: Record<string, unknown>) => {
    const childId = `pin-${sha(name).slice(0, 8)}`
    f.home.runs.create({ id: childId, sessionId: 'relay-session' })
    const offer = f.home.federation.prepareDispatch(childId, 'target', { kind: 'local_inference', model: 'fixture', context: 16000, outputTokens: 1000,
      deadline: f.home.time + 30_000, messages: [{ role: 'user', content }], ...job } as never, 4000, { runId: 'relay', epoch: 1 })
    const channel = f.channel('home'), receipt = await channel.offer(offer)
    return { channel, offer, grant: f.home.federation.grantDispatch(offer.id, receipt),
      // A grant the executor refuses leaves its reservation held, and the next offer would queue behind it.
      release: () => channel.cancelOffer({ offerId: offer.id, homeNodeId: offer.homeNodeId, executorNodeId: offer.executorNodeId }) }
  }
  // The home's own schema check: a schema that its chain does not carry cannot even be prepared.
  for (const [name, job] of [
    ['schema, no hash', { counted: real, responseSchema: SCHEMA }],
    ['hash, no schema', { counted: { ...real, responseSchemaSha256: schemaDigest(SCHEMA) } }],
  ] as const) assert.throws(() => f.home.federation.prepareDispatch(`x-${name.length}`, 'target', { kind: 'local_inference', model: 'fixture', context: 16000, outputTokens: 1000, deadline: f.home.time + 30_000, messages: [{ role: 'user', content }], ...job } as never, 4000, { runId: 'relay', epoch: 1 }), name)
  // A schema signed with the job but not the one the chain names: the executor refuses the grant before anything runs.
  const mismatched = await dispatch('mismatch', { counted: { ...real, responseSchemaSha256: schemaDigest(other) }, responseSchema: SCHEMA })
  assert.equal(await code(mismatched.channel.dispatch(mismatched.grant)), 'peer_refused')
  await mismatched.release()
  assert.equal((await f.completions()).length, 0, 'nothing reached the model')
  // The same schema in a request that evaluates another one is refused by the runtime itself (see expected-transport.test.ts); here the matching job runs.
  const ok = await dispatch('match', { counted: { ...real, responseSchemaSha256: schemaDigest(SCHEMA) }, responseSchema: SCHEMA })
  await ok.channel.dispatch(ok.grant)
  const terminal = await f.home.federation.attemptDispatch!.awaitTerminal(ok.offer.id, AbortSignal.timeout(5000), () => undefined, 5)
  assert.equal(terminal.outcome, 'completed'); assert.equal(terminal.kind === 'terminal' && terminal.responseSchemaSha256, schemaDigest(SCHEMA))
  assert.deepEqual((await f.completions())[0]!.body.json_schema, SCHEMA)
})

test('the home refuses a terminal result that does not echo the schema it sent, even from a signed executor', async t => {
  const f = await remoteFixture(t, { fake: { replies: [REPLY] } }), r = await f.relay()
  for (const [name, patch] of [['no echo', undefined], ['another schema', sha('another schema')]] as const) {
    const prompt = `Echo check ${name}.`
    let hold = true
    f.rules.length = 0
    f.rules.push(path => { if (hold && path === '/attempts/events') throw new Error('fixture partition') })   // only the forged events arrive
    await r.model.countAsync!(prompt)
    const dispatched = grants(f.sent).length
    const call = r.call(prompt, { prime: false, responseSchema: SCHEMA }).catch((error: unknown) => error)
    await until(() => grants(f.sent).length === dispatched + 1 && terminals(f).length === dispatched + 1)
    const rows = f.target.db.prepare('SELECT payload FROM remote_dispatch_events WHERE id=? ORDER BY seq').all(grants(f.sent).at(-1)!.id).map(row => JSON.parse(String(row.payload)) as SignedDispatchEvent)
    const [started, final] = rows, { responseSchemaSha256: _echo, ...event } = final!.entry.event as Record<string, unknown>
    const entry = { ...final!.entry, event: { ...event, ...(patch ? { responseSchemaSha256: patch } : {}) } } as SignedDispatchEvent['entry']
    const forged = { entry, hash: hash(entry), signature: signValue(f.target.keys.privateKey, entry) }
    const targetCtx = { ...f.homeCtx, identity: f.target.keys.identity }
    hold = false
    f.home.federation.receiveDispatchEvent(targetCtx, started!); f.home.federation.receiveDispatchEvent(targetCtx, forged)
    const outcome = await call
    assert.ok(outcome instanceof Error, `${name}: the terminal must not produce a reply`); assert.equal((outcome as { code?: string }).code, 'provider_failed', name)
  }
  // Control: the same flow with the executor's own, untouched event is accepted.
  f.rules.length = 0
  const ok = await r.call('Echo check intact.', { responseSchema: SCHEMA })
  assert.equal(ok.text, REPLY)
})

test('a peer older than federation 1.6 cannot carry a schema in either direction, and still works without one', async t => {
  const f = await remoteFixture(t, { fake: { replies: [REPLY] } }), r = await f.relay()
  // An executor that declares 1.5: the home refuses to send a schema rather than let it be dropped or rejected.
  f.overrides.push(async (path, request) => {
    // Only what the home asks of the executor; the executor's own questions to the home are not altered.
    if (path !== '/handshake' || (JSON.parse(request.headers.get('X-Guanxi-Node') ?? '{}') as { nodeId?: string }).nodeId !== 'home') return undefined
    const real = await (await f.target.app.request(request)).json() as { version: { major: number; minor: number } }
    return Response.json({ ...real, version: { ...real.version, minor: 5 } })
  })
  const refused = r.call('Old executor, schema.', { responseSchema: SCHEMA })
  assert.equal(await code(refused), 'provider_failed')
  assert.equal(grants(f.sent).length, 0, 'no dispatch was sent'); assert.equal((await f.completions()).length, 0)
  assert.equal((await r.call('Old executor, no schema.')).text, REPLY)
  assert.equal(grants(f.sent).length, 1); assert.equal('responseSchema' in grants(f.sent)[0]!.job, false)
  // A home that declares 1.5 (or the fixture's own 1.4): the executor refuses its schema grant before the reservation is consumed.
  f.overrides.length = 0
  const g = await r.call('New home, schema.', { responseSchema: SCHEMA }), schemaGrant = f.sent.filter(s => s.path === '/attempts/dispatch').map(s => s.body as SignedDispatchGrant).at(-1)!
  assert.equal(g.text, REPLY); assert.ok(schemaGrant.grant.job.responseSchema)
  await assert.rejects(f.target.federation.receiveDispatch({ ...f.homeCtx, version: { major: 1, minor: 5 } }, schemaGrant), /contract_feature_unavailable/)
  await assert.rejects(f.target.federation.receiveDispatch(f.homeCtx, schemaGrant), /contract_feature_unavailable/)
  assert.equal((await f.target.federation.receiveDispatch({ ...f.homeCtx, version: { major: 1, minor: 6 } }, schemaGrant)).id, schemaGrant.grant.id, 'at 1.6 the same grant is not refused for its version (an idempotent replay)')
})

test('the largest string the home will count leaves room for the largest schema a job may carry', async t => {
  const f = await remoteFixture(t), r = await f.relay()
  // Within a message of the signed-body limit once the schema is added: reported above every ceiling, never sent.
  const over = 'x'.repeat(FEDERATION_BODY_BYTES - 32 * 1024 - 1000), before = f.sent.filter(s => s.path === '/attempts/runtime/count').length
  assert.equal(await r.model.countAsync!(over), Number.MAX_SAFE_INTEGER)
  assert.equal(f.sent.filter(s => s.path === '/attempts/runtime/count').length, before)
  assert.equal(RELAY_RESPONSE_SCHEMA_BYTES, 64 * 1024)
})
