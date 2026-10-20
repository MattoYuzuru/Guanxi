import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import {
  KERNEL_API_VERSION,
  ManifestError,
  definePlugin,
  parseManifest,
  readPackageManifest,
  satisfiesEngine,
} from '../src/index.ts'

const base = { id: 'fixture.sample', engines: { guanxi: '^0.1.0' }, trust: 'T0' }

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}/package.json`, import.meta.url), 'utf8'))
}

describe('manifest reader', () => {
  it('reads the guanxi field of a package.json from disk', async () => {
    const manifest = readPackageManifest(await fixture('valid-plugin'))
    assert.equal(manifest.id, 'fixture.valid-plugin')
    assert.deepEqual(manifest.provides, ['fixture-service'])
    assert.deepEqual(manifest.requires, ['governor'])
    assert.deepEqual(manifest.uses, ['ollama'])
    assert.deepEqual(manifest.contributes.slots, ['sidebar.items'])
    assert.deepEqual(manifest.contributes.locales, ['en', 'ru'])
    assert.equal(manifest.trust, 'T1')
    assert.ok(Object.isFrozen(manifest) && Object.isFrozen(manifest.provides))
  })

  it('refuses a package without a manifest', async () => {
    const pkg = await fixture('no-manifest')
    assert.throws(() => readPackageManifest(pkg), ManifestError)
  })

  it('accepts a parsed manifest again unchanged (round trip)', async () => {
    const manifest = readPackageManifest(await fixture('valid-plugin'))
    assert.deepEqual(parseManifest(manifest), manifest)
  })

  it('defaults lists to empty and keeps the kernel version in sync with package.json', async () => {
    const manifest = parseManifest(base)
    assert.deepEqual(
      [manifest.provides, manifest.requires, manifest.uses, manifest.contributes.slots],
      [[], [], [], []],
    )
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(KERNEL_API_VERSION, pkg.version)
  })

  const invalid: Array<[string, unknown, RegExp]> = [
    ['non-object', 'x', /must be an object/],
    ['unknown field', { ...base, extra: 1 }, /guanxi\.extra/],
    ['bad id', { ...base, id: 'NoDots' }, /guanxi\.id/],
    ['missing engines', { ...base, engines: {} }, /engines\.guanxi/],
    ['bad range', { ...base, engines: { guanxi: '^0.1' } }, /engines\.guanxi/],
    ['prerelease range', { ...base, engines: { guanxi: '^0.1.0-rc.1' } }, /engines\.guanxi/],
    ['bad trust', { ...base, trust: 'T3' }, /guanxi\.trust/],
    ['capabilities on T0', { ...base, capabilities: {} }, /capabilities/],
    ['duplicate provide', { ...base, provides: ['a', 'a'] }, /duplicate/],
    ['non-name provide', { ...base, provides: ['Bad Name'] }, /provides\[0\]/],
    ['require of own service', { ...base, provides: ['a'], requires: ['a'] }, /also provided/],
    ['uses repeats requires', { ...base, requires: ['a'], uses: ['a'] }, /already required/],
    ['unknown contribution', { ...base, contributes: { widgets: ['x'] } }, /contributes\.widgets/],
    ['non-list slots', { ...base, contributes: { slots: 'sidebar.items' } }, /contributes\.slots/],
  ]
  for (const [label, input, pattern] of invalid) {
    it(`rejects ${label}`, () => {
      assert.throws(() => parseManifest(input), (error: unknown) => {
        return error instanceof ManifestError && pattern.test(error.message)
      })
    })
  }

  it('checks engines.guanxi ranges against the kernel version', () => {
    assert.equal(satisfiesEngine('^0.1.0', '0.1.0'), true)
    assert.equal(satisfiesEngine('^0.1.0', '0.1.9'), true)
    assert.equal(satisfiesEngine('^0.1.0', '0.2.0'), false)
    assert.equal(satisfiesEngine('^1.2.0', '1.9.0'), true)
    assert.equal(satisfiesEngine('^1.2.0', '2.0.0'), false)
    assert.equal(satisfiesEngine('~1.2.3', '1.2.9'), true)
    assert.equal(satisfiesEngine('~1.2.3', '1.3.0'), false)
    assert.equal(satisfiesEngine('>=0.1.0 <0.3.0', '0.2.5'), true)
    assert.equal(satisfiesEngine('>=0.1.0 <0.3.0', '0.3.0'), false)
    assert.equal(satisfiesEngine('0.1.0', '0.1.1'), false)
  })
})

describe('definePlugin', () => {
  it('refuses T2 plugins in process', () => {
    assert.throws(
      () => definePlugin({ manifest: { ...base, trust: 'T2' }, apply() {} }),
      /must run out of process/,
    )
  })

  it('derives the Cordis name and injections from the manifest', () => {
    const plugin = definePlugin({
      manifest: { ...base, requires: ['governor'], contributes: { slots: ['sidebar.items'] } },
      apply() {},
    })
    assert.equal(plugin.name, 'fixture.sample')
    assert.deepEqual(plugin.inject, ['governor', 'slot:sidebar.items'])
  })
})
