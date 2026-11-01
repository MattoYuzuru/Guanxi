import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { collectLegalNotices, COLLECTION_SCOPE, modulePath, REQUIRED_NOTICES, verifyLegalNotices } from '../../scripts/lib/legal-notices.mjs'

const [firstSource, firstOutput] = REQUIRED_NOTICES[0]!
const fontSource = REQUIRED_NOTICES[3]![0]

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'legal-notices-'))
  const repository = join(root, 'repository')
  await mkdir(repository)
  const put = async (path: string, value: string) => {
    await mkdir(dirname(join(repository, path)), { recursive: true })
    await writeFile(join(repository, path), value)
  }
  for (const [path] of REQUIRED_NOTICES) await put(path, `Unchanged legal fixture: ${path}\r\n© fixture\n`)
  const pkg = async (path: string, license: string | null = 'MIT') => {
    await put(`${path}/package.json`, JSON.stringify({ name: path.split('/node_modules/').at(-1)?.replace(/^node_modules\//, ''), version: '1.2.3', license,
      scripts: { build: 'not a legal text' }, privateSettings: 'must not be exported' }))
    await put(`${path}/LICENSE`, 'MIT fixture\n')
  }
  const collect = (packages: object = {}, target = 'licenses') => collectLegalNotices({ repository, destination: join(root, target), lock: { packages } })
  return { root, repository, put, pkg, collect, close: () => rm(root, { recursive: true, force: true }) }
}

test('required project/font/data texts preserve their exact bytes and collection scope is explicit', async () => {
  const f = await fixture()
  try {
    const manifest = await f.collect()
    assert.equal(manifest.scope, COLLECTION_SCOPE)
    assert.match(manifest.scope, /under root node_modules only/)
    assert.equal(manifest.files.length, REQUIRED_NOTICES.length + 1)
    for (const [source, output] of REQUIRED_NOTICES) assert.deepEqual(await readFile(join(f.root, 'licenses', output)), await readFile(join(f.repository, source)))
    const readme = await readFile(join(f.root, 'licenses/README.md'), 'utf8')
    assert.match(readme, /not evidence that every package ships/)
    assert.match(readme, /does not inventory workspace-local modules or every staged runtime version/)
    assert.match(readme, /do not guarantee confinement against a hostile concurrent directory writer/)
    await verifyLegalNotices(join(f.root, 'licenses'), f.repository)
  } finally { await f.close() }
})

test('only allowlisted top-level legal texts and three metadata fields are collected from installed lock paths', async () => {
  const f = await fixture()
  try {
    await f.pkg('node_modules/a')
    await f.put('node_modules/a/NOTICE.txt', 'notice fixture')
    await f.put('node_modules/a/COPYING', 'copying fixture')
    await f.put('node_modules/a/LICENCE-MIT', 'licence fixture')
    await f.put('node_modules/a/.npmrc', 'must not be copied')
    await f.put('node_modules/a/source.js', 'must not be copied')
    await f.put('node_modules/a/docs/LICENSE', 'nested text is outside this collection')
    await f.pkg('node_modules/@scope/b/node_modules/c', null)
    await f.pkg('node_modules/no-text', null)
    await rm(join(f.repository, 'node_modules/no-text/LICENSE'))
    await symlink('../outside', join(f.repository, 'node_modules/workspace'))
    const manifest = await f.collect({
      'node_modules/a': { version: '1.2.3', integrity: 'not exported' },
      'node_modules/@scope/b/node_modules/c': { version: '1.2.3' },
      'node_modules/missing': { optional: true, version: '1.2.3' },
      'node_modules/workspace': { link: true },
      'node_modules/no-text': { version: '1.2.3' },
      'packages/cli/node_modules/outside-scope': { version: '9' },
    })
    const a = manifest.packages.find(entry => entry.path === 'node_modules/a')
    assert.deepEqual(a, { path: 'node_modules/a', status: 'installed', name: 'a', version: '1.2.3', license: 'MIT', notices: [
      'npm/node_modules/a/COPYING', 'npm/node_modules/a/LICENCE-MIT', 'npm/node_modules/a/LICENSE', 'npm/node_modules/a/NOTICE.txt',
    ] })
    assert.equal(manifest.packages.length, 5)
    assert.equal(manifest.packages.find(entry => entry.path.endsWith('/missing'))?.status, 'not-installed')
    assert.equal(manifest.packages.find(entry => entry.path.endsWith('/workspace'))?.status, 'workspace-link')
    const nested = manifest.packages.find(entry => entry.path.endsWith('/c'))
    assert.ok(nested && 'license' in nested)
    assert.equal(nested.license, null)
    assert.deepEqual(manifest.packages.find(entry => entry.path.endsWith('/no-text'))?.notices, [])
    const encoded = JSON.stringify(manifest)
    for (const excluded of ['privateSettings', 'must not be exported', 'scripts', 'integrity', '.npmrc', 'source.js', 'docs/LICENSE', 'outside-scope']) assert.equal(encoded.includes(excluded), false)
    assert.deepEqual(await readdir(join(f.root, 'licenses/npm/node_modules/a')), ['COPYING', 'LICENCE-MIT', 'LICENSE', 'NOTICE.txt'])
    await verifyLegalNotices(join(f.root, 'licenses'), f.repository)
  } finally { await f.close() }
})

