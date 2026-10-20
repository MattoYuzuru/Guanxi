/**
 * K1 exit gate (ADR-0015 validation 2): 100 unload/reload cycles of the legacy
 * Resource Governor and Ollama adapter plugins under synthetic load leave zero
 * leaked listeners, timers, handles and slot entries, and heap growth after
 * forced GC stays ≤ 5% of the first cycle.
 *
 * Variant A reloads the same plugin code through profile reconciliation (the
 * node disables and re-enables the provider rows). Variant B replaces plugin code
 * by importing a fresh module record per cycle; those records cannot be freed by
 * Node, so they are counted and their cost reported instead of being held to the
 * 5% bound.
 */
import assert from 'node:assert/strict'
import { getHeapSpaceStatistics, setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { after, before, describe, it } from 'node:test'
import {
  contribute,
  declareSlot,
  definePlugin,
  interval,
  on,
  service,
  type KernelCounters,
  type ProfileLayer,
} from '@guanxi/kernel'
import { bootNode, processResources, type NodeKernel, type ProcessResources } from '@guanxi/kernel/node'
import { ollamaAdapterPlugin, type OllamaAdapter } from '../src/ollama/plugin.ts'
import { resourceGovernorPlugin } from '../src/runtime/governor-plugin.ts'
import type { AdmissionRequest, ResourceGovernor } from '../src/runtime/resource-governor.ts'

setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc') as () => void

const CYCLES = 100
const HEAP_GROWTH_LIMIT = 0.05
const SLOT = 'sidebar.items'

interface HeapSample {
  /** `heapUsed`: every V8 space. */
  readonly total: number
  /** Compiled code and bytecode/feedback metadata (code and trusted spaces). */
  readonly code: number
  /** `total - code`: the objects the program retains. The 5% gate applies here. */
  readonly objects: number
}

const CODE_SPACES = new Set(['code_space', 'code_large_object_space', 'trusted_space', 'trusted_large_object_space'])

/**
 * Heap after forced full GCs. Each GC is followed by an event-loop turn so
 * FinalizationRegistry callbacks (undici bodies, AbortSignal.any) can run and
 * release what they hold; a tight `gc()` loop reports their pending cells as
 * growth proportional to the cycles since the last major GC.
 *
 * V8 keeps compiling hot functions for many cycles (code space grows as
 * functions tier up), which is not retained program state. The gate therefore
 * bounds the object heap and reports the total next to it.
 */
async function forcedHeap(): Promise<HeapSample> {
  for (let round = 0; round < 6; round += 1) {
    gc()
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  const spaces = getHeapSpaceStatistics()
  const total = spaces.reduce((sum, space) => sum + space.space_used_size, 0)
  const code = spaces
    .filter((space) => CODE_SPACES.has(space.space_name))
    .reduce((sum, space) => sum + space.space_used_size, 0)
  return { total, code, objects: total - code }
}

function growth(first: HeapSample, last: HeapSample) {
  const percent = (from: number, to: number) => Number((((to - from) / from) * 100).toFixed(2))
  return {
    objectsPercent: percent(first.objects, last.objects),
    totalPercent: percent(first.total, last.total),
    codeBytes: last.code - first.code,
    objectBytes: last.objects - first.objects,
  }
}

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

/** Ollama transport double: `/api/version` answers, `/api/chat` stalls until aborted. */
const fakeOllama: typeof fetch = async (input, init) => {
  if (String(input).endsWith('/api/version')) {
    return new Response(JSON.stringify({ version: '0.0.0-fixture' }), { status: 200 })
  }
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

const shellPlugin = definePlugin({
  manifest: {
    id: 'fixture.shell',
    engines: { guanxi: '^0.1.0' },
    contributes: { slotDeclarations: [SLOT] },
    trust: 'T0',
  },
  apply(ctx) {
    declareSlot(ctx, SLOT)
  },
})

interface LoadProbe {
  ready: Promise<void>
  resolve: () => void
  inFlight: Array<Promise<unknown>>
}

let probe: LoadProbe
/** One weak reference per plugin instance; every one but the live one must be collected. */
const instances: Array<WeakRef<object>> = []
;(globalThis as { __k1Instances?: Array<WeakRef<object>> }).__k1Instances = instances

function collectedExceptLast(): { total: number; alive: number } {
  const alive = instances.slice(0, -1).filter((ref) => ref.deref() !== undefined).length
  return { total: instances.length, alive }
}
function nextProbe(): LoadProbe {
  let resolve!: () => void
  const ready = new Promise<void>((done) => {
    resolve = done
  })
  probe = { ready, resolve, inFlight: [] }
  return probe
}

/**
 * Synthetic load. It deliberately does not release its lease or abort its
 * requests on unload: the providers' own unload must reclaim them.
 */
const loadPlugin = definePlugin({
  manifest: {
    id: 'fixture.load',
    engines: { guanxi: '^0.1.0' },
    requires: ['governor', 'ollama'],
    contributes: { slots: [SLOT] },
    trust: 'T0',
  },
  async apply(ctx) {
    const governor = service<ResourceGovernor>(ctx, 'governor')
    const ollama = service<OllamaAdapter>(ctx, 'ollama')
    instances.push(new WeakRef(governor))
    on(ctx, 'fixture/tick', () => governor.snapshot())
    interval(ctx, () => governor.snapshot(), 60_000)
    contribute(ctx, SLOT, { id: 'load', value: { label: 'load' } })

    const owner = new AbortController()
    const lease = await governor.acquire(governor.enqueue(request('active')), {
      signal: owner.signal,
      abortOwner: () => owner.abort('shutdown'),
    })
    owner.signal.addEventListener('abort', () => lease.release(), { once: true })
    for (let index = 0; index < 3; index += 1) {
      const waiter = new AbortController()
      probe.inFlight.push(
        governor
          .acquire(governor.enqueue(request(`waiter-${index}`)), {
            signal: waiter.signal,
            abortOwner: () => waiter.abort('shutdown'),
          })
          .catch((error: unknown) => error),
      )
    }
    const client = ollama.client('http://fixture.invalid')
    probe.inFlight.push(
      client.chat({ model: 'fixture', messages: [{ role: 'user', content: 'hi' }] }).catch((error: unknown) => error),
    )
    await client.version()
    probe.resolve()
  },
})

const PLUGINS = [shellPlugin, resourceGovernorPlugin, ollamaAdapterPlugin, loadPlugin]

function profile(providersEnabled: boolean): ProfileLayer[] {
  return [{
    name: 'profile:k1-reload',
    insert: [
      { id: 'shell', plugin: 'fixture.shell' },
      { id: 'governor', plugin: 'guanxi.resource-governor', disabled: !providersEnabled },
      {
        id: 'ollama',
        plugin: 'guanxi.ollama-adapter',
        config: { connectTimeoutMs: 60_000, loadTimeoutMs: 60_000, streamIdleTimeoutMs: 60_000 },
        disabled: !providersEnabled,
      },
      { id: 'load', plugin: 'fixture.load' },
    ],
  }]
}

interface Census {
  readonly kernel: KernelCounters
  readonly process: ProcessResources
}

function census(node: NodeKernel): Census {
  return { kernel: node.counters(), process: processResources() }
}

describe('K1 reload cycles under load', () => {
  const realFetch = globalThis.fetch
  before(() => {
    globalThis.fetch = fakeOllama
  })
  after(() => {
    globalThis.fetch = realFetch
  })

  it(`variant A: ${CYCLES} provider unload/reload cycles leak nothing and grow the heap ≤ 5%`, async () => {
    const logs: string[] = []
    nextProbe()
    const node = await bootNode({ plugins: PLUGINS, profile: profile(true), onLog: (record) => logs.push(record.message) })
    await probe.ready

    try {
      let loaded: Census | undefined
      let unloaded: Census | undefined
      let firstHeap: HeapSample | undefined
      let lastHeap: HeapSample | undefined
      let reclaimed = 0
      for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
        const current = probe
        assert.equal(node.slots.list(SLOT).length, 1, `cycle ${cycle}: one load entry while loaded`)
        const loadedNow = census(node)
        if (loaded) assert.deepEqual(loadedNow, loaded, `cycle ${cycle}: loaded census drifted`)
        else loaded = loadedNow

        nextProbe()
        await node.apply(profile(false))
        // Count and drop the rejections: an unformatted error's captured stack
        // keeps its call receivers (the old governor) alive.
        reclaimed += (await Promise.all(current.inFlight)).filter((outcome) => outcome instanceof Error).length
        current.inFlight.length = 0
        assert.equal(node.slots.list(SLOT).length, 0, `cycle ${cycle}: entry removed on unload`)

        const unloadedNow = census(node)
        if (unloaded) assert.deepEqual(unloadedNow, unloaded, `cycle ${cycle}: unloaded census drifted`)
        else unloaded = unloadedNow
        if (cycle === 1) firstHeap = await forcedHeap()
        if (cycle === CYCLES) lastHeap = await forcedHeap()

        await node.apply(profile(true))
        await probe.ready
      }

      instances.splice(0, instances.length - (CYCLES + 1))
      await forcedHeap()
      const governors = collectedExceptLast()
      assert.equal(governors.total, CYCLES + 1)
      assert.equal(governors.alive, 0, `${governors.alive} unloaded governor instances are still reachable`)

      const heap = growth(firstHeap!, lastHeap!)
      console.log(`variant A: ${JSON.stringify({ cycles: CYCLES, firstHeap, lastHeap, heap, reclaimedInFlight: reclaimed, unloaded, loaded })}`)
      assert.equal(reclaimed, CYCLES * 4, 'every waiter and stalled request ended when its provider unloaded')
      assert.equal(unloaded!.kernel.slotEntries, 0)
      assert.equal(unloaded!.kernel.slotOrphans, 0)
      assert.equal(unloaded!.process.timers, loaded!.process.timers - 2, 'the interval and the stalled request deadline are gone')
      assert.ok(heap.objectsPercent <= HEAP_GROWTH_LIMIT * 100, `object heap grew ${heap.objectsPercent}% (> 5%)`)
      assert.deepEqual(logs, [], 'no plugin error or warning during the cycles')
    } finally {
      await node.dispose()
    }
    assert.equal(node.counters().fibers, 0)
    assert.equal(node.counters().slotEntries, 0)
  })

  it(`variant B: ${CYCLES} code replacements leak nothing but one module record each`, async () => {
    instances.length = 0
    const versions: string[] = []
    const importVersion = async (version: number) => {
      const module = await import(`./fixtures/reloadable-plugin.ts?v=${version}`)
      versions.push(module.loadedAt)
      return module.plugin
    }
    const node = await bootNode({
      plugins: [shellPlugin, resourceGovernorPlugin, await importVersion(0)],
      profile: [{
        name: 'profile:k1-code-reload',
        insert: [
          { id: 'shell', plugin: 'fixture.shell' },
          { id: 'governor', plugin: 'guanxi.resource-governor' },
          { id: 'reloadable', plugin: 'fixture.reloadable' },
        ],
      }],
    })
    try {
      const baseline = census(node)
      const firstHeap = await forcedHeap()
      for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
        await node.replacePlugin(await importVersion(cycle))
        const entries = node.slots.list<{ version: string }>(SLOT)
        assert.deepEqual(entries.map((entry) => entry.value.version), [String(cycle)], `cycle ${cycle}: one current entry`)
        assert.deepEqual(census(node), baseline, `cycle ${cycle}: census drifted`)
      }
      const lastHeap = await forcedHeap()
      const contexts = collectedExceptLast()
      assert.equal(contexts.total, CYCLES + 1)
      assert.equal(contexts.alive, 0, `${contexts.alive} replaced plugin contexts are still reachable`)
      // Node exposes no module-record counter: each distinct import URL is one
      // record that stays for the life of the process.
      const moduleRecords = new Set(versions).size
      const heap = growth(firstHeap, lastHeap)
      const bytesPerRecord = Math.round((lastHeap.total - firstHeap.total) / CYCLES)
      console.log(`variant B: ${JSON.stringify({ cycles: CYCLES, moduleRecords, firstHeap, lastHeap, heap, bytesPerModuleRecord: bytesPerRecord })}`)
      assert.equal(moduleRecords, CYCLES + 1, 'one non-freeable module record per import')
      // A retained kernel context or plugin instance per cycle would cost far
      // more than one small module record; this bound catches that.
      assert.ok(bytesPerRecord <= 32 * 1024, `${bytesPerRecord} B retained per reload`)
    } finally {
      await node.dispose()
    }
  })
})
