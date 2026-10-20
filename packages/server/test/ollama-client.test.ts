import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ollamaClientThroughKernel } from './fixtures/kernel.ts'
import {
  type OllamaClient,
  OllamaProtocolError,
  OllamaTimeoutError,
} from '../src/ollama/client.ts'
import type { OllamaChatRequest } from '../src/ollama/types.ts'

const REQUEST: OllamaChatRequest = {
  model: 'fixture',
  messages: [{ role: 'user', content: 'hello' }],
}

function rejectOnAbort(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener(
      'abort',
      () => reject(new DOMException('Aborted', 'AbortError')),
      { once: true },
    )
  })
}

function stalledBody(signal: AbortSignal | null | undefined, firstLine?: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (firstLine) controller.enqueue(new TextEncoder().encode(`${firstLine}\n`))
      signal?.addEventListener(
        'abort',
        () => controller.error(new DOMException('Aborted', 'AbortError')),
        { once: true },
      )
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

function clientWith(fetchImpl: typeof fetch): Promise<OllamaClient> {
  return ollamaClientThroughKernel({
    host: 'http://fixture.invalid',
    connectTimeoutMs: 15,
    loadTimeoutMs: 15,
    streamIdleTimeoutMs: 15,
    fetch: fetchImpl,
  })
}

function partialLine(content = 'partial'): string {
  return JSON.stringify({
    model: 'fixture',
    created_at: '2026-08-02T12:00:00.000Z',
    message: { role: 'assistant', content },
    done: false,
  })
}

describe('Ollama client timeout and protocol boundaries', () => {
  it('uses documented blob and create HTTP bodies without a path, Modelfile or arbitrary options', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const digest = `sha256:${'a'.repeat(64)}`
    const client = await clientWith(async (input, init) => {
      calls.push({ url: String(input), init })
      if (init?.method === 'HEAD') return new Response(null, { status: 404 })
      if (String(input).includes('/api/blobs/')) return new Response(null, { status: 201 })
      return new Response([
        JSON.stringify({ status: 'parsing GGUF' }),
        JSON.stringify({ status: `using existing layer ${digest}` }),
        JSON.stringify({ status: 'writing manifest' }),
        JSON.stringify({ status: 'success' }),
      ].join('\n'))
    })

    assert.equal(await client.blobExists(digest), false)
    await client.pushBlob(digest, Buffer.from('GGUF'), 4, new AbortController().signal, 50)
    const frames = []
    for await (const frame of client.createModelFromBlob(
      'owner/model:latest', 'model.gguf', digest,
    )) frames.push(frame)

    assert.equal(calls.length, 3)
    assert.equal(calls[0]?.url, `http://fixture.invalid/api/blobs/${digest}`)
    assert.equal(calls[0]?.init?.method, 'HEAD')
    assert.equal(calls[1]?.init?.method, 'POST')
    assert.equal(new Headers(calls[1]?.init?.headers).get('content-type'), 'application/octet-stream')
    assert.equal(calls[2]?.url, 'http://fixture.invalid/api/create')
    const body = JSON.parse(String(calls[2]?.init?.body))
    assert.deepEqual(body, {
      model: 'owner/model:latest', files: { 'model.gguf': digest }, stream: true,
    })
    assert.equal('path' in body, false)
    assert.equal('modelfile' in body, false)
    assert.equal('parameters' in body, false)
    assert.equal(frames.at(-1)?.status, 'success')
  })

  it('bounds create frame count/bytes and rejects malformed provider frames', async () => {
    const digest = `sha256:${'a'.repeat(64)}`
    for (const response of [
      new Response(`${JSON.stringify({ status: 'x'.repeat(100) })}\n`),
      new Response(`${JSON.stringify({ status: 'ok', arbitrary: true })}\n`),
    ]) {
      const client = await clientWith(async () => response)
      const stream = client.createModelFromBlob(
        'model:latest', 'model.gguf', digest, undefined,
        { connectTimeoutMs: 20, loadTimeoutMs: 20, streamIdleTimeoutMs: 20, maxLineBytes: 32, maxFrames: 2 },
      )
      await assert.rejects(
        stream.next(),
        (error) => error instanceof OllamaProtocolError,
      )
    }
  })

  it('classifies a transport that never returns headers as connect timeout', async () => {
    let providerSignal: AbortSignal | null | undefined
    const client = await clientWith((_input, init) => {
      providerSignal = init?.signal
      return new Promise<Response>(() => {})
    })

    await assert.rejects(
      client.chatStream(REQUEST).next(),
      (error) => error instanceof OllamaTimeoutError && error.phase === 'connect',
    )
    assert.equal(providerSignal?.aborted, true)
  })

  it('classifies a stream with headers but no first progress as load timeout', async () => {
    let cancelObserved = false
    const client = await clientWith(async () => {
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelObserved = true
          return new Promise<void>(() => {})
        },
      })
      return new Response(body)
    })

    await assert.rejects(
      client.chatStream(REQUEST).next(),
      (error) => error instanceof OllamaTimeoutError && error.phase === 'load',
    )
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(cancelObserved, true)
  })

  it('does not treat incomplete transport bytes as provider progress', async () => {
    const client = await clientWith(async (_input, init) => {
      let timer: ReturnType<typeof setInterval> | undefined
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          timer = setInterval(() => {
            controller.enqueue(new TextEncoder().encode('{'))
          }, 3)
          init?.signal?.addEventListener(
            'abort',
            () => {
              if (timer) clearInterval(timer)
              controller.error(new DOMException('Aborted', 'AbortError'))
            },
            { once: true },
          )
        },
        cancel() {
          if (timer) clearInterval(timer)
        },
      })
      return new Response(body, { status: 200 })
    })

    await assert.rejects(
      client.chatStream(REQUEST).next(),
      (error) => error instanceof OllamaTimeoutError && error.phase === 'load',
    )
  })

  it('classifies a stream that stalls after partial output as stream-idle timeout', async () => {
    const client = await clientWith(async (_input, init) =>
      stalledBody(init?.signal, partialLine()),
    )
    const stream = client.chatStream(REQUEST)

    assert.equal((await stream.next()).value?.message?.content, 'partial')
    await assert.rejects(
      stream.next(),
      (error) => error instanceof OllamaTimeoutError && error.phase === 'stream_idle',
    )
  })

  it('uses optional per-call stream deadlines without changing client defaults', async () => {
    const client = await ollamaClientThroughKernel({
      host: 'http://fixture.invalid',
      connectTimeoutMs: 100,
      loadTimeoutMs: 100,
      streamIdleTimeoutMs: 100,
      fetch: async (_input, init) => stalledBody(init?.signal),
    })
    const startedAt = Date.now()
    await assert.rejects(
      client.chatStream(REQUEST, undefined, {
        connectTimeoutMs: 20,
        loadTimeoutMs: 10,
        streamIdleTimeoutMs: 10,
      }).next(),
      (error) =>
        error instanceof OllamaTimeoutError
        && error.phase === 'load'
        && error.timeoutMs === 10,
    )
    assert.ok(Date.now() - startedAt < 80)
  })

  it('allows a continuously progressing stream to outlive one idle interval', async () => {
    const client = await clientWith(async (_input, init) => {
      let emitted = 0
      let timer: ReturnType<typeof setInterval> | undefined
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          timer = setInterval(() => {
            emitted += 1
            const done = emitted === 8
            controller.enqueue(
              new TextEncoder().encode(
                `${JSON.stringify({
                  model: 'fixture',
                  created_at: '2026-08-02T12:00:00.000Z',
                  message: { role: 'assistant', content: done ? '' : String(emitted) },
                  done,
                  done_reason: done ? 'stop' : undefined,
                })}\n`,
              ),
            )
            if (done) {
              clearInterval(timer)
              controller.close()
            }
          }, 3)
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(new DOMException('Aborted', 'AbortError')),
            { once: true },
          )
        },
        cancel() {
          if (timer) clearInterval(timer)
        },
      })
      return new Response(body, { status: 200 })
    })

    const startedAt = Date.now()
    const chunks = []
    for await (const chunk of client.chatStream(REQUEST)) chunks.push(chunk)

    assert.equal(chunks.length, 8)
    assert.equal(chunks.at(-1)?.done, true)
    assert.ok(Date.now() - startedAt >= 15)
  })

  it('keeps an external abort authoritative when observed with a deadline', async () => {
    const external = new AbortController()
    const client = await clientWith(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              external.abort('guanxi:explicit-stop')
              reject(new DOMException('Aborted', 'AbortError'))
            },
            { once: true },
          )
        }),
    )

    await assert.rejects(
      client.chatStream(REQUEST, external.signal).next(),
      (error) => error instanceof DOMException && error.name === 'AbortError',
    )
    assert.equal(external.signal.reason, 'guanxi:explicit-stop')
  })

  it('does not let a stuck provider cancel promise hold generator cleanup', async () => {
    const client = await clientWith(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${partialLine()}\n`))
        },
        cancel() {
          return new Promise<void>(() => {})
        },
      })
      return new Response(body, { status: 200 })
    })
    const stream = client.chatStream(REQUEST)
    await stream.next()

    const cleanup = await Promise.race([
      stream.return(undefined).then(() => 'released'),
      new Promise<'stuck'>((resolve) => setTimeout(() => resolve('stuck'), 30)),
    ])
    assert.equal(cleanup, 'released')
  })

  it('rejects malformed version and ps responses as protocol failures', async () => {
    const client = await clientWith(async () =>
      new Response(JSON.stringify({ unexpected: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await assert.rejects(
      client.version(),
      (error) => error instanceof OllamaProtocolError && error.endpoint === '/api/version',
    )
    await assert.rejects(
      client.ps(),
      (error) => error instanceof OllamaProtocolError && error.endpoint === '/api/ps',
    )
  })
})