test('manifest bytes and file digests are deterministic regardless of lock insertion order', async () => {
  const f = await fixture()
  try {
    await f.pkg('node_modules/z'); await f.pkg('node_modules/a')
    const entry = { version: '1.2.3' }
    await f.collect({ 'node_modules/z': entry, 'node_modules/a': entry }, 'first')
    await f.collect({ 'node_modules/a': entry, 'node_modules/z': entry }, 'second')
    assert.deepEqual(await readFile(join(f.root, 'first/manifest.json')), await readFile(join(f.root, 'second/manifest.json')))
    const manifest = await verifyLegalNotices(join(f.root, 'second'), f.repository)
    for (const file of manifest.files) assert.match(file.sha256, /^[a-f0-9]{64}$/)
  } finally { await f.close() }
})

test('unsafe lock paths are rejected rather than read or normalized', async () => {
  const f = await fixture()
  try {
    for (const path of ['node_modules/../outside', 'node_modules/@scope/../../outside', 'node_modules/a/../../x', 'node_modules/a\\..\\x', '/node_modules/a', 'node_modules//a', 'node_modules/.hidden']) assert.throws(() => modulePath(path))
    await assert.rejects(f.collect({ 'node_modules/../outside': { version: '1' } }), /unsafe/)
    assert.deepEqual(await readdir(f.root), ['repository'])
  } finally { await f.close() }
})

test('symlinked package parents, metadata and legal texts are refused without copying their target', async () => {
  for (const scenario of ['parent', 'metadata', 'notice', 'repository']) {
    const f = await fixture()
    try {
      await f.pkg('node_modules/a')
      await f.put('outside/LICENSE', 'must not be traversed')
      if (scenario === 'parent') {
        await rm(join(f.repository, 'node_modules/a'), { recursive: true })
        await symlink('../outside', join(f.repository, 'node_modules/a'))
      } else {
        const path = scenario === 'metadata' ? 'node_modules/a/package.json' : scenario === 'notice' ? 'node_modules/a/LICENSE' : firstSource
        await rm(join(f.repository, path))
        await symlink(join(f.repository, 'outside/LICENSE'), join(f.repository, path))
      }
      await assert.rejects(f.collect({ 'node_modules/a': { version: '1.2.3' } }), /symlinks/)
    } finally { await f.close() }
  }
})

