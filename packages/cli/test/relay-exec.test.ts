import assert from 'node:assert/strict'
import { test } from 'node:test'
import { relayExec, relayExecExitCode } from '../src/relay-exec.ts'
import type { RelayStartStatus } from '@guanxi/contract'
const input = { projectId: 'project', connectionId: 'local', model: 'fixture', consent: 'full-access', domains: [],
  plan: { revision: 'r1', base: 'a'.repeat(40), goal: 'fixture', items: [{ id: 'one', title: 'fixture', dependsOn: [], acceptance: ['true'], protectedPaths: [] }], protectedPaths: [] },
  caps: { cycles: 1, tokens: 100000, moneyMicros: null, wallMs: 10000 } }
const args = ['--request', 'synthetic-plan.json', '--key', 'cli-key', '--json']
const read = async () => JSON.stringify(input)
const state = (status: RelayStartStatus['status']): RelayStartStatus => ({ key: 'cli-key', runId: 'run', sessionId: 'session',
  status, error: null, source: 'run-home', observedAt: new Date(0).toISOString(), confidence: 'observed', runtime: null, meter: null, runtimeAgeMs: null, reserves: null })
test('relay CLI submits explicit owner choices, polls durable metadata and returns a stable completed result', async () => {
  const requests: Array<{ method: string; path: string; body: any }> = []
  const transport: typeof fetch = async (url, init) => {
    requests.push({ method: init?.method ?? 'GET', path: new URL(String(url)).pathname, body: init?.body ? JSON.parse(String(init.body)) : null })
    return Response.json(state(requests.length === 1 ? 'running' : 'completed'))
  }
  const result = await relayExec(args, transport, undefined, read)
  assert.equal(result.status, 'completed'); assert.equal(relayExecExitCode(result), 0)
  assert.deepEqual(requests.map(r => [r.method,r.path]), [['POST','/api/relay'],['GET','/api/relay/starts/cli-key']])
  assert.deepEqual(requests[0]!.body, { ...input, key: 'cli-key' })
  assert.equal(Object.hasOwn(result, 'plan'), false)
})
test('relay CLI preserves explicit unsupported-meter/workspace refusals without echoing plan or provider details', async () => {
  for (const code of ['runtime_meter_unavailable', 'relay_workspace_unavailable']) {
    const result = await relayExec(args, async () => Response.json({ code, details: 'private fixture data' }, { status: 503 }), undefined, read)
    assert.equal(result.error, code); assert.equal(relayExecExitCode(result), 1)
    assert.equal(JSON.stringify(result).includes('private fixture data'), false)
  }
  assert.equal((await relayExec(args, async () => { throw new Error('private transport value') }, undefined, read)).error, 'relay_exec_failed')
})
test('relay CLI can cancel by known start key while creation is awaiting observation before a run ID exists', async () => {
  const abort = new AbortController(), paths: string[] = []
  const transport: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname; paths.push(path)
    if (path === '/api/relay') { abort.abort(); throw new Error('aborted') }
    return Response.json({ ...state('canceled'), runId: null, sessionId: null, source: 'start-owner' })
  }
  const result = await relayExec(args, transport, abort.signal, read)
  assert.equal(result.status, 'canceled'); assert.equal(relayExecExitCode(result), 130)
  assert.deepEqual(paths, ['/api/relay','/api/relay/starts/cli-key/stop'])
})
test('relay CLI reports unconfirmed cancellation and refuses remote endpoints or runtime-fact JSON without dispatch', async () => {
  const abort = new AbortController(); let requests = 0
  const result = await relayExec(args, async () => { requests++; abort.abort(); throw new Error('private') }, abort.signal, read)
  assert.equal(result.status, 'interrupted'); assert.equal(result.error, 'cancellation_unconfirmed'); assert.equal(requests, 2)
  for (const invalid of [['--url','https://foreign.invalid/',...args], [...args,'--unexpected','value']]) {
    await relayExec(invalid, async () => { assert.fail('no transport'); }, undefined, read)
  }
  assert.equal((await relayExec(args, async () => { assert.fail('no transport') }, undefined,
    async () => JSON.stringify({ ...input, W: 16000 }))).error, 'relay_exec_failed')
  assert.equal(relayExecExitCode(state('wrapping_up')), 1)
})
