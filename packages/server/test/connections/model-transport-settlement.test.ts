import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConnectionError } from '../../src/connections/errors.ts'
import { Connections } from '../../src/connections/service.ts'
import { SecretScrubber } from '../../src/egress/scrubber.ts'
import { OllamaClient } from '../../src/ollama/client.ts'
import type { OllamaChatRequest } from '../../src/ollama/types.ts'
import { ResourceGovernor } from '../../src/runtime/resource-governor.ts'

const REQUEST: OllamaChatRequest = {
  model: 'fixture',
  messages: [{ role: 'user', content: 'fixture' }],
  options: { num_ctx: 1024 },
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
  // The assertions below attach later; consume the marker rejection meanwhile.
  tracked.catch(() => undefined)
  return { tracked, isSettled: () => settled }
}

function abortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function admission(requestId: string) {
  return {
    owner: { kind: 'operation' as const, operationId: requestId },
    operation: 'chat' as const,
    model: { provider: 'ollama' as const, name: 'fixture' },
    requestedContext: 1024,
    priority: 'normal' as const,
    enqueuedAt: new Date().toISOString(),
  }
}

function connectionsFixture(
  fetchImpl: typeof fetch,
  timeouts: { connectTimeoutMs?: number; loadTimeoutMs?: number } = {},
) {
  const governor = new ResourceGovernor()
  const scrubber = new SecretScrubber()
  const receipts: unknown[] = []
  const store = {
    get: (_accountId: string, _id: string) => ({ kind: 'local_runtime' as const, unattended: true }),
    record: (receipt: unknown) => {
      receipts.push(receipt)
    },
  }
  const vault = {
    unattendedAvailable: true,
    assertScrubbingReady: () => undefined,
  }
  const ollama = {
    client: (host: string) =>
      new OllamaClient({
        host,
        fetch: fetchImpl,
        connectTimeoutMs: timeouts.connectTimeoutMs ?? 500,
        loadTimeoutMs: timeouts.loadTimeoutMs ?? 500,
      }),
  }
  const connections = new Connections(
    store as never,
    vault as never,
    {} as never,
    scrubber,
    new AbortController().signal,
    ollama,
    governor,
    () => 'http://127.0.0.1:11434',
  )
  return {
    connections,
    governor,
    scrubber,
    receipts,
    async close() {
      await connections.close()
      await governor.close()
      scrubber.close()
    },
  }
}

test('aborted localChat model POST keeps the governor permit until the fetch settles', async (t) => {
  const entered = deferred<void>()
  const release = deferred<void>()
  let gets = 0
  let posts = 0
  let providerSignal: AbortSignal | undefined
  const fetchImpl: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname === '/api/version') {
      gets += 1
      return Response.json({ version: 'fixture' })
    }
    posts += 1
    providerSignal = init?.signal ?? undefined
    entered.resolve()
    await release.promise
    throw new Error('fixture late POST failure')
  }
  const f = connectionsFixture(fetchImpl)
  t.after(async () => {
    release.reject(new Error('fixture cleanup'))
    await f.close()
  })

  const controller = new AbortController()
  const call = f.connections.localChat('owner', 'local', REQUEST, {
    runId: 'run',
    requestId: 'post-ownership',
    background: true,
    signal: controller.signal,
  })
  const state = track(call)
  await entered.promise
  controller.abort('fixture explicit stop')
  await tick()

  assert.equal(gets, 1)
  assert.equal(posts, 1)
  assert.equal(providerSignal?.aborted, true)
  assert.equal(state.isSettled(), false, 'localChat must not settle before transport settlement')
  assert.notEqual(f.governor.snapshot().activeLease, null, 'the governor permit must remain held')

  release.reject(new Error('fixture late POST failure'))
  await assert.rejects(
    state.tracked,
    (error) =>
      error instanceof ConnectionError
      && error.code === 'provider_failed'
      && /cancelled/u.test(error.message),
  )
  assert.equal(f.governor.snapshot().activeLease, null)
  assert.equal(f.receipts.length, 0, 'an aborted call records no completed usage')

  const lease = await f.governor.acquire(f.governor.enqueue(admission('next-admission')))
  lease.release()
  assert.equal(f.governor.snapshot().activeLease, null)
})

test('a late model POST response body is disposed and acknowledged before localChat rejects', async (t) => {
  const entered = deferred<void>()
  const responseGate = deferred<void>()
  const cancelGate = deferred<void>()
  let posts = 0
  let cancelStarted = false
  let cancelAcknowledged = false
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelStarted = true
      return cancelGate.promise.then(() => {
        cancelAcknowledged = true
      })
    },
  })
  const fetchImpl: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname === '/api/version') {
      return Response.json({ version: 'fixture' })
    }
    posts += 1
    init?.signal?.addEventListener('abort', () => undefined, { once: true })
    entered.resolve()
    await responseGate.promise
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const f = connectionsFixture(fetchImpl)
  t.after(async () => {
    responseGate.resolve()
    cancelGate.resolve()
    await f.close()
  })

  const controller = new AbortController()
  const state = track(f.connections.localChat('owner', 'local', REQUEST, {
    runId: 'run',
    requestId: 'late-response',
    background: true,
    signal: controller.signal,
  }))
  await entered.promise
  controller.abort('fixture explicit stop')
  await tick()

  responseGate.resolve()
  await tick()
  assert.equal(posts, 1)
  assert.equal(cancelStarted, true, 'the late response body is disposed')
  assert.equal(cancelAcknowledged, false)
  assert.equal(state.isSettled(), false, 'body cleanup must be acknowledged before return')
  assert.notEqual(f.governor.snapshot().activeLease, null)

  cancelGate.resolve()
  await assert.rejects(state.tracked, (error) =>
    error instanceof ConnectionError && error.code === 'provider_failed')
  assert.equal(cancelAcknowledged, true)
  assert.equal(f.governor.snapshot().activeLease, null)
})

