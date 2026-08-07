import { describe, it } from 'node:test'
import { Hono } from 'hono'
import type { AppContext } from '../packages/server/src/context.ts'
import { modelsRoutes } from '../packages/server/src/http/models-routes.ts'

const BODY = { capability: 'tools', expectedDigest: 'sha256:fixture', expectedRuntimeVersion: '0.12.6' }
const APPLIED = {
  state: 'applied', capability: 'tools',
  identity: { provider: 'ollama', normalizedModelReference: 'x', artifactDigest: 'sha256:fixture', runtimeVersion: '0.12.6' },
  overrides: [],
}

function appWith(seen: any[]) {
  const app = new Hono()
  app.route('/api/models', modelsRoutes({
    capabilityOverrides: {
      apply: async (name: string) => { seen.push({ op: 'apply', name }); return APPLIED as any },
      clear: async (name: string) => { seen.push({ op: 'clear', name }); return { ...APPLIED, state: 'cleared' } as any },
    },
    models: () => ({ detail: async (name: string) => { seen.push({ op: 'detail', name }); return null } }),
    ollama: () => ({ deleteModel: async (name: string) => { seen.push({ op: 'delete', name }) } }),
  } as unknown as AppContext))
  return app
}

describe('route probes', () => {
  it('unencoded namespaced slash', async () => {
    const seen: any[] = []
    const res = await appWith(seen).request(new Request(
      'http://l.test/api/models/library/qwen3:8b/capability-overrides',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(BODY) }))
    console.log('A unencoded-slash POST status=', res.status, 'seen=', JSON.stringify(seen))
  })

  it('encoded namespaced', async () => {
    const seen: any[] = []
    const url = `http://l.test/api/models/${encodeURIComponent('library/qwen3:8b')}/capability-overrides`
    const res = await appWith(seen).request(new Request(url,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(BODY) }))
    console.log('B encoded POST url=', url, 'status=', res.status, 'seen=', JSON.stringify(seen))
  })

  it('DELETE model named weird/capability-overrides encoded', async () => {
    const seen: any[] = []
    const url = `http://l.test/api/models/${encodeURIComponent('weird/capability-overrides')}`
    const res = await appWith(seen).request(new Request(url, { method: 'DELETE' }))
    console.log('C DELETE encoded status=', res.status, 'seen=', JSON.stringify(seen))
  })

  it('DELETE unencoded weird/capability-overrides no body', async () => {
    const seen: any[] = []
    const res = await appWith(seen).request(new Request(
      'http://l.test/api/models/weird/capability-overrides', { method: 'DELETE' }))
    console.log('D DELETE unencoded status=', res.status, 'seen=', JSON.stringify(seen), 'body=', await res.text())
  })

  it('GET on capability-overrides path falls into detail', async () => {
    const seen: any[] = []
    const res = await appWith(seen).request(new Request('http://l.test/api/models/fixture%3Alatest/capability-overrides'))
    console.log('E GET status=', res.status, 'seen=', JSON.stringify(seen))
  })

  it('double-encoded name', async () => {
    const seen: any[] = []
    const res = await appWith(seen).request(new Request(
      'http://l.test/api/models/fixture%253Alatest/capability-overrides',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(BODY) }))
    console.log('F double-encoded POST status=', res.status, 'seen=', JSON.stringify(seen))
  })

  it('malformed percent escape', async () => {
    const seen: any[] = []
    try {
      const res = await appWith(seen).request(new Request(
        'http://l.test/api/models/fix%ture/capability-overrides',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(BODY) }))
      console.log('G malformed POST status=', res.status, 'seen=', JSON.stringify(seen), 'body=', await res.text())
    } catch (e) {
      console.log('G malformed THREW', (e as Error).name, (e as Error).message)
    }
  })
})
