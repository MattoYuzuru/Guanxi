import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { agentExec, agentExecExitCode } from '../src/agent-exec.ts'
const sessionId = '11111111-1111-4111-8111-111111111111'
const progress = { version: 2, sessionId, projectId: 'p', connectionId: 'c', model: 'fixture', mode: 'read-only', status: 'completed',
  plan: [], queue: [], summary: 'fixture answer', error: null, observedAt: '2026-10-21T00:00:00.000Z', source: 'session.log', confidence: 'high' }

test('exec --json emits the versioned stable success/failure schema snapshot', async () => {
  const seen: string[] = []
  const result = await agentExec(['--json', '--project', 'p', '--connection', 'c', '--model', 'fixture', '--prompt', 'fixture'], async (url, init) => {
    const path = new URL(String(url)).pathname
    seen.push(path)
    if (init?.method === 'POST') {
      assert.equal(JSON.parse(String(init.body)).mode, 'read-only')
      return Response.json({ sessionId })
    }
    return Response.json(path.endsWith('/result') ? { version: 1, sessionId, status: 'completed', text: 'fixture answer', error: null } : progress)
  })
  const failed = await agentExec(['--json', '--invalid'], async () => { throw new Error('must not dispatch') })
  assert.equal(JSON.stringify({ completed: result, failed }, null, 2) + '\n', readFileSync(new URL('./snapshots/agent-exec.json', import.meta.url), 'utf8'))
  assert.equal(agentExecExitCode(result), 0); assert.equal(agentExecExitCode(failed), 1)
  assert.equal(agentExecExitCode({ ...result, status: 'cancelled' }), 130)
  assert.equal(seen.length, 3)
})
test('exec refuses redirects/remote endpoints, excludes provider exception contents and handles cancellation', async () => {
  let calls = 0
  const remote = await agentExec(['--json', '--url', 'http://example.invalid'], async () => { calls++; throw new Error('sensitive_exception') })
  assert.equal(calls, 0); assert.equal(remote.status, 'failed')
  const failed = await agentExec(['--json'], async () => { throw new Error('sensitive_exception') })
  assert.equal(JSON.stringify(failed).includes('sensitive_exception'), false)
  const abort = new AbortController(); abort.abort()
  const cancelled = await agentExec(['--json'], async () => { throw new Error('abort') }, abort.signal)
  assert.equal(cancelled.status, 'cancelled')
})
test('actual CLI --json stdout contains exactly the snapshot protocol record', { timeout: 15000 }, async () => {
  const { spawn } = await import('node:child_process')
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['packages/cli/src/bin.ts', 'agent', 'exec', '--json', '--invalid'], { cwd: new URL('../../..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; child.stdout.on('data', data => { stdout += data }); child.stderr.resume()
    child.once('error', reject); child.once('close', code => resolve({ code, stdout }))
  })
  const snapshot = JSON.parse(readFileSync(new URL('./snapshots/agent-exec.json', import.meta.url), 'utf8'))
  assert.equal(result.stdout, JSON.stringify(snapshot.failed) + '\n')
  assert.equal(result.code, 1)
})
test('abort after an uncertain creation response never claims confirmed cancellation', async () => {
  const abort = new AbortController()
  let calls = 0
  const result = await agentExec(['--json'], async () => {
    calls++; abort.abort(); throw new Error('response lost after node created work')
  }, abort.signal)
  assert.equal(calls, 1)
  assert.deepEqual(result, { version: 1, sessionId: null, status: 'interrupted', text: '', error: 'cancellation_unconfirmed' })
})

const queued = [
  { id: 'q1', kind: 'artifact', artifact: { artifactId: '22222222-2222-4222-8222-222222222222', checksum: `sha256:${'a'.repeat(64)}`, byteSize: 20000, mediaType: 'text/plain; charset=utf-8', excerpt: 'bounded excerpt', excerptBytes: 15 } },
  { id: 'q2', kind: 'legacy-preview', excerpt: 'legacy excerpt', excerptBytes: 14, byteSize: 20000 },
  { id: 'q3', kind: 'inline', text: 'small' },
]
const args = ['--json', '--project', 'p', '--connection', 'c', '--model', 'fixture', '--prompt', 'fixture prompt text']

test('Q17: the normal poll requests progress2, parses every queue branch and echoes no input', async () => {
  const polls: string[] = []
  let running = 1
  const result = await agentExec(args, async (url, init) => {
    const target = new URL(String(url))
    if (init?.method === 'POST') return Response.json({ sessionId })
    if (target.pathname.endsWith('/result')) return Response.json({ version: 1, sessionId, status: 'completed', text: 'fixture answer', error: null })
    polls.push(target.pathname + target.search)
    return Response.json({ ...progress, status: running-- > 0 ? 'running' : 'completed', queue: queued })
  })
  assert.deepEqual(polls, [`/api/agent/${sessionId}?progressVersion=2`, `/api/agent/${sessionId}?progressVersion=2`])
  assert.deepEqual(result, { version: 1, sessionId, status: 'completed', text: 'fixture answer', error: null })
  assert.equal(JSON.stringify(result).includes('bounded excerpt'), false)
  assert.equal(agentExecExitCode(result), 0)
})

test('Q17: the cancellation confirmation poll also requests progress2 and stays confirmed or explicitly unconfirmed', async () => {
  const run = async (confirm: boolean) => {
    const abort = new AbortController()
    const polls: string[] = []
    let stopped = false
    const result = await agentExec(args, async (url, init) => {
      const target = new URL(String(url))
      if (init?.method === 'POST' && target.pathname.endsWith('/stop')) { stopped = true; return Response.json({ ok: true }) }
      if (init?.method === 'POST') return Response.json({ sessionId })
      if (target.pathname.endsWith('/result')) return Response.json({ version: 1, sessionId, status: 'cancelled', text: '', error: null })
      polls.push(target.pathname + target.search)
      if (!stopped) { queueMicrotask(() => abort.abort()); return Response.json({ ...progress, status: 'running', queue: queued }) }
      return confirm ? Response.json({ ...progress, status: 'cancelled', queue: queued }) : Response.json({ ...progress, version: 1, status: 'cancelled', queue: [] })
    }, abort.signal)
    return { result, polls }
  }
  const confirmed = await run(true)
  assert.equal(confirmed.polls.length >= 2, true)
  assert.equal(confirmed.polls.every(path => path.endsWith('?progressVersion=2')), true)
  assert.deepEqual(confirmed.result, { version: 1, sessionId, status: 'cancelled', text: '', error: null })
  assert.equal(agentExecExitCode(confirmed.result), 130)
  // A body that is not progress2 can never confirm a cancellation.
  const unconfirmed = await run(false)
  assert.deepEqual(unconfirmed.result, { version: 1, sessionId, status: 'interrupted', text: '', error: 'cancellation_unconfirmed' })
})

test('a pre-progress2 node answers the legacy body and the client fails closed', async () => {
  const legacy = { ...progress, version: undefined, queue: [{ id: 'q', text: 'legacy text' }] }
  const result = await agentExec(args, async (_url, init) => init?.method === 'POST' ? Response.json({ sessionId }) : Response.json(legacy))
  assert.deepEqual(result, { version: 1, sessionId, status: 'failed', text: '', error: 'agent_exec_failed' })
})
