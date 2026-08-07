import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { openDb } from '../packages/server/src/store/db.ts'
import {
  ModelCapabilityOverrideStore,
  exactCapabilityOverrides,
  modelCapabilityOverrideKey,
} from '../packages/server/src/store/capability-override.ts'
import { ModelCapabilityOverrideService } from '../packages/server/src/models/capability-override.ts'

const AT = '2026-08-07T00:00:00.000Z'
const ID = {
  provider: 'ollama' as const,
  normalizedModelReference: 'fixture:latest',
  artifactDigest: 'sha256:fixture',
  runtimeVersion: '0.12.6',
}

async function db() {
  const root = await mkdtemp(join(tmpdir(), 'alamo-probe-'))
  return openDb(join(root, 'alamo.db'))
}

describe('store probes', () => {
  it('P1: store accepts a NON-canonical reference (uppercase) and creates an unreachable second row', async () => {
    const d = await db()
    const s = new ModelCapabilityOverrideStore(d)
    s.write({ identity: ID, capability: 'tools', now: AT })
    // Same logical model, non-canonical casing. Store does not normalize.
    s.write({ identity: { ...ID, normalizedModelReference: 'Fixture:Latest' }, capability: 'tools', now: AT })
    const n = (d.prepare('SELECT COUNT(*) AS c FROM model_capability_user_overrides').get() as any).c
    console.log('P1 rows for the same logical model =', n)
    console.log('P1 canonical list =', s.list(ID).length, ' uppercase list =',
      s.list({ ...ID, normalizedModelReference: 'Fixture:Latest' }).length)
    // Also: unicode-equivalent reference (NFKC) is not folded by the store.
    s.write({ identity: { ...ID, normalizedModelReference: 'ﬁxture:latest' }, capability: 'tools', now: AT })
    console.log('P1 rows after NFKC-equivalent =',
      (d.prepare('SELECT COUNT(*) AS c FROM model_capability_user_overrides').get() as any).c)
    d.close()
  })

  it('P2: a corrupted override_key permanently blocks re-assert AND clear for the WHOLE identity', async () => {
    const d = await db()
    const s = new ModelCapabilityOverrideStore(d)
    s.write({ identity: ID, capability: 'tools', now: AT })
    s.write({ identity: ID, capability: 'vision', now: AT })
    // Corrupt only the `tools` key (all CHECKs still satisfied).
    d.prepare('UPDATE model_capability_user_overrides SET override_key = ? WHERE capability = ?')
      .run(`sha256:${'c'.repeat(64)}`, 'tools')

    const service = new ModelCapabilityOverrideService({
      models: (() => ({
        installedArtifacts: async () => [{ name: 'fixture:latest', digest: 'sha256:fixture' }],
        runtimeVersion: async () => '0.12.6',
      })) as any,
      store: s,
    })
    const body = { capability: 'tools' as const, expectedDigest: ID.artifactDigest, expectedRuntimeVersion: ID.runtimeVersion }

    const reassert = await service.apply('fixture:latest', body, new AbortController().signal)
    console.log('P2 re-assert tools =', JSON.stringify(reassert))
    const cleared = await service.clear('fixture:latest', body, new AbortController().signal)
    console.log('P2 clear tools =', JSON.stringify(cleared))
    console.log('P2 rows still present =',
      (d.prepare('SELECT COUNT(*) AS c FROM model_capability_user_overrides').get() as any).c)
    // The healthy `vision` assertion is now invisible and unmutable too.
    const visionBody = { ...body, capability: 'vision' as const }
    console.log('P2 vision apply =', JSON.stringify(await service.apply('fixture:latest', visionBody, new AbortController().signal)))
    console.log('P2 descriptor projection sees =', JSON.stringify(exactCapabilityOverrides(s, ID)))
    d.close()
  })

  it('P3: ON CONFLICT DO NOTHING vs UNIQUE tuple - which error surfaces', async () => {
    const d = await db()
    const s = new ModelCapabilityOverrideStore(d)
    s.write({ identity: ID, capability: 'tools', now: AT })
    d.prepare('UPDATE model_capability_user_overrides SET override_key = ?')
      .run(`sha256:${'d'.repeat(64)}`)
    try {
      s.write({ identity: ID, capability: 'tools', now: AT })
      console.log('P3 write SUCCEEDED (should not)')
    } catch (e) {
      console.log('P3 write threw:', (e as Error).message)
    }
    console.log('P3 rows =', (d.prepare('SELECT COUNT(*) AS c FROM model_capability_user_overrides').get() as any).c)
    d.close()
  })

  it('P4: is `read` ever able to return a different identity? key is a pure function - check preimage separators', async () => {
    // Ambiguity probe: JSON.stringify of an array is unambiguous, but check anyway.
    const a = modelCapabilityOverrideKey({ ...ID, normalizedModelReference: 'a:b', artifactDigest: 'c' }, 'tools')
    const b = modelCapabilityOverrideKey({ ...ID, normalizedModelReference: 'a', artifactDigest: 'b:c' }, 'tools')
    console.log('P4 distinct keys =', a !== b)
    const c1 = modelCapabilityOverrideKey({ ...ID, normalizedModelReference: 'a","b' }, 'tools')
    const c2 = modelCapabilityOverrideKey({ ...ID, normalizedModelReference: 'a', artifactDigest: 'b' }, 'tools')
    console.log('P4 injection-style distinct =', c1 !== c2)
  })

  it('P5: identity with inner whitespace / newline is accepted', async () => {
    const d = await db()
    const s = new ModelCapabilityOverrideStore(d)
    const weird = { ...ID, normalizedModelReference: 'fix ture:latest' }
    const r = s.write({ identity: weird, capability: 'tools', now: AT })
    console.log('P5 accepted inner-space reference =', JSON.stringify(r.identity.normalizedModelReference))
    const nl = { ...ID, artifactDigest: 'sha256:a\nb' }
    console.log('P5 accepted newline digest =', JSON.stringify(s.write({ identity: nl, capability: 'tools', now: AT }).identity.artifactDigest))
    d.close()
  })

  it('P6: non-ISO but datetime-parseable timestamps / offset timestamps', async () => {
    const d = await db()
    const s = new ModelCapabilityOverrideStore(d)
    try {
      const r = s.write({ identity: ID, capability: 'tools', now: '2026-08-07T00:00:00+02:00' })
      console.log('P6 offset timestamp ACCEPTED =', r.createdAt)
    } catch (e) {
      console.log('P6 offset timestamp rejected:', (e as Error).message.slice(0, 80))
    }
    d.close()
  })
})
