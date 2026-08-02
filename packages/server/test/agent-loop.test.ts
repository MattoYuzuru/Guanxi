import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { ApprovalGate } from '../src/agent/approvals.ts'
import { runTurn } from '../src/agent/loop.ts'
import { PrefillTracker } from '../src/context/usage.ts'
import { OllamaError, type OllamaClient } from '../src/ollama/client.ts'
import type {
  OllamaChatChunk,
  OllamaChatRequest,
} from '../src/ollama/types.ts'
import { openDb } from '../src/store/db.ts'
import { ThreadStore } from '../src/store/threads.ts'
import { ToolRegistry } from '../src/tools/registry.ts'

function chunk(content: string, promptTokens: number): OllamaChatChunk {
  return {
    model: 'qwen',
    created_at: new Date().toISOString(),
    message: { role: 'assistant', content },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: promptTokens,
    prompt_eval_duration: 500_000_000,
    eval_count: 8,
    eval_duration: 100_000_000,
    total_duration: 600_000_000,
  }
}

it('показывает diff до подтверждения и соблюдает порядок assistant → tool', async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'alamo-agent-'))
  test.after(() => rm(root, { recursive: true, force: true }))
  const target = join(root, 'README.md')
  await writeFile(target, 'before\n', 'utf8')

  const db = openDb(':memory:')
  test.after(() => db.close())
  const store = new ThreadStore(db)
  const thread = store.create({
    title: 'edit',
    mode: 'agent',
    model: 'qwen',
    workspaceId: null,
    options: { numCtx: 4_096, temperature: 0, think: 'off' },
  })
  store.addMessage({ threadId: thread.id, role: 'user', content: 'Замени строку' })

  const requests: OllamaChatRequest[] = []
  const fakeClient = {
    chatStream(request: OllamaChatRequest) {
      requests.push(request)
      const turn = requests.length
      return (async function* () {
        yield turn === 1
          ? chunk(
              JSON.stringify({
                name: 'edit_file',
                arguments: {
                  path: 'README.md',
                  old_string: 'before',
                  new_string: 'after',
                },
              }),
              100,
            )
          : chunk('Готово', 130)
      })()
    },
  } as unknown as OllamaClient

  const approvals = new ApprovalGate()
  const events = runTurn({
    thread,
    workspace: {
      id: 'workspace',
      name: 'fixture',
      rootPath: root,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      exists: true,
    },
    client: fakeClient,
    store,
    registry: new ToolRegistry({ hasWorkspace: true, enableBash: false }),
    approvals,
    tracker: new PrefillTracker(),
    modelSupportsTools: false,
    autoApprove: false,
    enableBash: false,
    signal: new AbortController().signal,
  })

  let approvalSeen = false
  for await (const event of events) {
    if (event.type !== 'tool_approval_required') continue
    approvalSeen = true
    assert.equal(await readFile(target, 'utf8'), 'before\n')
    assert.deepEqual(event.data.toolCall.diff, {
      path: 'README.md',
      before: 'before\n',
      after: 'after\n',
    })
    assert.equal(approvals.decide(event.data.toolCall.id, 'approve'), true)
  }

  assert.equal(approvalSeen, true)
  assert.equal(await readFile(target, 'utf8'), 'after\n')
  assert.deepEqual(
    requests[1]?.messages.slice(-2).map((message) => message.role),
    ['assistant', 'tool'],
  )
  assert.equal(requests[1]?.messages.at(-2)?.tool_calls?.[0]?.function.name, 'edit_file')

  const persisted = store.messages(thread.id)
  assert.equal(persisted.at(-1)?.content, 'Готово')
  assert.equal(persisted[1]?.toolCalls[0]?.status, 'ok')
})

it('сохраняет частичный ответ при upstream-ошибке Ollama', async (test) => {
  const db = openDb(':memory:')
  test.after(() => db.close())
  const store = new ThreadStore(db)
  const thread = store.create({
    title: 'partial',
    mode: 'chat',
    model: 'qwen',
    workspaceId: null,
    options: { numCtx: 4_096, temperature: 0, think: 'off' },
  })
  store.addMessage({ threadId: thread.id, role: 'user', content: 'Ответь' })

  const fakeClient = {
    chatStream() {
      return (async function* () {
        yield {
          model: 'qwen',
          created_at: new Date().toISOString(),
          message: { role: 'assistant' as const, content: 'Частичный ответ' },
          done: false,
        }
        throw new OllamaError('модель исчезла', 404)
      })()
    },
  } as unknown as OllamaClient

  const events = []
  for await (const event of runTurn({
    thread,
    workspace: null,
    client: fakeClient,
    store,
    registry: new ToolRegistry({ hasWorkspace: false, enableBash: false }),
    approvals: new ApprovalGate(),
    tracker: new PrefillTracker(),
    modelSupportsTools: false,
    autoApprove: false,
    enableBash: false,
    signal: new AbortController().signal,
  })) {
    events.push(event)
  }

  const error = events.find((event) => event.type === 'error')
  assert.equal(error?.type === 'error' ? error.data.code : null, 'upstream_error')
  assert.equal(store.messages(thread.id).at(-1)?.content, 'Частичный ответ')
})
