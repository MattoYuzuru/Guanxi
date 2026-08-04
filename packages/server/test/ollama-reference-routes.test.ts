import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import type { AppContext } from '../src/context.ts'
import { modelsRoutes } from '../src/http/models-routes.ts'
import type { OllamaClient } from '../src/ollama/client.ts'
import type { OllamaPullChunk } from '../src/ollama/types.ts'

type PullCall = { name: string; signal: AbortSignal }

function appWith(
  pull: (name: string, signal: AbortSignal) => AsyncGenerator<OllamaPullChunk>,
) {
  const calls: PullCall[] = []
  const app = new Hono()
  app.route('/api/models', modelsRoutes({
    ollama: () => ({
      pull(name: string, signal: AbortSignal) {
        calls.push({ name, signal })
        return pull(name, signal)
      },
    }) as OllamaClient,
  } as unknown as AppContext))
  return { app, calls }
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://local.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function frames(text: string): Array<{ type: string; data: Record<string, unknown> }> {
  return text.split('\n').filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as { type: string; data: Record<string, unknown> })
}

describe('Ollama reference preview and confirmed pull routes', () => {
  it('keeps preview pure and never calls Ollama', async () => {
    const { app, calls } = appWith(async function* () {
      throw new Error('pull must not run')
    })
    const response = await app.request(jsonRequest(
      '/api/models/imports/ollama-reference/preview',
      { reference: 'https://ollama.com/library/qwen3:8b' },
    ))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      preview: {
        inputKind: 'official_page_url',
        displayValue: 'https://ollama.com/library/qwen3:8b',
        normalizedModelName: 'qwen3:8b',
      },
    })
    assert.equal(calls.length, 0)
  })

  it('revalidates confirmation and sends one exact option-free pull target', async () => {
    const { app, calls } = appWith(async function* () {
      yield { status: 'pulling manifest' }
      yield { status: 'downloading', digest: 'sha256:layer', total: 100, completed: 50 }
      yield { status: 'success' }
    })
    const response = await app.request(jsonRequest(
      '/api/models/imports/ollama-reference/start',
      { reference: 'QWEN3:8B', confirmedModelName: 'qwen3:8b' },
    ))
    assert.equal(response.status, 200)
    const events = frames(await response.text())
    assert.deepEqual(events.map((event) => event.type), [
      'progress', 'progress', 'progress', 'done',
    ])
    assert.equal(events.at(-1)?.data['name'], 'qwen3:8b')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.name, 'qwen3:8b')
  })

  it('fails closed on mismatch/options and redacts input and provider errors', async () => {
    const { app, calls } = appWith(async function* () {
      yield { error: 'token=secret /Users/private raw body' }
    })
    for (const body of [
      { reference: 'qwen3', confirmedModelName: 'other:latest' },
      { reference: 'qwen3', confirmedModelName: 'qwen3:latest', insecure: true },
      { reference: 'https://user:secret@ollama.com/library/qwen3', confirmedModelName: 'qwen3:latest' },
    ]) {
      const response = await app.request(jsonRequest(
        '/api/models/imports/ollama-reference/start', body,
      ))
      assert.equal(response.status, 400)
      assert.doesNotMatch(await response.text(), /secret|Users|raw body/u)
    }
    assert.equal(calls.length, 0)

    const response = await app.request(jsonRequest(
      '/api/models/imports/ollama-reference/start',
      { reference: 'qwen3', confirmedModelName: 'qwen3:latest' },
    ))
    const text = await response.text()
    assert.match(text, /Ollama could not pull the confirmed model/u)
    assert.doesNotMatch(text, /secret|Users|raw body/u)
  })

  it('requires terminal success and cancels only the connection-owned pull', async () => {
    let signal: AbortSignal | undefined
    const { app } = appWith(async function* (_name, pullSignal) {
      signal = pullSignal
      yield { status: 'downloading', total: 100, completed: 1 }
    })
    const response = await app.request(jsonRequest(
      '/api/models/imports/ollama-reference/start',
      { reference: 'qwen3', confirmedModelName: 'qwen3:latest' },
    ))
    const events = frames(await response.text())
    assert.deepEqual(events.map((event) => event.type), ['progress', 'error'])
    assert.equal(events.at(-1)?.data['code'], 'runtime_protocol')

    const pending = app.request(jsonRequest(
      '/api/models/imports/ollama-reference/start',
      { reference: 'qwen3', confirmedModelName: 'qwen3:latest' },
    ))
    const streamed = await pending
    await streamed.body?.cancel()
    assert.equal(signal?.aborted, true)
  })

  it('links request abort to the exact pull and releases the listener', async () => {
    let signal: AbortSignal | undefined
    const { app } = appWith(async function* (_name, pullSignal) {
      signal = pullSignal
      await new Promise<void>((resolve) => pullSignal.addEventListener(
        'abort', () => resolve(), { once: true },
      ))
    })
    const controller = new AbortController()
    const response = await app.request(new Request(
      'http://local.test/api/models/imports/ollama-reference/start',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reference: 'qwen3', confirmedModelName: 'qwen3:latest',
        }),
        signal: controller.signal,
      },
    ))
    const reading = response.text()
    controller.abort('caller-disconnected')
    await reading
    assert.equal(signal?.aborted, true)
    assert.equal(signal?.reason, 'caller-disconnected')
  })

  it('rejects malformed and regressing progress without a done event', async () => {
    const malformed = appWith(async function* () {
      yield { status: 'downloading', digest: 'sha256:layer', total: 10, completed: 11 }
    })
    const malformedResponse = await malformed.app.request(jsonRequest(
      '/api/models/imports/ollama-reference/start',
      { reference: 'qwen3', confirmedModelName: 'qwen3:latest' },
    ))
    assert.deepEqual(frames(await malformedResponse.text()).map((event) => event.type), [
      'error',
    ])

    const regressing = appWith(async function* () {
      yield { status: 'downloading', digest: 'sha256:layer', total: 10, completed: 8 }
      yield { status: 'downloading', digest: 'sha256:layer', total: 10, completed: 7 }
    })
    const regressingResponse = await regressing.app.request(jsonRequest(
      '/api/models/imports/ollama-reference/start',
      { reference: 'qwen3', confirmedModelName: 'qwen3:latest' },
    ))
    const events = frames(await regressingResponse.text())
    assert.deepEqual(events.map((event) => event.type), ['progress', 'error'])
    assert.equal(events.at(-1)?.data['code'], 'runtime_protocol')
  })
})
