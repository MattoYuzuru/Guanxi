import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CodexClient } from '../../src/external-agents/codex.ts'
import type { AgentProcess } from '../../src/external-agents/process.ts'
import { fixture, owner } from './helpers.ts'

test('Codex browser login wait rejects when transport closes after URL, without a completion notification', async () => {
  let controller!: ReadableStreamDefaultController<unknown>
  let close!: () => void
  const closed = new Promise<void>(resolve => { close = resolve })
  const client = new CodexClient({ closed,
    stream: { readable: new ReadableStream({ start(value) { controller = value } }) },
    async write(frame: { id: number; method: string }) {
      controller.enqueue({ id: frame.id, result: { type: 'chatgpt', loginId: 'fixture-login', authUrl: 'https://auth.openai.com/authorize?fixture=true' } })
    },
  } as unknown as AgentProcess)
  let urlShown!: () => void
  const shown = new Promise<void>(resolve => { urlShown = resolve })
  const login = client.login(() => urlShown(), new AbortController().signal).then(() => 'succeeded', () => 'rejected')
  await shown
  controller.close(); close()
  const result = await Promise.race([login, new Promise<string>(resolve => setTimeout(() => resolve('stalled'), 500))])
  assert.equal(result, 'rejected')
})

test('Codex login timeout and unload settle real fixture processes after auth URL without touching credentials', async t => {
  const f = await fixture(t)
  const binding = f.bindings[0]!
  for (const action of ['abort', 'unload', 'timeout'] as const) {
    await f.scenario('codex', { scenario: 'login-hang' })
    await f.reload({ installations: [{ ...f.installations[0]!, concurrency: 2 }], requestTimeoutMs: action === 'timeout' ? 1000 : 5000 })
    f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
    let show!: () => void
    const shown = new Promise<void>(resolve => { show = resolve })
    const abort = new AbortController()
    const login = f.service().signInWithChatGPT(owner, owner, binding.connectionId, () => show(), abort.signal).then(() => 'succeeded', error => error.code)
    await shown
    await assert.rejects(f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello' }), /account_busy/)
    if (action === 'abort') abort.abort()
    if (action === 'unload') await f.reload()
    const result = await Promise.race([login, new Promise<string>(resolve => setTimeout(() => resolve('stalled'), 10000))])
    assert.equal(result, 'cancelled')
    assert.equal(f.service().limits(owner, binding.connectionId).activeOnThisNode, 0)
  }
})
