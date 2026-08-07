import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { openDb } from '../packages/server/src/store/db.ts'
import { ModelCapabilityOverrideStore } from '../packages/server/src/store/capability-override.ts'
import { ModelCapabilityOverrideService } from '../packages/server/src/models/capability-override.ts'

const AT = '2026-08-07T00:00:00.000Z'
const DIGEST = 'sha256:fixture'
const RUNTIME = '0.12.6'
const BODY = { capability: 'tools' as const, expectedDigest: DIGEST, expectedRuntimeVersion: RUNTIME }

async function db() {
  const root = await mkdtemp(join(tmpdir(), 'alamo-svc-'))
  return openDb(join(root, 'alamo.db'))
}
const rows = (d: any) => (d.prepare('SELECT COUNT(*) AS c FROM model_capability_user_overrides').get() as any).c

function svc(d: any, o: any = {}) {
  const store = o.store ?? new ModelCapabilityOverrideStore(d)
  return {
    store,
    service: new ModelCapabilityOverrideService({
      models: (() => ({
        installedArtifacts: o.tags ?? (async () => [{ name: 'fixture:latest', digest: DIGEST }]),
        runtimeVersion: o.version ?? (async () => RUNTIME),
      })) as any,
      store,
      ...(o.now ? { now: o.now } : {}),
    }),
  }
}

describe('service probes', () => {
  it('S1: abort raised AFTER both observations resolve but BEFORE persist -> does it still write?', async () => {
    const d = await db()
    const c = new AbortController()
    // version() resolves last and aborts as its very last act, after which
    // Promise.all settles and the code path reaches signal.throwIfAborted().
    const { service } = svc(d, { version: async () => { c.abort('late'); return RUNTIME } })
    let threw = false
    try { await service.apply('fixture:latest', BODY, c.signal) } catch { threw = true }
    console.log('S1 threw =', threw, 'rows =', rows(d))
    d.close()
  })

  it('S2: signal that aborts only DURING the store.write call', async () => {
    const d = await db()
    const c = new AbortController()
    const real = new ModelCapabilityOverrideStore(d)
    const store = {
      list: (i: any) => real.list(i),
      write: (i: any) => { c.abort('during-write'); return real.write(i) },
      clear: (i: any) => real.clear(i),
    }
    const { service } = svc(d, { store })
    const out = await service.apply('fixture:latest', BODY, c.signal).catch((e) => ({ threw: String(e) }))
    console.log('S2 outcome =', JSON.stringify(out), 'rows =', rows(d))
    d.close()
  })

  it('S3: write succeeds but list() then fails -> row persisted, outcome says persistence_failed', async () => {
    const d = await db()
    const real = new ModelCapabilityOverrideStore(d)
    const store = {
      list: () => { throw new Error('SQLITE_IOERR readback') },
      write: (i: any) => real.write(i),
      clear: (i: any) => real.clear(i),
    }
    const { service } = svc(d, { store })
    const out = await service.apply('fixture:latest', BODY, new AbortController().signal)
    console.log('S3 outcome =', JSON.stringify(out))
    console.log('S3 rows actually written =', rows(d), '<-- side effect happened but caller told nothing applied')
    d.close()
  })

  it('S4: clear removes the row but list() fails -> reported as persistence_failed although removed', async () => {
    const d = await db()
    const real = new ModelCapabilityOverrideStore(d)
    real.write({ identity: { provider: 'ollama', normalizedModelReference: 'fixture:latest', artifactDigest: DIGEST, runtimeVersion: RUNTIME }, capability: 'tools', now: AT })
    let listCalls = 0
    const store = {
      list: (i: any) => { listCalls += 1; throw new Error('boom') },
      write: (i: any) => real.write(i),
      clear: (i: any) => real.clear(i),
    }
    const { service } = svc(d, { store })
    const out = await service.clear('fixture:latest', BODY, new AbortController().signal)
    console.log('S4 outcome =', JSON.stringify(out), 'rows =', rows(d), '<-- deleted yet reported as conflict')
    d.close()
  })

  it('S5: runtime version with surrounding whitespace -> service trims, store key differs from descriptor read', async () => {
    const d = await db()
    const { service, store } = svc(d, { version: async () => `  ${RUNTIME}  ` })
    const out = await service.apply('fixture:latest', { ...BODY, expectedRuntimeVersion: RUNTIME }, new AbortController().signal)
    console.log('S5 outcome state =', (out as any).state, 'identity =', JSON.stringify((out as any).identity))
    d.close()
  })

  it('S6: expectedDigest with whitespace from a client', async () => {
    const d = await db()
    const { service } = svc(d, { tags: async () => [{ name: 'fixture:latest', digest: `  ${DIGEST}  ` }] })
    const out = await service.apply('fixture:latest', { ...BODY, expectedDigest: `  ${DIGEST}  ` }, new AbortController().signal)
    console.log('S6 outcome =', JSON.stringify(out))
    d.close()
  })

  it('S7: does a conflict ever carry non-empty overrides / non-null identity at runtime?', async () => {
    const d = await db()
    const cases: any[] = [
      { label: 'invalid ref', name: '/bad' },
      { label: 'not installed', name: 'nope', tags: async () => [] },
    ]
    for (const c of cases) {
      const { service } = svc(d, c.tags ? { tags: c.tags } : {})
      const out: any = await service.apply(c.name, BODY, new AbortController().signal)
      console.log('S7', c.label, 'identity=', out.identity, 'overrides=', JSON.stringify(out.overrides))
    }
    d.close()
  })
})
