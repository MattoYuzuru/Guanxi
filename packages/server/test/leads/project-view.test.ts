import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { LEAD_PROJECT_READ_TOOL, LEAD_PROJECT_SEARCH_TOOL, LEAD_PROJECT_TREE_TOOL } from '@guanxi/contract'
import { SecretScrubber } from '../../src/egress/scrubber.ts'
import { PROJECT_VIEW_TOOLS, ProjectView, ProjectViewError, deniedPath, type ProjectViewPolicy } from '../../src/leads/project-view.ts'
import { LeadToolServer, type ExtraTool, type ToolGrantContext, type ToolHandler } from '../../src/leads/tool-server.ts'
import { brief, leadFixture } from './helpers.ts'

const GIT = '/usr/bin/git'
const env = { PATH: '/usr/bin:/bin', HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'n', GIT_AUTHOR_EMAIL: 'n@example.test',
  GIT_COMMITTER_NAME: 'n', GIT_COMMITTER_EMAIL: 'n@example.test' }
const git = (cwd: string, ...args: string[]) => execFileSync(GIT, args, { cwd, env, encoding: 'utf8' }).trim()
const REGISTERED = 'zz-registered-secret-value-0123456789'
const ENV_MARKER = 'DOTENV_MARKER_7f3a'
const OUTSIDE_MARKER = 'OUTSIDE_MARKER_91bc'

interface Repo { dir: string; outside: string; head: string; commit(message: string): string }
/** A real repository with a committed mix of ordinary files, secret-named files and symlinks that point outside it. */
async function makeRepo(t: TestContext, files: Record<string, string | Buffer> = {}, links: Record<string, string> = {}): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), 'guanxi-pview-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'repo'), outside = join(root, 'outside')
  await mkdir(dir); await mkdir(outside)
  await writeFile(join(outside, 'private.txt'), `${OUTSIDE_MARKER}\n`)
  git(dir, 'init', '-q', '-b', 'main')
  const all: Record<string, string | Buffer> = {
    'README.md': '# Ledger\nsee src/money.ts\n',
    'src/money.ts': 'export const cents = (x: number) => Math.round(x * 100)\n// TODO: handle négatifs — émoji 🙂\n',
    'src/deep/inner.ts': 'export const inner = 1\n',
    'test/money.test.ts': "import { cents } from '../src/money.ts'\n",
    '.env': `API_TOKEN=${ENV_MARKER}\n`, 'config/.env.local': `LOCAL=${ENV_MARKER}\n`, '.ENV.production': `PROD=${ENV_MARKER}\n`,
    'keys/id_rsa': `-----BEGIN-----\n${ENV_MARKER}\n`, 'certs/server.pem': `${ENV_MARKER}\n`, '.ssh/config': `Host ${ENV_MARKER}\n`,
    ...files,
  }
  for (const [name, content] of Object.entries(all)) { await mkdir(dirname(join(dir, name)), { recursive: true }); await writeFile(join(dir, name), content) }
  const allLinks = { 'link-file': join(outside, 'private.txt'), 'link-dir': outside, 'link-up': '..', ...links }
  for (const [name, target] of Object.entries(allLinks)) await symlink(target, join(dir, name))
  git(dir, 'add', '-A', '-f')
  git(dir, 'commit', '-q', '-m', 'initial')
  return { dir, outside, head: git(dir, 'rev-parse', 'HEAD'),
    commit(message: string) { git(dir, 'add', '-A', '-f'); git(dir, 'commit', '-q', '-m', message); return git(dir, 'rev-parse', 'HEAD') } }
}
const makeView = (policy: Partial<ProjectViewPolicy> = {}) => {
  const scrubber = new SecretScrubber()
  scrubber.register('secret://test/registered', REGISTERED)
  return { scrubber, view: new ProjectView({ scrubber, policy }) }
}
const code = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise } catch (error) { assert.ok(error instanceof ProjectViewError, `a fixed code, not ${String(error)}`); return error.text }
  assert.fail('expected a refusal')
}
const json = async (promise: Promise<{ text: string }>) => JSON.parse((await promise).text) as Record<string, any>

// ---- happy paths ------------------------------------------------------------------------------

