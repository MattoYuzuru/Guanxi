import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { start } from '../../src/index.ts'
import type { AccountsAdapter } from '../../src/auth/route-authz.ts'
import { canSeeReasoning, redactChatEvent, redactJobEvent, withoutReasoning } from '../../src/auth/reasoning.ts'
import { chatIdempotencyScope, chatRequestFingerprint } from '../../src/jobs/chat-execution.ts'
import { ProjectStore } from '../../src/store/projects.ts'
import type { Grant, Principal } from '../../src/auth/types.ts'
import { identity } from '../federation/harness.ts'
import { TLS_TEST_HOSTNAME, makeTlsFixture, type TlsFixture } from './tls-fixture.ts'

const OWNER = 'owner-1'
const THREAD_SECRET = 'SECRET-THREAD-CHAIN-OF-THOUGHT'
const PROJECT_SECRET = 'SECRET-PROJECT-CHAIN-OF-THOUGHT'
const JOB_SECRET = 'SECRET-JOB-STREAM-REASONING'
const VISIBLE = 'visible-answer-text'
const KEY = '5d3a1c6e-2f0b-4a7e-9b1d-0c8e4f6a7b21'
const ALL_SECRETS = [THREAD_SECRET, PROJECT_SECRET, JOB_SECRET]

const user = (userId: string): Principal => ({ kind: 'user', userId, role: 'member', groups: [] })

function grants(type: 'session' | 'run', id: string): Grant[] {
  const base = { resourceType: type, resourceId: id, subjectType: 'user' as const, createdBy: OWNER, createdAt: 0, expiresAt: null }
  return [
    { ...base, relation: 'viewer', subjectId: 'viewer-1' },
    { ...base, relation: 'editor', subjectId: 'editor-1' },
  ]
}

const accounts: AccountsAdapter = {
  nodeOwnerId: OWNER,
  principal: (context) => {
    const header = context.req.header('x-user')
    return header === undefined ? { kind: 'anonymous' } : user(header === 'owner' ? OWNER : header)
  },
  grants: (resource) => (resource.type === 'session' || resource.type === 'run' ? grants(resource.type, resource.id) : []),
}

/** Read SSE frames until `needle` appears (or the stream ends), then cancel; returns everything read. */
async function readUntil(response: Response, needle: string): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline && !text.includes(needle)) {
    const next = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
    ])
    if (next === null || next.done) break
    text += decoder.decode(next.value, { stream: true })
  }
  await reader.cancel().catch(() => undefined)
  return text
}

