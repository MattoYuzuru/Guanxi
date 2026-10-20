import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ProfileError, resolveProfile, type ProfileLayer } from '../src/index.ts'
import { readProfileLayer } from '../src/node.ts'

const base: ProfileLayer = {
  name: 'profile:headless',
  insert: [
    { id: 'governor', plugin: 'guanxi.resource-governor' },
    { id: 'ollama', plugin: 'guanxi.ollama-adapter', config: { connectTimeoutMs: 15000 } },
  ],
}

function rejects(layers: ProfileLayer[], pattern: RegExp): void {
  assert.throws(() => resolveProfile(layers), (error: unknown) => {
    return error instanceof ProfileError && pattern.test(error.message)
  })
}

describe('profile layers', () => {
  it('applies inserts and patches in layer order', () => {
    const resolved = resolveProfile([
      base,
      { name: 'bundle:dev', insert: [{ id: 'extra', plugin: 'fixture.extra' }] },
      {
        name: 'user',
        patch: [
          { id: 'ollama', config: { connectTimeoutMs: 1000 } },
          { id: 'extra', disabled: true },
        ],
      },
    ])
    assert.deepEqual(
      resolved.map(({ id, plugin, config, disabled, layers }) => ({ id, plugin, config, disabled, layers })),
      [
        { id: 'governor', plugin: 'guanxi.resource-governor', config: undefined, disabled: false, layers: ['profile:headless'] },
        { id: 'ollama', plugin: 'guanxi.ollama-adapter', config: { connectTimeoutMs: 1000 }, disabled: false, layers: ['profile:headless', 'user'] },
        { id: 'extra', plugin: 'fixture.extra', config: undefined, disabled: true, layers: ['bundle:dev', 'user'] },
      ],
    )
  })

  it('lets a later layer patch a row an earlier layer inserted, and remove rows', () => {
    const resolved = resolveProfile([
      base,
      { name: 'user', insert: [{ id: 'late', plugin: 'fixture.late' }], patch: [{ id: 'late', disabled: true }, { id: 'governor', remove: true }] },
    ])
    assert.deepEqual(resolved.map((entry) => [entry.id, entry.disabled]), [['ollama', false], ['late', true]])
  })

  it('does not share config objects with the input layers', () => {
    const config = { nested: { value: 1 } }
    const [entry] = resolveProfile([{ name: 'p', insert: [{ id: 'a', plugin: 'x.y', config }] }])
    config.nested.value = 2
    assert.deepEqual(entry?.config, { nested: { value: 1 } })
  })

  it('fails on a patch that names an unknown row instead of ignoring it', () => {
    rejects([base, { name: 'user', patch: [{ id: 'olama', disabled: true }] }], /user: patch targets unknown row "olama"/)
  })

  it('refuses executable loader expressions anywhere in profile data', () => {
    rejects([{ name: 'evil', insert: [{ id: 'a', plugin: 'x.y', config: { __jsExpr: 'process.exit()' } }] }], /__jsExpr/)
    rejects([{ name: 'evil', insert: [{ id: 'a', plugin: 'x.y', config: { deep: [{ __jsExpr: '1' }] } }] }], /a\.config\.deep\[0\]/)
    rejects([base, { name: 'evil', patch: [{ id: 'governor', config: { __jsExpr: '1' } }] }], /__jsExpr/)
    rejects([{ name: 'evil', insert: [{ id: 'a', plugin: 'x.y', disabled: { __jsExpr: 'true' } as never }] }], /non-boolean "disabled"/)
  })

  it('refuses non-JSON config values', () => {
    rejects([{ name: 'p', insert: [{ id: 'a', plugin: 'x.y', config: { at: new Date() } }] }], /not plain JSON/)
    rejects([{ name: 'p', insert: [{ id: 'a', plugin: 'x.y', config: { f: () => 1 } }] }], /not plain JSON/)
    rejects([{ name: 'p', insert: [{ id: 'a', plugin: 'x.y', config: { n: Number.NaN } }] }], /finite/)
  })

  it('rejects duplicate rows, bad ids and unknown fields', () => {
    rejects([base, { name: 'again', insert: [{ id: 'governor', plugin: 'x.y' }] }], /already exists/)
    rejects([{ name: 'p', insert: [{ id: 'Bad Id', plugin: 'x.y' }] }], /invalid/)
    rejects([{ name: 'p', insert: [{ id: 'a', plugin: 'x.y', enabled: true } as never] }], /unknown field "enabled"/)
    rejects([base, { name: 'p', patch: [{ id: 'governor', name: 'other' } as never] }], /unknown field "name"/)
  })

  it('reads a JSON layer from disk and refuses unknown top-level fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guanxi-profile-'))
    try {
      const good = join(dir, 'user.json')
      await writeFile(good, JSON.stringify({ name: 'user', patch: [{ id: 'governor', disabled: true }] }))
      const layer = await readProfileLayer(good)
      assert.equal(resolveProfile([base, layer])[0]?.disabled, true)
      const bad = join(dir, 'bad.json')
      await writeFile(bad, JSON.stringify({ plugins: [] }))
      await assert.rejects(readProfileLayer(bad), /unknown field "plugins"/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
