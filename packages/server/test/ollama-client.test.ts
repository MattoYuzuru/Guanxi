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

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
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

  it('keeps a partial non-stream body owned until cancellation acknowledges before abort', async () => {
    const textStarted = deferred<void>()
    const textGate = deferred<void>()
    const cancelGate = deferred<void>()
    let source!: ReadableStreamDefaultController<Uint8Array>
    let cancelRequested = false
    let cancelCalls = 0
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller
      },
      async pull(controller) {
        pulls += 1
        if (pulls === 1) return
        textStarted.resolve()
        await textGate.promise
        if (cancelRequested) return
        controller.enqueue(new TextEncoder().encode(JSON.stringify({
          model: 'fixture', created_at: '2026-08-02T12:00:00.000Z', done: true,
        })))
        controller.close()
      },
      cancel() {
        cancelRequested = true
        cancelCalls += 1
        return cancelGate.promise
      },
    })
    const client = await clientWith(async (input) => {
      if (new URL(String(input)).pathname === '/api/version') {
        return Response.json({ version: 'fixture' })
      }
      return new Response(body, { status: 200 })
    })
    const controller = new AbortController()
    const state = track(client.chat(REQUEST, controller.signal))
    await textStarted.promise
    controller.abort('fixture stop')
    await tick()
    try {
      assert.equal(cancelCalls, 1, 'abort must request body cancel before awaiting the pull')
      assert.equal(state.isSettled(), false, 'body cancellation must settle before return')
      assert.equal(body.locked, true, 'the reader lock stays owned while cancellation settles')
      cancelGate.resolve()
      await assert.rejects(state.tracked, abortError)
      assert.equal(cancelCalls, 1, 'cleanup must reuse the one cancellation request')
    } finally {
      textGate.resolve()
      if (!cancelRequested) {
        source.enqueue(new TextEncoder().encode(JSON.stringify({ done: true })))
        source.close()
      }
      cancelGate.resolve()
      await state.tracked.catch(() => undefined)
    }
  })

  it('requests body cancel before awaiting a cancel-driven non-stream read', async () => {
    const reading = deferred<void>()
    const cancelGate = deferred<void>()
    let source!: ReadableStreamDefaultController<Uint8Array>
    let cancelCalls = 0
    let cancelAcknowledged = false
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller
      },
      pull() {
        pulls += 1
        if (pulls > 1) reading.resolve()
      },
      cancel() {
        cancelCalls += 1
        return cancelGate.promise.then(() => {
          cancelAcknowledged = true
        })
      },
    })
    const client = await clientWith(async (input) => {
      if (new URL(String(input)).pathname === '/api/version') {
        return Response.json({ version: 'fixture' })
      }
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const controller = new AbortController()
    const state = track(client.chat(REQUEST, controller.signal))
    await reading.promise
    await tick()
    assert.equal(body.locked, true, 'the client owns the reader while the read is pending')
    controller.abort('fixture stop')
    await tick()
    try {
      assert.equal(cancelCalls, 1, 'abort must request body cancel before awaiting the read')
      assert.equal(state.isSettled(), false, 'the call must wait for the actual cancel acknowledgement')
      assert.equal(body.locked, true, 'the reader lock stays owned while cancellation settles')
      cancelGate.resolve()
      await assert.rejects(state.tracked, abortError)
      assert.equal(cancelAcknowledged, true)
      assert.equal(cancelCalls, 1, 'cleanup must reuse the one cancellation request')
    } finally {
      if (cancelCalls === 0) {
        source.enqueue(new TextEncoder().encode(JSON.stringify({ done: true })))
        source.close()
      }
      cancelGate.resolve()
      await state.tracked.catch(() => undefined)
    }
  })

  it('requests body cancel before awaiting a cancel-driven non-stream read on a deadline', async () => {
    const reading = deferred<void>()
    const cancelStarted = deferred<void>()
    const cancelGate = deferred<void>()
    let source!: ReadableStreamDefaultController<Uint8Array>
    let cancelCalls = 0
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller
      },
      pull() {
        pulls += 1
        if (pulls > 1) reading.resolve()
      },
      cancel() {
        cancelCalls += 1
        cancelStarted.resolve()
        return cancelGate.promise
      },
    })
    const client = await ollamaClientThroughKernel({
      host: 'http://fixture.invalid',
      connectTimeoutMs: 100,
      loadTimeoutMs: 40,
      fetch: async (input) => {
        if (new URL(String(input)).pathname === '/api/version') {
          return Response.json({ version: 'fixture' })
        }
        return new Response(body, { status: 200 })
      },
    })
    const state = track(client.chat(REQUEST))
    await reading.promise
    await Promise.race([cancelStarted.promise, delay(300)])
    try {
      assert.equal(cancelCalls, 1, 'the deadline must request body cancel before awaiting the read')
      assert.equal(state.isSettled(), false, 'the deadline must await the cancel acknowledgement')
      assert.equal(body.locked, true, 'the reader lock stays owned while cancellation settles')
      cancelGate.resolve()
      await assert.rejects(
        state.tracked,
        (error) =>
          error instanceof OllamaTimeoutError
          && error.phase === 'load'
          && error.timeoutMs === 40,
      )
      assert.equal(cancelCalls, 1)
    } finally {
      if (cancelCalls === 0) {
        source.enqueue(new TextEncoder().encode(JSON.stringify({ done: true })))
        source.close()
      }
      cancelGate.resolve()
      await state.tracked.catch(() => undefined)
    }
  })

  it('consumes a rejected late non-stream body cancel and preserves the abort outcome', async () => {
    const reading = deferred<void>()
    const cancelGate = deferred<void>()
    let source!: ReadableStreamDefaultController<Uint8Array>
    let cancelCalls = 0
    let pulls = 0
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller
        },
        pull() {
          pulls += 1
          if (pulls > 1) reading.resolve()
        },
        cancel() {
          cancelCalls += 1
          return cancelGate.promise
        },
      })
      const client = await clientWith(async (input) => {
        if (new URL(String(input)).pathname === '/api/version') {
          return Response.json({ version: 'fixture' })
        }
        return new Response(body, { status: 200 })
      })
      const controller = new AbortController()
      const state = track(client.chat(REQUEST, controller.signal))
      await reading.promise
      controller.abort('fixture stop')
      await tick()
      try {
        assert.equal(cancelCalls, 1, 'abort must request body cancel before awaiting the read')
        assert.equal(state.isSettled(), false)
        cancelGate.reject(new Error('fixture late body cancel failure'))
        await assert.rejects(state.tracked, abortError)
        await tick()
        await tick()
        assert.equal(cancelCalls, 1)
        assert.deepEqual(unhandled, [])
      } finally {
        if (cancelCalls === 0) {
          source.enqueue(new TextEncoder().encode(JSON.stringify({ done: true })))
          source.close()
        }
        cancelGate.resolve()
        await state.tracked.catch(() => undefined)
      }
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
    }
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

  it('requests reader cancel before awaiting a cancel-driven pending read', async () => {
    const reading = deferred<void>()
    const cancelGate = deferred<void>()
    let cancelCalls = 0
    let cancelAcknowledged = false
    const body = new ReadableStream<Uint8Array>({
      pull() {
        reading.resolve()
      },
      cancel() {
        cancelCalls += 1
        return cancelGate.promise.then(() => {
          cancelAcknowledged = true
        })
      },
    })
    const client = await clientWith(async () => new Response(body, { status: 200 }))
    const controller = new AbortController()
    const state = track(client.chatStream(REQUEST, controller.signal).next())
    await reading.promise
    await tick()
    assert.equal(body.locked, true, 'the client owns the reader while the read is pending')

    controller.abort('fixture stop')
    await tick()
    assert.equal(cancelCalls, 1, 'abort must request reader cancel before awaiting the read')
    assert.equal(state.isSettled(), false, 'the call must wait for the actual cancel acknowledgment')
    assert.equal(body.locked, true, 'the reader lock stays owned while cancellation settles')

    cancelGate.resolve()
    await assert.rejects(state.tracked, abortError)
    assert.equal(cancelAcknowledged, true)
    assert.equal(cancelCalls, 1, 'cleanup must reuse the one cancellation request')
  })

  it('requests reader cancel before awaiting a cancel-driven read on a stream deadline', async () => {
    const reading = deferred<void>()
    const cancelStarted = deferred<void>()
    const cancelGate = deferred<void>()
    let cancelCalls = 0
    const body = new ReadableStream<Uint8Array>({
      pull() {
        reading.resolve()
      },
      cancel() {
        cancelCalls += 1
        cancelStarted.resolve()
        return cancelGate.promise
      },
    })
    const client = await clientWith(async () => new Response(body, { status: 200 }))
    const state = track(client.chatStream(REQUEST, undefined, {
      connectTimeoutMs: 100,
      loadTimeoutMs: 20,
      streamIdleTimeoutMs: 20,
    }).next())
    await reading.promise
    await cancelStarted.promise

    assert.equal(cancelCalls, 1, 'the deadline must request reader cancel before awaiting the read')
    assert.equal(state.isSettled(), false, 'the deadline must await the cancel acknowledgment')
    assert.equal(body.locked, true, 'the reader lock stays owned while cancellation settles')

    cancelGate.resolve()
    await assert.rejects(
      state.tracked,
      (error) => error instanceof OllamaTimeoutError && error.phase === 'load',
    )
    assert.equal(cancelCalls, 1)
  })

  it('consumes a rejected late reader cancel and preserves the abort outcome', async () => {
    const reading = deferred<void>()
    const cancelStarted = deferred<void>()
    const cancelGate = deferred<void>()
    let cancelCalls = 0
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const body = new ReadableStream<Uint8Array>({
        pull() {
          reading.resolve()
        },
        cancel() {
          cancelCalls += 1
          cancelStarted.resolve()
          return cancelGate.promise
        },
      })
      const client = await clientWith(async () => new Response(body, { status: 200 }))
      const controller = new AbortController()
      const state = track(client.chatStream(REQUEST, controller.signal).next())
      await reading.promise
      controller.abort('fixture stop')
      await cancelStarted.promise
      assert.equal(state.isSettled(), false)

      cancelGate.reject(new Error('fixture late cancel failure'))
      await assert.rejects(state.tracked, abortError)
      await tick()
      await tick()
      assert.equal(cancelCalls, 1)
      assert.deepEqual(unhandled, [])
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
    }
  })

  it('decodes a BOM-prefixed non-stream body split inside UTF-8 sequences without a size ceiling', async () => {
    const content = `héllo 🚀 ${'x'.repeat(96 * 1024)}`
    const payload = JSON.stringify({
      model: 'fixture',
      created_at: '2026-08-02T12:00:00.000Z',
      message: { role: 'assistant', content },
      done: true,
    })
    const encoder = new TextEncoder()
    const bytes = encoder.encode(`\uFEFF${payload}`)
    const rocket = encoder.encode('🚀')
    let rocketAt = -1
    for (let index = 0; index + rocket.length <= bytes.length; index += 1) {
      if (rocket.every((byte, offset) => bytes[index + offset] === byte)) {
        rocketAt = index
        break
      }
    }
    assert.notEqual(rocketAt, -1, 'the fixture contains a split-blocking multibyte sequence')
    const splitAt = rocketAt + 2
    let reads = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads === 0) {
          reads += 1
          controller.enqueue(bytes.slice(0, splitAt))
          return
        }
        controller.enqueue(bytes.slice(splitAt))
        controller.close()
      },
    })
    const client = await ollamaClientThroughKernel({
      host: 'http://fixture.invalid',
      connectTimeoutMs: 500,
      loadTimeoutMs: 500,
      fetch: async (input) => {
        if (new URL(String(input)).pathname === '/api/version') {
          return Response.json({ version: 'fixture' })
        }
        return new Response(body, { status: 200 })
      },
    })

    const result = await client.chat(REQUEST)
    assert.equal(result.message?.content, content)
    assert.equal(result.message?.content?.length, content.length)
  })

  it('maps empty and invalid non-stream bodies to the existing protocol error', async () => {
    for (const invalid of [
      new Response(null, { status: 200 }),
      new Response('{not json', { status: 200 }),
    ]) {
      const client = await clientWith(async (input) => {
        if (new URL(String(input)).pathname === '/api/version') {
          return Response.json({ version: 'fixture' })
        }
        return invalid
      })
      await assert.rejects(
        client.chat(REQUEST),
        (error) => error instanceof OllamaProtocolError && error.endpoint === '/api/chat',
      )
    }
  })

  it('maps a non-stream body read failure to the existing body error', async () => {
    const client = await clientWith(async (input) => {
      if (new URL(String(input)).pathname === '/api/version') {
        return Response.json({ version: 'fixture' })
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('fixture body failure'))
        },
      }), { status: 200 })
    })

    await assert.rejects(
      client.chat(REQUEST),
      (error) =>
        error instanceof OllamaError
        && !(error instanceof OllamaProtocolError)
        && error.status === 200
        && /Ollama response body failed/u.test(error.message),
    )
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
