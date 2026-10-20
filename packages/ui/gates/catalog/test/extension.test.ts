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
    assert.deepEqual(ids, ['G10', 'G11', 'G12', 'G15', 'G13', 'G14', 'G16'])
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
