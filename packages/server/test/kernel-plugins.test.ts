/**
 * K1 wiring: the legacy Resource Governor and Ollama adapter run as kernel
 * plugins, the server boots them through a kernel profile, and unloading a
 * plugin reclaims what it owns.
 */
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createKernel } from '@guanxi/kernel'
import { processResources } from '@guanxi/kernel/node'
import { start } from '../src/index.ts'
import { OllamaUnavailableError } from '../src/ollama/client.ts'
import { OLLAMA_ADAPTER_SERVICE, ollamaAdapterPlugin, type OllamaAdapter } from '../src/ollama/plugin.ts'
import { RESOURCE_GOVERNOR_SERVICE, resourceGovernorPlugin } from '../src/runtime/governor-plugin.ts'
import { LEGACY_SERVER_PROFILE, bootServerKernel } from '../src/runtime/kernel.ts'
import { ResourceGovernor, ResourceGovernorError, type AdmissionRequest } from '../src/runtime/resource-governor.ts'
import { governorThroughKernel, kernelOf, ollamaClientThroughKernel } from './fixtures/kernel.ts'

function request(owner: string): AdmissionRequest {
  return {
    owner: { kind: 'operation', operationId: owner },
    operation: 'model_warm',
    model: { provider: 'ollama', name: 'fixture' },
    requestedContext: 4_096,
    priority: 'normal',
    enqueuedAt: '2026-10-20T10:00:00.000Z',
  }
}

const stalled: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  })

describe('legacy tests run through the facade', () => {
  it('hands out the services the plugins provide', async () => {
    const governor = await governorThroughKernel()
    assert.ok(governor instanceof ResourceGovernor)
    const governorKernel = kernelOf(governor)
    assert.ok(governorKernel, 'the governor came from a kernel')
    assert.equal(governorKernel.service(RESOURCE_GOVERNOR_SERVICE), governor)

    const client = await ollamaClientThroughKernel({ host: 'http://fixture.invalid/' })
    const clientKernel = kernelOf(client)
    assert.ok(clientKernel, 'the client came from a kernel')
    assert.equal(clientKernel.service<OllamaAdapter>(OLLAMA_ADAPTER_SERVICE)!.client('http://fixture.invalid'), client)
  })
})

describe('Resource Governor plugin', () => {
  it('closes the governor on unload and finishes only after the active lease is released', async () => {
    const kernel = createKernel()
    const handle = await kernel.plugin(resourceGovernorPlugin)
    const governor = kernel.service<ResourceGovernor>(RESOURCE_GOVERNOR_SERVICE)!
    const owner = new AbortController()
    const lease = await governor.acquire(governor.enqueue(request('active')), {
      abortOwner: () => owner.abort('shutdown'),
    })
    const waiting = governor.acquire(governor.enqueue(request('waiting')))
    let unloaded = false
    const unloading = handle.dispose().then(() => {
      unloaded = true
    })
    await assert.rejects(waiting, (error: unknown) => error instanceof ResourceGovernorError && error.code === 'admission_closed')
    assert.equal(owner.signal.aborted, true, 'the active owner was asked to stop')
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(unloaded, false, 'unload waits for the active lease')
    lease.release()
    await unloading
    assert.equal(governor.snapshot().accepting, false)
    assert.equal(kernel.service(RESOURCE_GOVERNOR_SERVICE), undefined)
  })
})

describe('Ollama adapter plugin', () => {
  it('keeps one client per host and replaces it when the host changes', async () => {
    const kernel = createKernel()
    await kernel.plugin(ollamaAdapterPlugin, { fetch: stalled })
    const adapter = kernel.service<OllamaAdapter>(OLLAMA_ADAPTER_SERVICE)!
    const first = adapter.client('http://a.invalid/')
    assert.equal(adapter.client('http://a.invalid'), first)
    assert.notEqual(adapter.client('http://b.invalid'), first)
  })

  it('aborts in-flight requests on unload and fails stale clients fast', async () => {
    const kernel = createKernel()
    const before = processResources().timers
    const handle = await kernel.plugin(ollamaAdapterPlugin, { fetch: stalled, connectTimeoutMs: 60_000 })
    const client = kernel.service<OllamaAdapter>(OLLAMA_ADAPTER_SERVICE)!.client('http://fixture.invalid')
    const inFlight = client.ps()
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(processResources().timers, before + 1, 'the connect deadline is armed')
    await handle.dispose()
    await assert.rejects(inFlight, OllamaUnavailableError)
    assert.equal(processResources().timers, before, 'no deadline outlives the plugin')
    const startedAt = Date.now()
    await assert.rejects(client.version(), OllamaUnavailableError)
    assert.ok(Date.now() - startedAt < 1_000, 'a stale client fails without waiting for a deadline')
  })
})

