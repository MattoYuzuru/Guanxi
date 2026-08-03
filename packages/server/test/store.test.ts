import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { ToolCall } from '@alamo/contract'
import { openDb } from '../src/store/db.ts'
import { SettingsStore } from '../src/store/settings.ts'
import { ThreadStore } from '../src/store/threads.ts'
import { WorkspaceStore } from '../src/store/workspaces.ts'

describe('SQLite stores', () => {
  it('сохраняет тред, сообщения, компакцию и журнал инструмента', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-store-'))
    test.after(() => rm(root, { recursive: true, force: true }))

    const db = openDb(':memory:')
    test.after(() => db.close())

    const workspaces = new WorkspaceStore(db)
    const workspace = workspaces.create(root, 'fixture')
    const threads = new ThreadStore(db)
    const thread = threads.create({
      title: 'Тест',
      mode: 'agent',
      model: 'qwen',
      workspaceId: workspace.id,
      options: { numCtx: 4_096, temperature: 0, think: 'off' },
    })

    for (let index = 0; index < 6; index++) {
      threads.addMessage({
        threadId: thread.id,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message-${index}`,
      })
    }

    const summary = threads.replaceWithSummary(thread.id, 1, 'summary', null)
    const messages = threads.messages(thread.id)

    assert.equal(summary.isCompaction, true)
    assert.deepEqual(
      messages.map((message) => message.content),
      ['summary', 'message-2', 'message-3', 'message-4', 'message-5'],
    )

    const call: ToolCall = {
      id: 'call-1',
      name: 'edit_file',
      arguments: { path: 'README.md' },
      status: 'running',
      result: null,
      error: null,
      durationMs: null,
      source: 'builtin',
      parsedFrom: 'content_json',
      diff: null,
    }
    threads.recordToolRun(thread.id, summary.id, call)
    threads.recordToolRun(thread.id, summary.id, {
      ...call,
      status: 'ok',
      result: 'done',
      durationMs: 12,
    })

    const recorded = db.prepare('SELECT status, result, duration_ms FROM tool_runs WHERE id = ?').get(
      call.id,
    ) as { status: string; result: string; duration_ms: number }
    assert.deepEqual({ ...recorded }, { status: 'ok', result: 'done', duration_ms: 12 })
  })

  it('никогда не возвращает сохранённый API-ключ', () => {
    const db = openDb(':memory:')
    const settings = new SettingsStore(db, { ollamaHost: 'http://127.0.0.1:11434' })

    settings.update({ webSearch: { provider: 'brave', apiKey: 'secret' } })

    assert.equal(settings.webSearchApiKey(), 'secret')
    assert.deepEqual(settings.get().webSearch, {
      provider: 'brave',
      baseUrl: null,
      hasApiKey: true,
    })
    db.close()
  })

  it('defaults legacy settings to prewarm enabled and round-trips an additive toggle', () => {
    const db = openDb(':memory:')
    const settings = new SettingsStore(db, { ollamaHost: 'http://127.0.0.1:11434' })

    assert.equal(settings.get().prewarmEnabled, true)
    assert.equal(settings.update({ prewarmEnabled: false }).prewarmEnabled, false)
    assert.equal(settings.get().prewarmEnabled, false)
    assert.equal(settings.update({ prewarmEnabled: true }).prewarmEnabled, true)
    db.close()
  })

  it('terminalizes an assistant once and never overwrites failure with completed', () => {
    const db = openDb(':memory:')
    const threads = new ThreadStore(db)
    const thread = threads.create({
      title: 'terminal invariant',
      mode: 'chat',
      model: 'qwen',
      workspaceId: null,
      options: { numCtx: 4_096, temperature: 0, think: 'off' },
    })
    const assistant = threads.addMessage({
      threadId: thread.id,
      role: 'assistant',
      content: '',
    })

    assert.equal(assistant.turnStatus, 'pending')

    const failed = threads.terminalizeMessage(assistant.id, {
      outcome: 'failed',
      error: {
        code: 'runtime_protocol',
        message: 'Ollama ended the stream without the required terminal chunk',
      },
      stopReason: 'protocol_error',
      content: 'partial',
      thinking: 'partial thought',
      toolCalls: [],
      usage: null,
    })
    const lateSuccess = threads.terminalizeMessage(assistant.id, {
      outcome: 'completed',
      error: null,
      stopReason: 'stop',
      content: 'late success',
      thinking: null,
      toolCalls: [],
      usage: null,
    })

    assert.equal(failed.applied, true)
    assert.equal(lateSuccess.applied, false)
    assert.deepEqual(threads.getMessage(assistant.id), failed.message)
    assert.equal(lateSuccess.message.turnStatus, 'failed')
    assert.equal(lateSuccess.message.content, 'partial')
    assert.equal(lateSuccess.message.stopReason, 'protocol_error')
    db.close()
  })

  it('selects repeated compaction boundaries from persisted seq instead of array indexes', () => {
    const db = openDb(':memory:')
    const threads = new ThreadStore(db)
    const thread = threads.create({
      title: 'repeated compaction',
      mode: 'chat',
      model: 'qwen',
      workspaceId: null,
      options: { numCtx: 4_096, temperature: 0, think: 'off' },
    })

    for (let index = 0; index < 9; index += 1) {
      threads.addMessage({ threadId: thread.id, role: 'user', content: `message-${index}` })
    }
    const first = threads.compactionCandidates(thread.id, 4)
    assert.equal(first?.upToSeq, 4)
    threads.replaceWithSummary(thread.id, first!.upToSeq, 'summary-1', null)

    for (let index = 9; index < 15; index += 1) {
      threads.addMessage({ threadId: thread.id, role: 'user', content: `message-${index}` })
    }
    const second = threads.compactionCandidates(thread.id, 4)

    assert.equal(second?.upToSeq, 10)
    assert.deepEqual(
      second?.messages.map((message) => message.content),
      ['summary-1', 'message-5', 'message-6', 'message-7', 'message-8', 'message-9', 'message-10'],
    )

    threads.replaceWithSummary(thread.id, second!.upToSeq, 'summary-2', null)
    const rows = db
      .prepare('SELECT seq, content FROM messages WHERE thread_id = ? ORDER BY seq')
      .all(thread.id) as Array<{ seq: number; content: string }>
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { seq: 10, content: 'summary-2' },
      { seq: 11, content: 'message-11' },
      { seq: 12, content: 'message-12' },
      { seq: 13, content: 'message-13' },
      { seq: 14, content: 'message-14' },
    ])

    db.close()
  })
})
