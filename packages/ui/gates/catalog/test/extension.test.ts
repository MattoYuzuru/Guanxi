/**
 * The DS1-a extension registrations (gates/extensions/catalog.gate.ts) under a context that
 * follows packages/ui/gates/README.md: files overlaid through `read`, seeds as JSON overlays.
 * Fast registrations pass on the checkout and fail every seed with its expected diagnostic.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, it } from 'node:test'
import registrations from '../../extensions/catalog.gate.ts'

const root = resolve(import.meta.dirname, '..', '..', '..', '..', '..')

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', 'build', 'test-results', '.git'].includes(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(relative(root, full).split('\\').join('/'))
  }
}

function context(overrides: Record<string, string> = {}) {
  const files: string[] = []
  walk(join(root, 'packages', 'web'), files)
  walk(join(root, 'packages', 'ui'), files)
  return {
    root,
    files: [...new Set([...files, ...Object.keys(overrides)])].sort(),
    read: async (path: string) => (Object.hasOwn(overrides, path) ? overrides[path]! : readFileSync(join(root, path), 'utf8')),
  }
}

describe('DS1-a extension registrations', () => {
  it('registers unique ids with names, modes and existing seeds', () => {
    const ids = registrations.map((gate) => gate.id)
    assert.deepEqual(ids, ['G10', 'G11', 'G12', 'G15', 'G13', 'G14', 'G15-clipping', 'G16'])
    for (const gate of registrations) {
      assert.ok(gate.name && ['fast', 'browser'].includes(gate.mode), gate.id)
      const seed = JSON.parse(readFileSync(join(root, gate.seed), 'utf8')) as { files: object; expectedError: string }
      assert.ok(Object.keys(seed.files).length > 0 && seed.expectedError, gate.id)
    }
  })

  for (const gate of registrations.filter((item) => item.mode === 'fast')) {
    it(`${gate.id} passes on the checkout and fails its seed with the expected diagnostic`, async () => {
      const clean = await gate.check(context())
      assert.equal(clean.ok, true, clean.errors.join('\n'))
      const seed = JSON.parse(readFileSync(join(root, gate.seed), 'utf8')) as { files: Record<string, string>; expectedError: string }
      const seeded = await gate.check(context(seed.files))
      assert.equal(seeded.ok, false)
      assert.ok(seeded.errors.some((error) => error.includes(seed.expectedError)), seeded.errors.join('\n'))
    })
  }
})

describe('canonical commands run DS1-a\'s registry and G17 (GPT N6)', () => {
  const scripts = (path: string) => (JSON.parse(readFileSync(join(root, path), 'utf8')) as { scripts: Record<string, string> }).scripts

  it('npm run ui:check and ui:check:browser invoke gates/run.mjs, fast and browser', () => {
    assert.equal(scripts('package.json')['ui:check'], 'npm run ui:check --workspace @guanxi/ui')
    assert.equal(scripts('package.json')['ui:check:browser'], 'npm run ui:check:browser --workspace @guanxi/ui')
    assert.equal(scripts('packages/ui/package.json')['ui:check'], 'node gates/run.mjs')
    assert.equal(scripts('packages/ui/package.json')['ui:check:browser'], 'node gates/run.mjs --browser')
    // No script runs the catalog runner as a general check any more.
    for (const [name, command] of [...Object.entries(scripts('package.json')), ...Object.entries(scripts('packages/ui/package.json'))]) {
      if (command.includes('gates/catalog/run.ts')) assert.match(name, /selftest|snapshots/, `${name}: ${command}`)
    }
  })

  it('the browser scope of the common runner holds G13, G14 and G16 and appends G17 over their seeds', async () => {
    const { registry } = (await import(join(root, 'packages/ui/gates/registry.mjs'))) as {
      registry: (ctx: { root: string }) => Promise<Array<{ id: string; mode: string; seed: string }>>
    }
    const { runGates } = (await import(join(root, 'packages/ui/gates/run.mjs'))) as {
      runGates: (ctx: unknown, gates: unknown[], mode: string) => Promise<{ results: Array<{ id: string; ok: boolean }> }>
    }
    const gates = await registry({ root })
    assert.deepEqual(gates.filter((gate) => gate.mode === 'browser').map((gate) => gate.id), ['G13', 'G14', 'G15-clipping', 'G16'])
    // Stand-in checks: a pass on the checkout, a failure naming each seed's expected error.
    const seeds = new Map<string, string>()
    const stubs = gates
      .filter((gate) => gate.mode === 'browser')
      .map((gate) => {
        const fixture = JSON.parse(readFileSync(join(root, gate.seed), 'utf8')) as { expectedError: string }
        seeds.set(gate.id, fixture.expectedError)
        return { ...gate, check: async (ctx: { seeded?: boolean }) => (ctx.seeded ? { ok: false, errors: [fixture.expectedError] } : { ok: true, errors: [] }) }
      })
    const ctx = { json: async (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8')), withFiles: async () => ({ seeded: true }) }
    const report = await runGates(ctx, stubs, 'browser')
    assert.deepEqual(report.results.map((result) => result.id), ['G13', 'G14', 'G15-clipping', 'G16', 'G17'])
    assert.ok(report.results.every((result) => result.ok))
    assert.equal(seeds.size, 4)
    // Each browser checker has its own G17 seed, so removing either axe or clipping fails G17 (N12).
    assert.match(seeds.get('G14')!, /button-name/)
    assert.match(seeds.get('G15-clipping')!, /clipped text/)
  })
})