test('tree, read and search return the committed project at the named commit and report it as the plan base', async t => {
  const repo = await makeRepo(t)
  const { view } = makeView()
  const root = await json(view.tree(repo.dir, {}))
  assert.equal(root.commit, repo.head)
  assert.match(root.commit, /^[a-f0-9]{40}$/)
  const byPath = new Map<string, any>(root.entries.map((entry: any) => [entry.path, entry]))
  assert.equal(byPath.get('README.md').type, 'file')
  assert.equal(byPath.get('README.md').size, Buffer.byteLength('# Ledger\nsee src/money.ts\n'))
  assert.equal(byPath.get('src').type, 'dir')
  assert.equal(byPath.get('link-file').type, 'symlink')
  assert.deepEqual(root.bounds, { limit: 200, defaultLimit: 200, maxLimit: 2_000, maxResultBytes: 262_144 })
  assert.equal(root.more, false); assert.equal(root.nextOffset, null)

  assert.deepEqual((await json(view.tree(repo.dir, { path: 'src' }))).entries.map((entry: any) => entry.path), ['src/deep', 'src/money.ts'])
  assert.deepEqual((await json(view.tree(repo.dir, { path: 'src/', recursive: true }))).entries.map((entry: any) => entry.path), ['src/deep/inner.ts', 'src/money.ts'])

  const read = await json(view.read(repo.dir, { path: 'src/money.ts' }))
  assert.equal(read.text, 'export const cents = (x: number) => Math.round(x * 100)\n// TODO: handle négatifs — émoji 🙂\n')
  assert.equal(read.more, false); assert.equal(read.nextOffset, null); assert.equal(read.commit, repo.head)

  const found = await json(view.search(repo.dir, { text: 'Math.round' }))
  assert.deepEqual(found.matches, [{ path: 'src/money.ts', line: 1, text: 'export const cents = (x: number) => Math.round(x * 100)' }])
})

test('the view reads the named commit, not the working tree: later commits, edits and untracked files are not visible', async t => {
  const repo = await makeRepo(t)
  const { view } = makeView()
  await writeFile(join(repo.dir, 'src/money.ts'), 'export const cents = 0 // uncommitted edit\n')
  await writeFile(join(repo.dir, 'untracked.txt'), 'untracked\n')
  await writeFile(join(repo.dir, '.gitignore'), 'ignored.txt\n')
  await writeFile(join(repo.dir, 'ignored.txt'), 'ignored\n')
  assert.match((await json(view.read(repo.dir, { path: 'src/money.ts' }))).text, /Math\.round/, 'the committed text, not the edit')
  for (const path of ['untracked.txt', 'ignored.txt']) assert.equal(await code(view.read(repo.dir, { path })), 'not_found')
  assert.ok(!(await json(view.tree(repo.dir, {}))).entries.some((entry: any) => ['untracked.txt', 'ignored.txt'].includes(entry.path)))
  await writeFile(join(repo.dir, 'src/money.ts'), 'export const second = 2\n')
  const second = repo.commit('second')
  assert.match((await json(view.read(repo.dir, { path: 'src/money.ts', ref: repo.head }))).text, /Math\.round/, 'an explicit older commit')
  const now = await json(view.read(repo.dir, { path: 'src/money.ts' }))
  assert.equal(now.commit, second); assert.match(now.text, /second/)
})

// ---- paths ------------------------------------------------------------------------------------

test('traversal, absolute, encoded-looking and malformed paths are refused before git runs', async t => {
  const repo = await makeRepo(t)
  const { view } = makeView()
  const bad = ['../repo/README.md', '..', 'src/../README.md', 'src/..', '/etc/passwd', `${repo.dir}/README.md`, 'src\\money.ts', 'src/\0money.ts', '~/x', './README.md', 'src/./money.ts',
    'src//money.ts', '//', 'a\nb', 'x'.repeat(5_000)]
  for (const path of bad) {
    assert.equal(await code(view.read(repo.dir, { path })), 'path_invalid', JSON.stringify(path.slice(0, 40)))
    assert.equal(await code(view.tree(repo.dir, { path })), 'path_invalid', `tree ${JSON.stringify(path.slice(0, 40))}`)
    assert.equal(await code(view.search(repo.dir, { text: 'x', path })), 'path_invalid', `search ${JSON.stringify(path.slice(0, 40))}`)
  }
  assert.equal(await code(view.read(repo.dir, { path: '' })), 'path_invalid', 'a file read needs a file')
  assert.equal(await code(view.read(repo.dir, { path: '.' })), 'path_invalid')
  // A percent-encoded dot is an ordinary (absent) name, never decoded.
  assert.equal(await code(view.read(repo.dir, { path: '%2e%2e/README.md' })), 'not_found')
  // A glob or pathspec magic is a literal name.
  for (const path of ['src/*', ':(top)README.md', ':!README.md', 'READ*']) assert.equal(await code(view.read(repo.dir, { path })), 'not_found', path)
})

