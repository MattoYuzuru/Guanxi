import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ollamaClientThroughKernel } from './fixtures/kernel.ts'
import {
  type OllamaClient,
  OllamaError,
  OllamaProtocolError,
  OllamaTimeoutError,
  OllamaUnavailableError,
} from '../src/ollama/client.ts'
import type { OllamaChatRequest } from '../src/ollama/types.ts'

const REQUEST: OllamaChatRequest = {
  model: 'fixture',
  messages: [{ role: 'user', content: 'hello' }],
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function tick(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

function track<T>(promise: Promise<T>): { tracked: Promise<T>; isSettled(): boolean } {
  let settled = false
  const tracked = promise.then(
    (value) => {
      settled = true
      return value
    },
    (error: unknown) => {
      settled = true
      throw error
    },
  )
  tracked.catch(() => undefined)
  return { tracked, isSettled: () => settled }
}

function abortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
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

  it('classifies a transport that never returns headers as connect timeout after it acknowledges abort', async () => {
    let providerSignal: AbortSignal | null | undefined
    const client = await clientWith((_input, init) => {
      providerSignal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        )
      })
    })

    await assert.rejects(
      client.chatStream(REQUEST).next(),
      (error) => error instanceof OllamaTimeoutError && error.phase === 'connect',
    )
    assert.equal(providerSignal?.aborted, true)
  })

  it('classifies a stream with headers but no first progress as load timeout after it acknowledges abort', async () => {
    let abortObserved = false
    const client = await clientWith(async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            'abort',
            () => {
              abortObserved = true
              controller.error(new DOMException('Aborted', 'AbortError'))
            },
            { once: true },
          )
        },
      })
      return new Response(body)
    })

    await assert.rejects(
      client.chatStream(REQUEST).next(),
      (error) => error instanceof OllamaTimeoutError && error.phase === 'load',
    )
    assert.equal(abortObserved, true)
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

  it('holds generator cleanup until a stuck provider cancel promise settles', async () => {
    const cancelGate = deferred<void>()
    let cancelStarted = false
    const client = await clientWith(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${partialLine()}\n`))
        },
        cancel() {
          cancelStarted = true
          return cancelGate.promise
        },
      })
      return new Response(body, { status: 200 })
    })
    const stream = client.chatStream(REQUEST)
    await stream.next()

    let settled = false
    const cleanup = stream.return(undefined).then(() => {
      settled = true
    })
    await tick()
    assert.equal(cancelStarted, true)
    assert.equal(settled, false, 'cleanup must wait for the provider cancel acknowledgement')

    cancelGate.resolve()
    await cleanup
    assert.equal(settled, true)
  })

  it('keeps an aborted chat POST pending until an uncooperative header fetch settles', async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    let providerSignal: AbortSignal | undefined
    const client = await clientWith(async (_input, init) => {
      providerSignal = init?.signal ?? undefined
      entered.resolve()
      await release.promise
      throw new Error('fixture late POST failure')
    })
    const controller = new AbortController()
    const state = track(client.chatStream(REQUEST, controller.signal).next())
    await entered.promise
    controller.abort('fixture stop')
    await tick()

    assert.equal(providerSignal?.aborted, true)
    assert.equal(state.isSettled(), false, 'the POST owner must wait for the actual fetch')
    release.reject(new Error('fixture late POST failure'))
    await assert.rejects(state.tracked, abortError)
  })

  it('disposes a late chat POST response body before surfacing abort', async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    const cancelGate = deferred<void>()
    let cancelStarted = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelStarted = true
        return cancelGate.promise
      },
    })
    const client = await clientWith(async () => {
      entered.resolve()
      await release.promise
      return new Response(body, { status: 200 })
    })
    const controller = new AbortController()
    const state = track(client.chatStream(REQUEST, controller.signal).next())
    await entered.promise
    controller.abort('fixture stop')
    await tick()

    release.resolve()
    await tick()
    assert.equal(cancelStarted, true)
    assert.equal(state.isSettled(), false, 'body cleanup must be acknowledged before return')
    cancelGate.resolve()
    await assert.rejects(state.tracked, abortError)
  })

  it('waits for the non-stream response body before surfacing abort', async () => {
    const entered = deferred<void>()
    const textStarted = deferred<void>()
    const textGate = deferred<void>()
    const client = await clientWith(async (input) => {
      if (new URL(String(input)).pathname === '/api/version') {
        return Response.json({ version: 'fixture' })
      }
      entered.resolve()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          textStarted.resolve()
          await textGate.promise
          controller.enqueue(new TextEncoder().encode(JSON.stringify({
            model: 'fixture', created_at: '2026-08-02T12:00:00.000Z', done: true,
          })))
          controller.close()
        },
      })
      return new Response(body, { status: 200 })
    })
    const controller = new AbortController()
    const state = track(client.chat(REQUEST, controller.signal))
    await entered.promise
    await textStarted.promise
    controller.abort('fixture stop')
    await tick()

    assert.equal(state.isSettled(), false, 'response.text() must settle before return')
    textGate.resolve()
    await assert.rejects(state.tracked, abortError)
  })

  it('waits for an error response body cancel before preserving the mapped HTTP error', async () => {
    const cancelGate = deferred<void>()
    const cancelStarted = deferred<void>()
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelStarted.resolve()
        return cancelGate.promise
      },
    })
    const client = await clientWith(async (input) => {
      if (new URL(String(input)).pathname === '/api/version') {
        return Response.json({ version: 'fixture' })
      }
      return new Response(body, { status: 503 })
    })
    const controller = new AbortController()
    const state = track(client.chat(REQUEST, controller.signal))
    await cancelStarted.promise
    controller.abort('fixture stop')
    await tick()

    assert.equal(state.isSettled(), false, 'error-body cleanup must settle before mapping')
    cancelGate.resolve()
    await assert.rejects(
      state.tracked,
      (error) => error instanceof OllamaError && error.status === 503,
    )
  })

  it('classifies a chat load timeout only after an uncooperative POST fetch settles', async () => {
    const entered = deferred<void>()
    const aborted = deferred<void>()
    const release = deferred<void>()
    const client = await clientWith(async (input, init) => {
      if (new URL(String(input)).pathname === '/api/version') {
        return Response.json({ version: 'fixture' })
      }
      entered.resolve()
      init?.signal?.addEventListener('abort', () => aborted.resolve(), { once: true })
      await release.promise
      throw new Error('fixture late timeout fetch')
    })
    const state = track(client.chat(REQUEST))
    await entered.promise
    await aborted.promise
    await tick()

    assert.equal(state.isSettled(), false, 'the deadline must wait for actual transport settlement')
    release.reject(new Error('fixture late timeout fetch'))
    await assert.rejects(
      state.tracked,
      (error) => error instanceof OllamaTimeoutError && error.phase === 'load',
    )
  })

  it('keeps aborted GET observations responsive and consumes the late fetch failure', async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const client = await clientWith(async () => {
        entered.resolve()
        await release.promise
        throw new Error('fixture late GET failure')
      })
      const controller = new AbortController()
      const version = client.version(controller.signal)
      await entered.promise
      controller.abort('fixture stop')
      await assert.rejects(version, abortError)
      release.reject(new Error('fixture late GET failure'))
      await tick()
      await tick()
      assert.deepEqual(unhandled, [])
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
    }
  })

  it('disposes a late GET response body after abort without delaying the observer', async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    const cancelGate = deferred<void>()
    let cancelStarted = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelStarted = true
        return cancelGate.promise
      },
    })
    const client = await clientWith(async () => {
      entered.resolve()
      await release.promise
      return new Response(body, { status: 200 })
    })
    const controller = new AbortController()
    const version = client.version(controller.signal)
    await entered.promise
    controller.abort('fixture stop')
    await assert.rejects(version, abortError)

    release.resolve()
    await tick()
    await tick()
    assert.equal(cancelStarted, true, 'the late GET response body is disposed')
    cancelGate.resolve()
  })

  it('keeps transport ownership when a synchronous dispatch observer throws', async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    const cancelGate = deferred<void>()
    let cancelStarted = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelStarted = true
        return cancelGate.promise
      },
    })
    const client = await clientWith(async (input, init) => {
      if (new URL(String(input)).pathname === '/api/version') {
        return Response.json({ version: 'fixture' })
      }
      entered.resolve()
      init?.signal?.addEventListener('abort', () => undefined, { once: true })
      await release.promise
      return new Response(body, { status: 200 })
    })
    const state = track(client.chat(REQUEST, undefined, () => {
      throw new Error('fixture observer failure')
    }))
    await entered.promise
    await tick()

    assert.equal(state.isSettled(), false, 'an observer throw must not release transport early')
    release.resolve()
    await tick()
    assert.equal(cancelStarted, true, 'the late response body is disposed')
    assert.equal(state.isSettled(), false, 'observer cleanup must acknowledge the body')
    cancelGate.resolve()
    await assert.rejects(
      state.tracked,
      (error) =>
        error instanceof OllamaUnavailableError
        && error.reason instanceof Error
        && /fixture observer failure/u.test(error.reason.message),
    )
  })

  it('keeps an aborted warm POST pending until its fetch settles', async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    let providerSignal: AbortSignal | undefined
    const client = await clientWith(async (input, init) => {
      if (new URL(String(input)).pathname === '/api/version') {
        return Response.json({ version: 'fixture' })
      }
      providerSignal = init?.signal ?? undefined
      entered.resolve()
      await release.promise
      throw new Error('fixture late warm failure')
    })
    const controller = new AbortController()
    const state = track(client.warm('fixture', 1024, '10m', controller.signal))
    await entered.promise
    controller.abort('fixture stop')
    await tick()

    assert.equal(providerSignal?.aborted, true)
    assert.equal(state.isSettled(), false, 'warm must wait for the actual POST fetch')
    release.reject(new Error('fixture late warm failure'))
    await assert.rejects(state.tracked, abortError)
  })

  it('keeps an aborted chat stream reader owned until its read and cancel settle', async () => {
    const pullGate = deferred<void>()
    const cancelGate = deferred<void>()
    let cancelStarted = false
    const client = await clientWith(async () => {
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await pullGate.promise
          controller.enqueue(new TextEncoder().encode(`${partialLine()}\n`))
        },
        cancel() {
          cancelStarted = true
          return cancelGate.promise
        },
      })
      return new Response(body, { status: 200 })
    })
    const controller = new AbortController()
    const state = track(client.chatStream(REQUEST, controller.signal).next())
    await tick()
    controller.abort('fixture stop')
    await tick()

    assert.equal(state.isSettled(), false, 'a pending reader.read() must settle before return')
    pullGate.resolve()
    await tick()
    assert.equal(cancelStarted, true)
    assert.equal(state.isSettled(), false, 'reader.cancel() must acknowledge completion')
    cancelGate.resolve()
    await assert.rejects(state.tracked, abortError)
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