describe('server boot through the kernel', () => {
  it('boots the legacy profile and gives the application context its services', async () => {
    const kernel = await bootServerKernel()
    try {
      assert.deepEqual(kernel.node.entries().map((entry) => entry.id), ['resource-governor', 'ollama', 'egress-scrubber'])
      assert.equal(kernel.node.stateOf('resource-governor'), 'active')
      assert.equal(kernel.node.stateOf('ollama'), 'active')
      assert.equal(kernel.node.service(RESOURCE_GOVERNOR_SERVICE), kernel.governor)
    } finally {
      await kernel.node.dispose()
    }
    assert.equal(kernel.governor.snapshot().accepting, false, 'disposing the node closed the governor')
  })

  it('pins the rows whose services the legacy context holds', async () => {
    const kernel = await bootServerKernel()
    try {
      await assert.rejects(
        kernel.node.apply([LEGACY_SERVER_PROFILE, { name: 'user', patch: [{ id: 'resource-governor', disabled: true }] }]),
        /row "resource-governor" is pinned/,
      )
      await assert.rejects(kernel.node.replacePlugin(resourceGovernorPlugin), /pinned/)
      assert.equal(kernel.node.stateOf('resource-governor'), 'active')
      assert.equal(kernel.node.service(RESOURCE_GOVERNOR_SERVICE), kernel.governor)
    } finally {
      await kernel.node.dispose()
    }
    assert.equal(LEGACY_SERVER_PROFILE.insert?.length, 3)
  })

  it('start() wires context.governor and context.ollama() to the kernel services', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'guanxi-k1-start-'))
    try {
      const server = await start({ port: 0, host: '127.0.0.1', dataDir, webDir: dataDir, devOrigins: [] })
      try {
        const health = (host: string, path = '/api/health') => new Promise<number>((resolve, reject) => {
          const req = httpRequest({ hostname: '127.0.0.1', port: server.port, path,
            headers: { Host: host } }, res => {
            res.resume(); res.on('end', () => resolve(res.statusCode!))
          })
          req.on('error', reject); req.end()
        })
        assert.notEqual(server.port, 0)
        assert.equal(await health(`127.0.0.1:${server.port}`), 200)
        assert.equal(await health(`localhost:${server.port}`), 200)
        assert.equal(await health(`evil.example:${server.port}`), 403)
        assert.equal(server.context.governor, server.kernel.governor)
        const host = server.context.settings.get().ollamaHost
        assert.equal(server.context.ollama(), server.kernel.ollama.client(host.startsWith('http') ? host : `http://${host}`))
        assert.equal(server.kernel.node.counters().fibers, 8, 'governor, Ollama, scrubber, session log, durable runs, connections, native agent and relay')
        assert.equal(server.kernel.node.counters().services, 10, 'kernel slots, governor, Ollama, egress, session log, durable runs, readiness, registry, native agent and relay')
        assert.ok(server.kernel.node.service('connections.registry'))
        assert.ok(server.kernel.node.service('agent.native'))
        assert.ok(server.kernel.node.service('agent.relay'))
        assert.ok(server.kernel.node.service('runs.durable'))
        assert.equal(server.kernel.node.service('connections.vault'), undefined)
        assert.ok(server.kernel.node.service('egress.scrubber'))
        // Exercise index.ts's mounted resolver after its service disappears.
        assert.ok(server.kernel.sessionLog, 'the kernel loaded the session log')
        assert.equal(server.context.sessionLog, server.kernel.sessionLog, 'the context uses the kernel session log')
        const sessions = await fetch(`${server.url}/api/sessions`)
        assert.equal(sessions.status, 200, 'K2 routes remain mounted in the real listener')
        assert.deepEqual(await sessions.json(), { sessions: [], withheld: 0, catchingUp: 0, catchUpFailed: 0 })
        assert.equal(await health(`evil.example:${server.port}`, '/api/sessions'), 403, 'the Host boundary also protects K2 routes')
        const modelsUrl = `${server.url}/api/connections/11111111-1111-4111-8111-111111111111/models`
        const initial = await fetch(modelsUrl)
        assert.equal(initial.status, 404)
        assert.deepEqual(await initial.json(), { code: 'connection_not_found' })
        await server.kernel.node.dispose()
        const unavailable = await fetch(modelsUrl)
        assert.equal(unavailable.status, 503)
        assert.deepEqual(await unavailable.json(), { code: 'egress_unavailable' })
      } finally {
        await server.close()
      }
      assert.equal(server.kernel.node.counters().fibers, 0, 'close() unloaded the kernel')
      assert.equal(server.context.governor.snapshot().accepting, false)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