test('a model POST deadline holds ownership and stays a failure, not an external cancel', async (t) => {
  const entered = deferred<void>()
  const aborted = deferred<void>()
  const release = deferred<void>()
  let posts = 0
  const fetchImpl: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname === '/api/version') {
      return Response.json({ version: 'fixture' })
    }
    posts += 1
    init?.signal?.addEventListener('abort', () => aborted.resolve(), { once: true })
    entered.resolve()
    await release.promise
    throw new Error('fixture late timeout transport')
  }
  const f = connectionsFixture(fetchImpl, { connectTimeoutMs: 20, loadTimeoutMs: 20 })
  t.after(async () => {
    release.reject(new Error('fixture cleanup'))
    await f.close()
  })

  const state = track(f.connections.localChat('owner', 'local', REQUEST, {
    runId: 'run',
    requestId: 'deadline-ownership',
    background: true,
  }))
  await entered.promise
  await aborted.promise
  await tick()

  assert.equal(posts, 1)
  assert.equal(state.isSettled(), false, 'the deadline must wait for actual transport settlement')
  assert.notEqual(f.governor.snapshot().activeLease, null)

  release.reject(new Error('fixture late timeout transport'))
  await assert.rejects(state.tracked, (error) =>
    error instanceof ConnectionError
    && error.code === 'provider_failed'
    && /failed/u.test(error.message)
    && !/cancelled/u.test(error.message))
  assert.equal(f.governor.snapshot().activeLease, null)
})

test('a synchronous onStarted throw keeps transport ownership until the POST settles', async (t) => {
  const entered = deferred<void>()
  const aborted = deferred<void>()
  const release = deferred<void>()
  let posts = 0
  const fetchImpl: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname === '/api/version') {
      return Response.json({ version: 'fixture' })
    }
    posts += 1
    init?.signal?.addEventListener('abort', () => aborted.resolve(), { once: true })
    entered.resolve()
    await release.promise
    throw new Error('fixture late observer transport')
  }
  const f = connectionsFixture(fetchImpl)
  t.after(async () => {
    release.reject(new Error('fixture cleanup'))
    await f.close()
  })

  const state = track(f.connections.localChat('owner', 'local', REQUEST, {
    runId: 'run',
    requestId: 'observer-throw',
    background: true,
    onStarted: () => {
      throw new Error('fixture observer failure')
    },
  }))
  await entered.promise
  await aborted.promise
  await tick()

  assert.equal(posts, 1)
  assert.equal(state.isSettled(), false, 'an observer throw must not release the transport early')
  assert.notEqual(f.governor.snapshot().activeLease, null)

  release.reject(new Error('fixture late observer transport'))
  await assert.rejects(state.tracked, (error) =>
    error instanceof ConnectionError
    && error.code === 'provider_failed'
    && /cancelled/u.test(error.message)
    && !String(error.message).includes('fixture observer failure'))
  assert.equal(f.governor.snapshot().activeLease, null)
})

test('a late model POST rejection after abort produces no unhandled rejection', async (t) => {
  const entered = deferred<void>()
  const release = deferred<void>()
  const fetchImpl: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname === '/api/version') {
      return Response.json({ version: 'fixture' })
    }
    init?.signal?.addEventListener('abort', () => undefined, { once: true })
    entered.resolve()
    await release.promise
    throw new Error('fixture late unhandled candidate')
  }
  const f = connectionsFixture(fetchImpl)
  t.after(async () => {
    release.reject(new Error('fixture cleanup'))
    await f.close()
  })

  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    const controller = new AbortController()
    const state = track(f.connections.localChat('owner', 'local', REQUEST, {
      runId: 'run',
      requestId: 'late-rejection',
      background: true,
      signal: controller.signal,
    }))
    await entered.promise
    controller.abort('fixture explicit stop')
    await tick()
    release.reject(new Error('fixture late unhandled candidate'))
    await assert.rejects(state.tracked, (error) =>
      error instanceof ConnectionError && error.code === 'provider_failed')
    await tick()
    await tick()
    assert.deepEqual(unhandled, [])
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }
})

test('a cancel-driven model stream keeps the caller lease until its cancel is acknowledged', async (t) => {
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
  const client = new OllamaClient({
    host: 'http://127.0.0.1:11434',
    fetch: async () => new Response(body, { status: 200 }),
    connectTimeoutMs: 500,
    loadTimeoutMs: 500,
  })
  const governor = new ResourceGovernor()
  t.after(async () => {
    cancelGate.resolve()
    await governor.close()
  })
  const lease = await governor.acquire(governor.enqueue(admission('stream-cancel-lease')))
  let releases = 0
  const controller = new AbortController()
  const state = track((async () => {
    try {
      return await client.chatStream(REQUEST, controller.signal).next()
    } finally {
      releases += 1
      lease.release()
    }
  })())
  await reading.promise
  controller.abort('fixture stop')
  await cancelStarted.promise

  assert.equal(cancelCalls, 1)
  assert.equal(state.isSettled(), false, 'the call must stay owned until cancel acknowledgement')
  assert.notEqual(governor.snapshot().activeLease, null, 'the caller lease must remain held')

  cancelGate.resolve()
  await assert.rejects(state.tracked, abortError)
  assert.equal(releases, 1, 'the caller must release the lease exactly once')
  assert.equal(governor.snapshot().activeLease, null)
})