describe('H-A: reasoning never reaches a grantee', () => {
  let root: string
  let tls: TlsFixture
  let server: Awaited<ReturnType<typeof start>>
  let origin: string
  let threadId: string
  let projectId: string
  let projectThreadId: string
  let jobId: string
  let assistantMessageId: string
  const call = (path: string, user: string, init: RequestInit = {}) =>
    server.app.request(`${origin}${path}`, { ...init, headers: { 'x-user': user, ...(init.headers as Record<string, string> | undefined) } })

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'guanxi-reasoning-'))
    tls = makeTlsFixture()
    const node = identity('reasoning-node')
    server = await start({
      port: 0, host: '127.0.0.1', dataDir: join(root, 'data'), webDir: root, devOrigins: [],
      federation: { identity: node.identity, privateKey: node.privateKey },
      remote: { tls: { certPath: tls.certPath, keyPath: tls.keyPath, hostname: TLS_TEST_HOSTNAME }, allowedRoots: [join(root, 'srv')], accounts },
    })
    origin = `https://${TLS_TEST_HOSTNAME}:${server.port}`
    const ctx = server.context
    const options = { numCtx: 8192, temperature: 0.7, think: 'high' } as never
    const thread = ctx.threads.create({ title: 'viewer thread', mode: 'chat', model: 'm', workspaceId: null, options })
    threadId = thread.id
    ctx.threads.addMessage({ threadId, role: 'assistant', content: VISIBLE, thinking: THREAD_SECRET })

    projectId = new ProjectStore(ctx.db).create('P', new Date().toISOString()).id
    const inProject = ctx.threads.createWithOwnership({ title: 'project chat', model: 'm', projectId, options })
    projectThreadId = inProject.id
    ctx.threads.addMessage({ threadId: projectThreadId, role: 'assistant', content: VISIBLE, thinking: PROJECT_SECRET })

    // A chat job whose persisted stream carries reasoning. It is moved out of `queued` so replaying the
    // same idempotency key through POST /messages streams it without starting a model call.
    const snapshot = { content: 'question', attachments: [], autoApprove: null }
    const created = ctx.jobService.createChat({
      threadId, idempotencyScope: chatIdempotencyScope(threadId), idempotencyKey: KEY,
      requestFingerprint: chatRequestFingerprint(snapshot), input: snapshot, derivedTitle: 'question',
    })
    jobId = created.job.id
    assistantMessageId = created.assistantMessageId
    const append = (event: unknown, channel: string) => {
      const job = ctx.jobService.get(jobId)!
      ctx.jobService.appendSafeEvent({
        jobId, expectedNextSequence: job.lastEventSequence + 1, type: 'output',
        metadata: { channel, bytes: 16 }, output: { privacyClassification: 'private_chat', event },
      } as never)
    }
    append({ type: 'thinking', data: { delta: JOB_SECRET } }, 'thinking')
    append({ type: 'token', data: { delta: VISIBLE } }, 'token')
    ctx.jobService.transition({ jobId, expectedStatus: 'queued', status: 'reserving' })
  })

  after(async () => {
    try {
      // The seeded job has no executor: end it the canonical way (cancelling, then cancelled) so shutdown has nothing to reconcile.
      const jobs = server.context.jobService
      jobs.transition({ jobId, expectedStatus: 'reserving', status: 'cancelling' })
      jobs.terminalizeChat({
        jobId, expectedStatus: 'cancelling', status: 'cancelled', stopReason: 'stopped_by_user', messageId: assistantMessageId,
        message: { outcome: 'cancelled', error: null, stopReason: 'stopped_by_user', content: '', thinking: null, toolCalls: [], usage: null },
      })
    } finally {
      await server.close()
      tls.cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('GET /api/threads/:id: the owner reads the chain of thought, a viewer and an editor read the answer only', async () => {
    const owner = await (await call(`/api/threads/${threadId}`, 'owner')).text()
    assert.ok(owner.includes(THREAD_SECRET), 'the owner keeps the reasoning')
    for (const who of ['viewer-1', 'editor-1']) {
      const response = await call(`/api/threads/${threadId}`, who)
      assert.equal(response.status, 200, who)
      const body = await response.text()
      assert.ok(body.includes(VISIBLE), `${who} reads the answer`)
      for (const secret of ALL_SECRETS) assert.equal(body.includes(secret), false, `${who} must not read ${secret}`)
      const parsed = JSON.parse(body) as { messages: Array<{ thinking: string | null }> }
      assert.ok(parsed.messages.every((message) => message.thinking === null))
    }
  })

  it('GET /api/projects/:id/chats/:threadId: the same redaction', async () => {
    const path = `/api/projects/${projectId}/chats/${projectThreadId}`
    const owner = await call(path, 'owner')
    assert.equal(owner.status, 200)
    assert.ok((await owner.text()).includes(PROJECT_SECRET))
    const viewer = await call(path, 'viewer-1')
    assert.equal(viewer.status, 200)
    const body = await viewer.text()
    assert.ok(body.includes(VISIBLE))
    for (const secret of ALL_SECRETS) assert.equal(body.includes(secret), false, secret)
  })

  it('GET /api/jobs/:jobId/events: a viewer reads the token stream with the reasoning delta blanked, the owner reads it whole', async () => {
    const owner = await readUntil(await call(`/api/jobs/${jobId}/events`, 'owner'), VISIBLE)
    assert.ok(owner.includes(JOB_SECRET), 'the owner keeps the reasoning stream')
    const viewer = await readUntil(await call(`/api/jobs/${jobId}/events`, 'viewer-1'), VISIBLE)
    assert.ok(viewer.includes(VISIBLE), 'the viewer reached the answer tokens past the reasoning event')
    for (const secret of ALL_SECRETS) assert.equal(viewer.includes(secret), false, secret)
    // The reasoning event is still there in order (the replay cursor needs its sequence), with an empty delta.
    assert.match(viewer, /"type":"thinking","data":\{"delta":""\}/u)
  })

  it('POST /api/threads/:id/messages: an editor\'s turn stream carries no reasoning, the owner\'s does', async () => {
    const post = (who: string) => call(`/api/threads/${threadId}/messages`, who, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'question', idempotencyKey: KEY }),
    })
    const ownerResponse = await post('owner')
    assert.equal(ownerResponse.status, 200)
    assert.ok((await readUntil(ownerResponse, VISIBLE)).includes(JOB_SECRET), 'the owner sees the delta')
    const editorResponse = await post('editor-1')
    assert.equal(editorResponse.status, 200)
    const editor = await readUntil(editorResponse, VISIBLE)
    assert.ok(editor.includes(VISIBLE), 'the editor reached the answer tokens')
    for (const secret of ALL_SECRETS) assert.equal(editor.includes(secret), false, secret)
    assert.equal(editor.includes('"type":"thinking"') || editor.includes('event: thinking'), false, 'no reasoning event at all')
  })

  it('the other routes a grantee may call carry no reasoning field', async () => {
    for (const path of [
      `/api/threads/${threadId}/context`, `/api/threads/${threadId}/retention`, `/api/sessions/${threadId}`,
      `/api/jobs/${jobId}`, '/api/threads', '/api/projects',
    ]) {
      for (const who of ['viewer-1', 'owner']) {
        const response = await call(path, who)
        const body = await response.text()
        for (const secret of ALL_SECRETS) assert.equal(body.includes(secret), false, `${who} ${path} ${secret}`)
      }
    }
  })
})