test('a committed symlink is listed as a symlink and is never followed, read or searched', async t => {
  const repo = await makeRepo(t)
  const { view } = makeView()
  const root = await json(view.tree(repo.dir, {}))
  for (const name of ['link-file', 'link-dir', 'link-up']) assert.equal(root.entries.find((entry: any) => entry.path === name)?.type, 'symlink', name)
  assert.equal(await code(view.read(repo.dir, { path: 'link-file' })), 'symlink_denied')
  assert.equal(await code(view.read(repo.dir, { path: 'link-dir' })), 'symlink_denied')
  assert.equal(await code(view.tree(repo.dir, { path: 'link-dir' })), 'not_a_directory')
  assert.equal(await code(view.tree(repo.dir, { path: 'link-up', recursive: true })), 'not_a_directory')
  // Nothing can be reached through a link, wherever it points.
  for (const path of ['link-dir/private.txt', 'link-up/outside/private.txt', 'link-up/repo/README.md']) {
    assert.equal(await code(view.read(repo.dir, { path })), 'not_found', path)
    assert.equal(await code(view.tree(repo.dir, { path })), 'not_found', path)
  }
  // The outside file's text appears nowhere: not as a read, not in a recursive listing, not in a search.
  const everything = JSON.stringify([await json(view.tree(repo.dir, { recursive: true })), await json(view.search(repo.dir, { text: OUTSIDE_MARKER })),
    await json(view.search(repo.dir, { text: 'private.txt' }))])
  assert.equal(everything.includes(OUTSIDE_MARKER), false)
  // A link replaced in the working tree after the commit changes nothing: the view never looks there.
  await rm(join(repo.dir, 'README.md')); await symlink(join(repo.outside, 'private.txt'), join(repo.dir, 'README.md'))
  assert.match((await json(view.read(repo.dir, { path: 'README.md' }))).text, /^# Ledger/)
})

test('secret-named files are denied by every tool, omitted and counted in listings, and never searched', async t => {
  const repo = await makeRepo(t)
  const { view } = makeView()
  const secrets = ['.env', 'config/.env.local', '.ENV.production', 'keys/id_rsa', 'certs/server.pem', '.ssh/config']
  for (const path of secrets) {
    assert.equal(await code(view.read(repo.dir, { path })), 'path_denied', path)
    assert.equal(await code(view.search(repo.dir, { text: ENV_MARKER, path })), 'path_denied', `search ${path}`)
  }
  for (const path of ['.ssh', '.git', '.git/config', 'node_modules/x']) assert.equal(await code(view.tree(repo.dir, { path })), 'path_denied', `tree ${path}`)
  // Denied and missing look alike for a name the policy refuses: no existence oracle.
  assert.equal(await code(view.read(repo.dir, { path: '.env.nonexistent' })), 'path_denied')
  const top = await json(view.tree(repo.dir, {}))
  assert.deepEqual(top.entries.map((entry: any) => entry.path).filter((path: string) => /\.env|\.ssh|id_rsa/i.test(path)), [], 'omitted, not named')
  assert.equal(top.withheld, 3, '.env, .ENV.production and .ssh at the top level')
  const all = await json(view.tree(repo.dir, { recursive: true }))
  assert.equal(all.withheld, 6, 'every denied file below the root is counted, none is named')
  const found = await json(view.search(repo.dir, { text: ENV_MARKER }))
  assert.deepEqual(found.matches, [])
  assert.equal(found.withheld, 6)
  assert.equal(JSON.stringify([top, all, found]).includes(ENV_MARKER), false)
  // The name rule itself.
  for (const name of ['.env', 'a/.env.local', '.git/config', 'x/node_modules/y', '.npmrc', '.aws/credentials', 'id_ed25519', 'ID_RSA.pub', 'credentials.json', 'client_secret_1.json', 'a/b.PEM', 'tls.key', 'terraform.tfstate', 'x.tfvars', '.netrc', '.git-credentials']) {
    assert.equal(deniedPath(name), true, name)
  }
  for (const name of ['README.md', 'src/environment.ts', 'src/keys.ts', 'src/credentials-ui/index.ts'.replace('credentials-ui', 'ui'), 'docs/env.md', 'monkey.ts']) assert.equal(deniedPath(name), false, name)
})

// ---- scrubbing and bounds ---------------------------------------------------------------------

test('registered secrets are scrubbed in text, paths and search lines, including across a page boundary and a clipped line', async t => {
  const filler = 'a'.repeat(100)
  const repo = await makeRepo(t, {
    'src/config.ts': `${filler}\nconst key = '${REGISTERED}'\n${filler}\n`,
    [`src/${REGISTERED}.txt`]: 'named after the secret\n',
    'src/long.ts': `${'x'.repeat(80)}${REGISTERED}${'y'.repeat(80)}\n`,
  })
  const { view } = makeView({ lineChars: 100 })
  const whole = await json(view.read(repo.dir, { path: 'src/config.ts' }))
  assert.equal(whole.text.includes(REGISTERED), false)
  assert.match(whole.text, /REDACTED secret:\/\/test\/registered/)
  assert.equal(whole.redacted, true)
  // Every page size puts a page boundary somewhere in or beside the secret; no page carries any part of it.
  for (let limit = 90; limit <= 140; limit += 7) {
    let offset: number | null = 0, text = '', pages = 0
    while (offset !== null) {
      const page = await json(view.read(repo.dir, { path: 'src/config.ts', offset, limit }))
      assert.equal(page.text.includes(REGISTERED.slice(0, 8)), false, `limit ${limit} page ${pages}`)
      text += page.text; offset = page.nextOffset; pages++
      assert.ok(pages < 100)
    }
    assert.equal(text, whole.text, `pages of ${limit} bytes reassemble the scrubbed file exactly`)
  }
  const listed = JSON.stringify(await json(view.tree(repo.dir, { path: 'src' })))
  assert.equal(listed.includes(REGISTERED), false, 'a path that spells a secret')
  const search = await json(view.search(repo.dir, { text: "const key = '" }))
  assert.equal(JSON.stringify(search).includes(REGISTERED), false)
  // The line is cut inside the secret: neither the secret nor its first characters survive the cut.
  const clipped = await json(view.search(repo.dir, { text: 'xxxxxxxx', path: 'src/long.ts' }))
  assert.equal(clipped.matches.length, 1)
  assert.equal(JSON.stringify(clipped).includes(REGISTERED.slice(0, 6)), false)
  assert.match(clipped.matches[0].text, /…\[line clipped, \d+ more characters\]$/)
  assert.equal(clipped.truncated, true)
})

test('a tree is paged with an exact count, no duplicates, a cursor and the bounds in force; a request above the maximum is clamped and says so', async t => {
  const files: Record<string, string> = {}
  for (let i = 0; i < 37; i++) files[`many/f${String(i).padStart(2, '0')}.txt`] = `${i}\n`
  const repo = await makeRepo(t, files)
  const { view } = makeView({ treeEntries: 10, maxTreeEntries: 25 })
  const seen: string[] = []
  let offset: number | null = 0, pages = 0
  while (offset !== null) {
    const page: Record<string, any> = await json(view.tree(repo.dir, { path: 'many', offset }))
    assert.equal(page.total, 37); assert.equal(page.bounds.limit, 10); assert.equal(page.bounds.maxLimit, 25)
    assert.equal(page.more, page.nextOffset !== null); assert.equal(page.truncated, page.more)
    seen.push(...page.entries.map((entry: any) => entry.path)); offset = page.nextOffset; pages++
  }
  assert.equal(pages, 4)
  assert.equal(seen.length, 37)
  assert.equal(new Set(seen).size, 37, 'no entry twice')
  assert.deepEqual(seen, [...seen].sort())
  const clamped = await json(view.tree(repo.dir, { path: 'many', limit: 1_000 }))
  assert.equal(clamped.bounds.limit, 25); assert.equal(clamped.entries.length, 25); assert.equal(clamped.more, true); assert.equal(clamped.nextOffset, 25)
  const last = await json(view.tree(repo.dir, { path: 'many', offset: 30 }))
  assert.deepEqual([last.entries.length, last.more, last.nextOffset], [7, false, null])
  const beyond = await json(view.tree(repo.dir, { path: 'many', offset: 500 }))
  assert.deepEqual([beyond.entries.length, beyond.more, beyond.total], [0, false, 37])
})

test('a result that would exceed the result bound drops entries from the end and still continues without a gap or a duplicate', async t => {
  const files: Record<string, string> = {}
  for (let i = 0; i < 40; i++) files[`wide/${'n'.repeat(60)}${String(i).padStart(2, '0')}.txt`] = 'x\n'
  const repo = await makeRepo(t, files)
  const { view } = makeView({ maxResultBytes: 1_500 })
  const seen: string[] = []
  let offset: number | null = 0, pages = 0
  while (offset !== null) {
    const result: { text: string } = await view.tree(repo.dir, { path: 'wide', offset })
    assert.ok(Buffer.byteLength(result.text) <= 1_500)
    const page: Record<string, any> = JSON.parse(result.text)
    assert.ok(page.entries.length > 0 && page.entries.length < 40)
    assert.equal(page.more, true === (page.nextOffset !== null))
    seen.push(...page.entries.map((entry: any) => entry.path)); offset = page.nextOffset; pages++
    assert.ok(pages < 100)
  }
  assert.equal(seen.length, 40); assert.equal(new Set(seen).size, 40)
  const tight = makeView({ maxResultBytes: 200 }).view
  assert.equal(await code(tight.tree(repo.dir, { path: 'wide' })), 'result_too_large', 'a bound too small for even the envelope is an error, not a silent empty page')
})

test('a read is paged on character boundaries with a byte cursor, and refuses a bad cursor, a big file and a binary file', async t => {
  const text = 'é🙂ü'.repeat(300)
  const repo = await makeRepo(t, { 'docs/utf8.txt': text, 'docs/huge.txt': 'z'.repeat(5_000), 'docs/bin.dat': Buffer.from([1, 2, 0, 3]), 'docs/latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9]) })
  const { view } = makeView({ pageBytes: 100, maxPageBytes: 250, maxFileBytes: 4_000 })
  const first = await json(view.read(repo.dir, { path: 'docs/utf8.txt' }))
  assert.equal(first.bounds.limit, 100); assert.equal(first.bounds.maxLimit, 250); assert.equal(first.bounds.maxFileBytes, 4_000)
  assert.equal(first.more, true); assert.equal(first.truncated, true); assert.equal(first.totalBytes, Buffer.byteLength(text))
  let offset: number | null = 0, assembled = '', pages = 0
  while (offset !== null) {
    const page: Record<string, any> = await json(view.read(repo.dir, { path: 'docs/utf8.txt', offset, limit: 999 }))
    assert.equal(page.bounds.limit, 250, 'clamped to the maximum')
    assert.equal(page.text.includes('�'), false, 'no split character')
    assembled += page.text; offset = page.nextOffset; pages++
  }
  assert.equal(assembled, text); assert.ok(pages > 1)
  assert.equal(await code(view.read(repo.dir, { path: 'docs/utf8.txt', offset: 1 })), 'invalid_offset', 'inside a two-byte character')
  assert.equal(await code(view.read(repo.dir, { path: 'docs/utf8.txt', offset: Buffer.byteLength(text) + 1 })), 'invalid_offset')
  const end = await json(view.read(repo.dir, { path: 'docs/utf8.txt', offset: Buffer.byteLength(text) }))
  assert.deepEqual([end.text, end.more, end.nextOffset], ['', false, null])
  assert.equal(await code(view.read(repo.dir, { path: 'docs/huge.txt' })), 'file_too_large: size 5000 bytes, limit 4000')
  assert.equal(await code(view.read(repo.dir, { path: 'docs/bin.dat' })), 'binary_file')
  assert.equal(await code(view.read(repo.dir, { path: 'docs/latin1.txt' })), 'binary_file', 'not UTF-8 is refused, never mangled')
  assert.equal(await code(view.read(repo.dir, { path: 'docs' })), 'not_a_file')
  assert.equal(await code(view.read(repo.dir, { path: 'docs/missing.txt' })), 'not_found')
  assert.equal(await code(makeView({ pageBytes: 1, maxPageBytes: 1 }).view.read(repo.dir, { path: 'docs/utf8.txt' })), 'page_too_small')
})

test('a search is literal, single-line, paged with a cursor and explicit about clipped lines', async t => {
  const lines = Array.from({ length: 12 }, (_, i) => `needle ${i} a.c`).join('\n') + '\nabc\n'
  const repo = await makeRepo(t, { 'src/hay.txt': lines, 'src/wide.txt': `needle ${'w'.repeat(500)}\n` })
  const { view } = makeView({ searchMatches: 5, maxSearchMatches: 8, lineChars: 40 })
  const seen: string[] = []
  let offset: number | null = 0, pages = 0
  while (offset !== null) {
    const page: Record<string, any> = await json(view.search(repo.dir, { text: 'needle', path: 'src/hay.txt', offset }))
    assert.equal(page.bounds.limit, 5); assert.equal(page.bounds.maxLimit, 8); assert.equal(page.more, page.nextOffset !== null)
    seen.push(...page.matches.map((match: any) => `${match.line}`)); offset = page.nextOffset; pages++
    assert.ok(pages < 10)
  }
  assert.equal(pages, 3)
  assert.deepEqual(seen, Array.from({ length: 12 }, (_, i) => `${i + 1}`), 'every match once, in order')
  assert.equal((await json(view.search(repo.dir, { text: 'needle', path: 'src/hay.txt', limit: 99 }))).bounds.limit, 8)
  // A literal is not a regular expression.
  assert.equal((await json(view.search(repo.dir, { text: 'a.c', path: 'src/hay.txt', limit: 8 }))).matches.length, 8)
  assert.equal((await json(view.search(repo.dir, { text: 'a.c', path: 'src/hay.txt', offset: 12 }))).matches.length, 0, 'abc is not a.c')
  assert.deepEqual((await json(view.search(repo.dir, { text: '--help' }))).matches, [], 'an option-looking text is only text')
  assert.equal(await code(view.search(repo.dir, { text: 'a\nb' })), 'invalid_input: text: must be a single line')
  assert.equal(await code(view.search(repo.dir, { text: 'a\rb' })), 'invalid_input: text: must be a single line')
  const wide = await json(view.search(repo.dir, { text: 'needle', path: 'src/wide.txt' }))
  assert.equal(wide.matches[0].text.length < 120, true)
  assert.match(wide.matches[0].text, /…\[line clipped, 467 more characters\]$/)
  assert.equal(wide.truncated, true); assert.equal(wide.more, false)
  assert.equal(await code(view.search(repo.dir, { text: 'x', path: 'nope' })), 'not_found')
})

// ---- refs, roots, inputs ----------------------------------------------------------------------

test('only HEAD or a full commit id is a ref; an unknown commit, a non-repository and a nested root are refused with fixed codes', async t => {
  const repo = await makeRepo(t)
  const { view } = makeView()
  for (const ref of ['main', 'HEAD~1', 'HEAD^{tree}', '--upload-pack=x', '-p', 'refs/heads/main', repo.head.toUpperCase(), repo.head.slice(0, 12), `${repo.head}\n`, 'HEAD:README.md', ' HEAD']) {
    assert.equal(await code(view.tree(repo.dir, { ref })), 'ref_invalid', JSON.stringify(ref))
    assert.equal(await code(view.read(repo.dir, { path: 'README.md', ref })), 'ref_invalid', JSON.stringify(ref))
    assert.equal(await code(view.search(repo.dir, { text: 'x', ref })), 'ref_invalid', JSON.stringify(ref))
  }
  assert.equal(await code(view.tree(repo.dir, { ref: 'f'.repeat(40) })), 'ref_not_found')
  assert.equal((await json(view.tree(repo.dir, { ref: 'HEAD' }))).commit, repo.head)
  assert.equal((await json(view.tree(repo.dir, { ref: repo.head }))).commit, repo.head)
  const plain = await mkdtemp(join(tmpdir(), 'guanxi-pview-plain-'))
  t.after(() => rm(plain, { recursive: true, force: true }))
  assert.equal(await code(view.tree(plain, {})), 'project_view_unavailable')
  assert.equal(await code(view.tree(join(plain, 'missing'), {})), 'project_view_unavailable')
  assert.equal(await code(view.tree(join(repo.dir, 'src'), {})), 'project_view_unavailable', 'a root below the repository top level')
  const unborn = await mkdtemp(join(tmpdir(), 'guanxi-pview-unborn-'))
  t.after(() => rm(unborn, { recursive: true, force: true }))
  git(unborn, 'init', '-q')
  assert.equal(await code(view.tree(unborn, {})), 'ref_not_found', 'a repository without a commit')
})

test('input is strict: unknown keys, wrong types and non-positive bounds are invalid_input without echoing values', async t => {
  const repo = await makeRepo(t)
  const { view } = makeView()
  const cases: [Promise<unknown>, RegExp][] = [
    [view.tree(repo.dir, { path: 'src', root: '/etc' }), /^invalid_input: \(root\): Unrecognized key/],
    [view.tree(repo.dir, { limit: 0 }), /^invalid_input: limit:/],
    [view.tree(repo.dir, { offset: -1 }), /^invalid_input: offset:/],
    [view.tree(repo.dir, { recursive: 'yes' }), /^invalid_input: recursive:/],
    [view.read(repo.dir, {}), /^invalid_input: path:/],
    [view.read(repo.dir, { path: 5 }), /^invalid_input: path:/],
    [view.search(repo.dir, { text: '' }), /^invalid_input: text:/],
    [view.search(repo.dir, { text: 'x'.repeat(1_001) }), /^invalid_input: text:/],
  ]
  for (const [promise, pattern] of cases) assert.match(await code(promise), pattern)
  assert.equal((await json(view.tree(repo.dir, null))).commit, repo.head, 'no input is an empty request')
  assert.throws(() => makeView({ treeEntries: 0 }), (error: unknown) => error instanceof ProjectViewError && error.code === 'invalid_policy')
  assert.throws(() => makeView({ treeEntries: 10, maxTreeEntries: 5 }), (error: unknown) => error instanceof ProjectViewError && error.code === 'invalid_policy')
})

test('the tool schemas list exactly the inputs the validators accept', () => {
  const byName = new Map(PROJECT_VIEW_TOOLS.map(tool => [tool.name, tool.inputSchema as { properties: Record<string, unknown>; required?: string[]; additionalProperties: boolean }]))
  assert.deepEqual([...byName.keys()], [LEAD_PROJECT_TREE_TOOL, LEAD_PROJECT_READ_TOOL, LEAD_PROJECT_SEARCH_TOOL])
  assert.deepEqual(Object.keys(byName.get(LEAD_PROJECT_TREE_TOOL)!.properties).sort(), ['limit', 'offset', 'path', 'recursive', 'ref'])
  assert.deepEqual(Object.keys(byName.get(LEAD_PROJECT_READ_TOOL)!.properties).sort(), ['limit', 'offset', 'path', 'ref'])
  assert.deepEqual(Object.keys(byName.get(LEAD_PROJECT_SEARCH_TOOL)!.properties).sort(), ['limit', 'offset', 'path', 'ref', 'text'])
  assert.deepEqual([byName.get(LEAD_PROJECT_TREE_TOOL)!.required, byName.get(LEAD_PROJECT_READ_TOOL)!.required, byName.get(LEAD_PROJECT_SEARCH_TOOL)!.required], [undefined, ['path'], ['text']])
  for (const schema of byName.values()) assert.equal(schema.additionalProperties, false)
  for (const tool of PROJECT_VIEW_TOOLS) assert.match(tool.description, /Read-only/)
})

// ---- in the lead service ----------------------------------------------------------------------

/** Captures the project tools of each turn's grant, so a test can call a handler the way the HTTP server would. */
class CapturingTools extends LeadToolServer {
  readonly captured: { context: ToolGrantContext; extra: readonly ExtraTool[]; handler: ToolHandler }[] = []
  override grant(...args: Parameters<LeadToolServer['grant']>) { this.captured.push({ context: args[0], handler: args[1], extra: args[2] ?? [] }); return super.grant(...args) }
}
type Answer = { kind: 'result'; text: string; isError?: boolean } | { kind: 'hold' }
/** A lead whose turn stays open (the fixture agent hangs), with the project view over `repo`. */
async function openTurn(t: TestContext, repo: Repo, options: { roots?: (id: string, signal: AbortSignal) => Promise<readonly string[]>; policy?: Partial<ProjectViewPolicy>; projectView?: boolean } = {}) {
  const tools = new CapturingTools()
  t.after(() => tools.close())
  const projectView = options.projectView === false ? {} : { projectView: { roots: options.roots ?? (async () => [repo.dir]), ...(options.policy ? { policy: options.policy } : {}) } }
  const f = await leadFixture(t, { lead: { hang: true }, plugin: { tools, ...projectView } })
  const started = f.start()
  for (let i = 0; i < 400 && tools.captured.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(tools.captured.length, 1, 'the lead turn began')
  const grant = tools.captured[0]!
  const notes = () => f.kernel.sessionLog!.readAll(started.runId, 'person').filter(e => e.type === 'agent.note')
    .map(e => (JSON.parse((e.data as { text: string }).text) as { lead?: Record<string, unknown> }).lead).filter(note => note?.action === 'project_view') as Record<string, unknown>[]
  const call = async (name: string, input: unknown, context: ToolGrantContext = grant.context): Promise<Answer> => {
    const extra = grant.extra.find(tool => tool.definition.name === name)
    assert.ok(extra, `${name} is on the grant`)
    return extra.handler(input, context)
  }
  let finished: Promise<unknown> | null = null
  // Idempotent, and registered for teardown: a failed assertion must not leave a hung lead turn holding the process open.
  const finish = () => finished ??= (async () => { f.lead().cancel(started.runId); await started.first })()
  t.after(finish)
  return { f, started, grant, tools, notes, call, finish }
}

test('the lead gets the project tools only when the host configured a view, and the delegate description points at them', async t => {
  const repo = await makeRepo(t)
  const on = await openTurn(t, repo)
  assert.deepEqual(on.grant.extra.map(tool => tool.definition.name), [LEAD_PROJECT_TREE_TOOL, LEAD_PROJECT_READ_TOOL, LEAD_PROJECT_SEARCH_TOOL])
  const url = await on.tools.url()
  const listed = await (await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    headers: { 'content-type': 'application/json', Authorization: (await tokenOf(on)) } })).json() as any
  assert.deepEqual(listed.result.tools.map((tool: any) => tool.name), ['guanxi_delegate', LEAD_PROJECT_TREE_TOOL, LEAD_PROJECT_READ_TOOL, LEAD_PROJECT_SEARCH_TOOL])
  assert.match(listed.result.tools[0].description, /guanxi_project_tree, guanxi_project_read, guanxi_project_search \(read-only\); the commit they report is a valid plan\.base/)
  await on.finish()
  const off = await openTurn(t, repo, { projectView: false })
  assert.deepEqual(off.grant.extra, [])
  await off.finish()
})
const tokenOf = async (turn: { tools: CapturingTools }): Promise<string> => {
  // The grant token is only known to the server and the agent; a second grant of the same handlers gives the test one of its own.
  const grant = turn.tools.captured[0]!
  const own = turn.tools.grant(grant.context, grant.handler, grant.extra)
  return own.header.value
}

test('a project call is served from the project of the stored lead session and audited without any file text', async t => {
  const repo = await makeRepo(t)
  const roots: string[] = []
  const turn = await openTurn(t, repo, { roots: async id => { roots.push(id); return [repo.dir] } })
  const tree = await turn.call(LEAD_PROJECT_TREE_TOOL, { path: 'src' })
  assert.equal(tree.kind === 'result' && tree.isError, undefined)
  const read = await turn.call(LEAD_PROJECT_READ_TOOL, { path: 'src/money.ts' })
  assert.ok(read.kind === 'result' && read.text.includes('Math.round'))
  const search = await turn.call(LEAD_PROJECT_SEARCH_TOOL, { text: 'Math.round' })
  assert.ok(search.kind === 'result' && search.text.includes('src/money.ts'))
  const denied = await turn.call(LEAD_PROJECT_READ_TOOL, { path: '.env' })
  assert.deepEqual(denied, { kind: 'result', isError: true, text: 'path_denied' })
  const traversal = await turn.call(LEAD_PROJECT_READ_TOOL, { path: '../outside/private.txt' })
  assert.deepEqual(traversal, { kind: 'result', isError: true, text: 'path_invalid' })
  assert.deepEqual(roots, ['p', 'p', 'p', 'p', 'p'], 'the project is the lead session\'s, never the input\'s')
  const notes = turn.notes()
  assert.deepEqual(notes.map(note => [note.tool, note.outcome]), [[LEAD_PROJECT_TREE_TOOL, 'ok'], [LEAD_PROJECT_READ_TOOL, 'ok'], [LEAD_PROJECT_SEARCH_TOOL, 'ok'],
    [LEAD_PROJECT_READ_TOOL, 'path_denied'], [LEAD_PROJECT_READ_TOOL, 'path_invalid']])
  assert.equal(notes[1]!.path, 'src/money.ts'); assert.equal(notes[1]!.commit, repo.head); assert.ok(Number(notes[1]!.bytes) > 0)
  assert.equal(notes[2]!.queryChars, 'Math.round'.length)
  assert.equal(notes[3]!.path, null, 'a refused call records the code, not the path it was refused for')
  const raw = JSON.stringify(notes)
  for (const leak of ['Math.round', 'négatifs', ENV_MARKER, OUTSIDE_MARKER]) assert.equal(raw.includes(leak), false, `the audit carries no ${leak}`)
  await turn.finish()
})

test('an unknown task, a foreign attempt and a lead without a project are refused with a fixed code and are not attributed to the real run', async t => {
  const repo = await makeRepo(t)
  const turn = await openTurn(t, repo, { roots: async () => [] })
  const ghost = { ...turn.grant.context, runId: 'no-such-run' }
  assert.deepEqual(await turn.call(LEAD_PROJECT_TREE_TOOL, {}, ghost), { kind: 'result', isError: true, text: 'lead_not_found' })
  assert.deepEqual(await turn.call(LEAD_PROJECT_TREE_TOOL, {}, { ...turn.grant.context, attemptId: 'someone-elses' }), { kind: 'result', isError: true, text: 'lead_not_found' })
  assert.deepEqual(turn.notes(), [], 'no audit row for a call that belongs to no lead turn')
  assert.deepEqual(await turn.call(LEAD_PROJECT_TREE_TOOL, {}), { kind: 'result', isError: true, text: 'project_view_unavailable' })
  assert.deepEqual(turn.notes().map(note => note.outcome), ['project_view_unavailable'])
  await turn.finish()
})

test('a failure of the root resolver or of the filesystem never leaks a path or a message', async t => {
  const repo = await makeRepo(t)
  const turn = await openTurn(t, repo, { roots: async () => { throw Object.assign(new Error('ENOENT /Users/owner/private/project'), { code: 'ENOENT' }) } })
  const answer = await turn.call(LEAD_PROJECT_TREE_TOOL, {})
  assert.deepEqual(answer, { kind: 'result', isError: true, text: 'project_view_unavailable' })
  await turn.finish()
})

test('content is not served when the call cannot be audited (the turn is no longer the fenced attempt)', async t => {
  const repo = await makeRepo(t)
  const turn = await openTurn(t, repo)
  const during = await turn.call(LEAD_PROJECT_READ_TOOL, { path: 'README.md' })
  assert.ok(during.kind === 'result' && during.text.includes('# Ledger'))
  await turn.finish()
  const after = await turn.call(LEAD_PROJECT_READ_TOOL, { path: 'README.md' })
  assert.ok(after.kind === 'result' && after.isError === true)
  assert.equal(after.text.includes('Ledger'), false, 'the file text stays behind')
  assert.match(after.text, /^[a-z_]+$/, 'a fixed code')
})

test('project calls of one turn run one at a time', async t => {
  const repo = await makeRepo(t)
  let running = 0, peak = 0
  const turn = await openTurn(t, repo, { roots: async () => { running++; peak = Math.max(peak, running); await new Promise(resolve => setTimeout(resolve, 40)); running--; return [repo.dir] } })
  const answers = await Promise.all([1, 2, 3, 4].map(() => turn.call(LEAD_PROJECT_TREE_TOOL, {})))
  assert.equal(answers.every(answer => answer.kind === 'result' && answer.isError === undefined), true)
  assert.equal(peak, 1)
  assert.equal(turn.notes().length, 4)
  await turn.finish()
})

test('end to end: the lead reads the project over the loopback tool server before it delegates', async t => {
  const repo = await makeRepo(t)
  const tools = new CapturingTools()
  t.after(() => tools.close())
  const calls = [{ name: LEAD_PROJECT_TREE_TOOL, arguments: { path: 'src' } }, { name: LEAD_PROJECT_READ_TOOL, arguments: { path: 'src/money.ts' } },
    { name: LEAD_PROJECT_READ_TOOL, arguments: { path: '.env' } }, { name: LEAD_PROJECT_SEARCH_TOOL, arguments: { text: 'inner' } },
    { name: LEAD_PROJECT_TREE_TOOL, arguments: { path: '../' } }, { name: LEAD_PROJECT_TREE_TOOL, arguments: { bogus: true } }]
  const f = await leadFixture(t, { lead: { briefs: [brief({ plan: { ...brief().plan, base: repo.head } })], projectCalls: calls }, plugin: { tools, projectView: { roots: async () => [repo.dir] } } })
  const { first } = f.start()
  assert.equal((await first).outcome, 'hibernated', 'reading the project does not stop the lead from delegating')
  const events = await f.events()
  assert.deepEqual(events.find(e => e.event === 'tool_list')!.tools, ['guanxi_delegate', LEAD_PROJECT_TREE_TOOL, LEAD_PROJECT_READ_TOOL, LEAD_PROJECT_SEARCH_TOOL])
  const answers = events.filter(e => e.event === 'project_answer')
  assert.equal(answers.length, 6)
  assert.equal(JSON.parse(answers[0]!.text).entries.length, 2)
  assert.match(JSON.parse(answers[1]!.text).text, /Math\.round/)
  assert.deepEqual([answers[2]!.isError, answers[2]!.text], [true, 'path_denied'])
  assert.equal(JSON.parse(answers[3]!.text).matches[0].path, 'src/deep/inner.ts')
  assert.deepEqual([answers[4]!.isError, answers[4]!.text], [true, 'path_invalid'])
  assert.match(String(answers[5]!.text), /^invalid_input: \(root\): Unrecognized key/)
  assert.equal(JSON.stringify(answers).includes(ENV_MARKER), false)
  assert.equal(f.children.launches[0]!.brief.plan.base, repo.head, 'the commit the tools reported is the plan base the relay will clone')
})