test('directory and hard-linked notice sources and stale installed versions fail closed', async () => {
  for (const scenario of ['directory', 'hardlink', 'version', 'metadata']) {
    const f = await fixture()
    try {
      await f.pkg('node_modules/a')
      if (scenario === 'directory') {
        await rm(join(f.repository, 'node_modules/a/LICENSE'))
        await mkdir(join(f.repository, 'node_modules/a/LICENSE'))
      } else if (scenario === 'hardlink') await link(join(f.repository, 'node_modules/a/LICENSE'), join(f.repository, 'duplicate'))
      else if (scenario === 'metadata') await f.put('node_modules/a/package.json', '{"name":false,"version":"1.2.3"}')
      await assert.rejects(f.collect({ 'node_modules/a': { version: scenario === 'version' ? '9' : '1.2.3' } }), /regular|single-link|match the lock|metadata/)
    } finally { await f.close() }
  }
})

test('required source notices missing, empty or non-text stop staging, and existing output is preserved', async () => {
  for (const scenario of ['missing', 'empty', 'binary', 'existing']) {
    const f = await fixture()
    try {
      const path = join(f.repository, fontSource)
      if (scenario === 'missing') await rm(path)
      if (scenario === 'empty') await writeFile(path, '')
      if (scenario === 'binary') await writeFile(path, Buffer.from([0, 255]))
      if (scenario === 'existing') {
        await mkdir(join(f.root, 'licenses'))
        await writeFile(join(f.root, 'licenses/retained'), 'retained')
      }
      await assert.rejects(f.collect())
      if (scenario === 'existing') assert.equal(await readFile(join(f.root, 'licenses/retained'), 'utf8'), 'retained')
    } finally { await f.close() }
  }
})

test('verification rejects every missing required text, altered bytes and source/manifest tampering', async () => {
  const f = await fixture()
  try {
    await f.collect()
    const directory = join(f.root, 'licenses')
    for (const [, path] of REQUIRED_NOTICES) {
      const original = await readFile(join(directory, path))
      await rm(join(directory, path))
      await assert.rejects(verifyLegalNotices(directory, f.repository), /ENOENT/)
      await writeFile(join(directory, path), 'altered')
      await assert.rejects(verifyLegalNotices(directory, f.repository), /size|digest/)
      await writeFile(join(directory, path), original)
    }
    const manifest = await readFile(join(directory, 'manifest.json'), 'utf8')
    const parsed = JSON.parse(manifest)
    parsed.files = parsed.files.filter((entry: { path: string }) => entry.path !== firstOutput)
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(parsed))
    await assert.rejects(verifyLegalNotices(directory, f.repository), /required notice missing/)
    await writeFile(join(directory, 'manifest.json'), manifest)
    await writeFile(join(directory, 'extra'), 'not listed')
    await assert.rejects(verifyLegalNotices(directory, f.repository), /unexpected or missing/)
    await rm(join(directory, 'extra'))
    await f.put(firstSource, 'changed source')
    await assert.rejects(verifyLegalNotices(directory, f.repository), /preserve repository bytes/)
  } finally { await f.close() }
})

test('verification rejects symlinked or traversing manifest entries before following them', async () => {
  const f = await fixture()
  try {
    await f.collect()
    const directory = join(f.root, 'licenses')
    const path = firstOutput
    await rm(join(directory, path))
    await symlink(join(f.repository, firstSource), join(directory, path))
    await assert.rejects(verifyLegalNotices(directory, f.repository), /symlinks/)
    const parsed = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    parsed.files[0].path = '../repository/LICENSE'
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(parsed))
    await assert.rejects(verifyLegalNotices(directory, f.repository), /unsafe notice path/)
  } finally { await f.close() }
})

test('manifest verification refuses additional package metadata fields', async () => {
  const f = await fixture()
  try {
    await f.pkg('node_modules/a')
    await f.collect({ 'node_modules/a': { version: '1.2.3' } })
    const path = join(f.root, 'licenses/manifest.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    manifest.packages[0].privateSettings = 'not an allowed metadata field'
    await writeFile(path, JSON.stringify(manifest))
    await assert.rejects(verifyLegalNotices(join(f.root, 'licenses'), f.repository), /unexpected notice manifest fields/)
  } finally { await f.close() }
})