describe('reasoning helpers', () => {
  it('withoutReasoning nulls every thinking field and keeps the rest', () => {
    const messages = [{ id: 'a', content: 'x', thinking: 'secret' }, { id: 'b', content: 'y', thinking: null }]
    assert.deepEqual(withoutReasoning(messages), [{ id: 'a', content: 'x', thinking: null }, { id: 'b', content: 'y', thinking: null }])
    assert.equal(messages[0]!.thinking, 'secret', 'the input is not mutated')
  })

  it('redactChatEvent drops only thinking events', () => {
    assert.equal(redactChatEvent({ type: 'thinking', seq: 1, data: { delta: 's' } }), null)
    const token = { type: 'token', seq: 2, data: { delta: 'a' } } as const
    assert.equal(redactChatEvent(token), token)
  })

  it('redactJobEvent blanks a thinking delta and leaves other events untouched', () => {
    const thinking = { sequence: 3, output: { privacyClassification: 'private_chat', event: { type: 'thinking', data: { delta: 's' } } } }
    assert.deepEqual(redactJobEvent(thinking).output, { privacyClassification: 'private_chat', event: { type: 'thinking', data: { delta: '' } } })
    assert.equal(thinking.output.event.data.delta, 's', 'the stored event is not mutated')
    const token = { sequence: 4, output: { privacyClassification: 'private_chat', event: { type: 'token', data: { delta: 'a' } } } }
    assert.equal(redactJobEvent(token), token)
    assert.deepEqual(redactJobEvent({ sequence: 5 }), { sequence: 5 })
  })

  it('a route mounted without the hook sees everything (bare test mounts only)', () => {
    const bare = { get: () => undefined } as never
    assert.equal(canSeeReasoning(bare), true)
    assert.equal(canSeeReasoning({ get: () => ({ resourceOwner: false }) } as never), false)
    assert.equal(canSeeReasoning({ get: () => ({ resourceOwner: true }) } as never), true)
  })
})
