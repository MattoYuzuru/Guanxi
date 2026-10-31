import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { LEAD_PROJECT_READ_TOOL, LEAD_PROJECT_SEARCH_TOOL, LEAD_PROJECT_TREE_TOOL } from '@guanxi/contract'
import { SecretScrubber } from '../../src/egress/scrubber.ts'
import { DEFAULT_PROJECT_VIEW_POLICY, PROJECT_VIEW_TOOLS, ProjectView, ProjectViewError, deniedPath, type ProjectViewPolicy } from '../../src/leads/project-view.ts'
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
async function makeRepo(t: TestContext, files: Record<string, string | Buffer> = {}, links: Record<string, string> = {}, options: { plain?: boolean } = {}): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), 'guanxi-pview-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'repo'), outside = join(root, 'outside')
  await mkdir(dir); await mkdir(outside)
  await writeFile(join(outside, 'private.txt'), `${OUTSIDE_MARKER}\n`)
  git(dir, 'init', '-q', '-b', 'main')
  const base: Record<string, string | Buffer> = {
    'README.md': '# Ledger\nsee src/money.ts\n',
    'src/money.ts': 'export const cents = (x: number) => Math.round(x * 100)\n// TODO: handle négatifs — émoji 🙂\n',
    'src/deep/inner.ts': 'export const inner = 1\n',
    'test/money.test.ts': "import { cents } from '../src/money.ts'\n",
    '.env': `API_TOKEN=${ENV_MARKER}\n`, 'config/.env.local': `LOCAL=${ENV_MARKER}\n`, '.ENV.production': `PROD=${ENV_MARKER}\n`,
    'keys/id_rsa': `-----BEGIN-----\n${ENV_MARKER}\n`, 'certs/server.pem': `${ENV_MARKER}\n`, '.ssh/config': `Host ${ENV_MARKER}\n`,
  }
  // `plain`: none of the base hidden files, so a test can compare a repository with hidden files against the same one without.
  if (options.plain) for (const name of Object.keys(base)) if (deniedPath(name)) delete base[name]
  const all = { ...base, ...files }
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
  // The bounds report grew by the path bound (review L4: it now comes from the policy and is reported).
  assert.deepEqual(root.bounds, { limit: 200, defaultLimit: 200, maxLimit: 2_000, maxResultBytes: 262_144, maxPathBytes: 4_096 })
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
  // Review H1: a search says nothing about hidden paths. The earlier assertion pinned `withheld: 6` here, which was an oracle on their content.
  assert.equal('withheld' in found, false)
  assert.equal(found.note, 'Paths hidden by policy are never searched.')
  assert.equal(JSON.stringify([top, all, found]).includes(ENV_MARKER), false)
  // The name rule itself.
  for (const name of ['.env', 'a/.env.local', '.git/config', 'x/node_modules/y', '.npmrc', '.aws/credentials', 'id_ed25519', 'ID_RSA.pub', 'credentials.json', 'client_secret_1.json', 'a/b.PEM', 'tls.key', 'terraform.tfstate', 'x.tfvars', '.netrc', '.git-credentials']) {
    assert.equal(deniedPath(name), true, name)
  }
  for (const name of ['README.md', 'src/environment.ts', 'src/keys.ts', 'src/ui/index.ts', 'docs/env.md', 'monkey.ts']) assert.equal(deniedPath(name), false, name)
})

test('the name policy covers each credential class (review M4) and does not hide ordinary code', async t => {
  const classes: Record<string, string[]> = {
    'secret data files': ['secrets.json', 'config/secret.yaml', 'SECRETS.YML', 'secrets.toml', 'secrets.properties', 'prod.secrets', 'secrets/db.txt', '.secrets/x', 'secret'],
    'service accounts': ['service-account.json', 'gcp/my-service_account-prod.json', 'serviceaccount.json'],
    'terraform': ['terraform.tfstate.backup', 'x/terraform.tfstate.1', 'prod.tfvars', 'prod.tfvars.json', 'terraform.tfstate'],
    'private keys': ['AuthKey_ABC.p8', 'putty.ppk', 'backup.gpg', 'key.asc', 'x.pgp', 'a.jceks', 'a.keystore', 'deploy.key', 'tls.pem', 'cert.p12', 'cert.pfx'],
    'tokens, vpn and cli credentials': ['.token', 'api.token', '.firebaserc', '.firebase', 'corp.ovpn', '.config/gh/hosts.yml'],
    'tool credentials': ['.s3cfg', '.boto', '.dockercfg', '.docker/config.json', '.vault-token', '.vault_pass', '.vault', '.azure/accessTokens.json', '.gcloud/x', '.kube/config', 'kubeconfig', 'prod.kubeconfig',
      '.npmrc', '.yarnrc.yml', '.pypirc', '.pgpass', '.htpasswd', '.netrc', '_netrc', '.terraformrc', 'terraform.rc', '.git-credentials', '.ssh/id_rsa'],
  }
  const repo = await makeRepo(t, { 'src/secrets.ts': 'export const store = 1\n', 'src/service.ts': 'export const s = 1\n', 'src/secret-santa.md': 'hi\n', 'src/keyboard.ts': 'k\n' })
  const { view } = makeView()
  for (const [kind, names] of Object.entries(classes)) {
    for (const name of names) {
      assert.equal(deniedPath(name), true, `${kind}: ${name}`)
      assert.equal(await code(view.read(repo.dir, { path: name })), 'path_denied', `${kind}: ${name}`)
    }
  }
  for (const name of ['src/secrets.ts', 'src/service.ts', 'src/secret-santa.md', 'src/keyboard.ts', 'src/serviceAccount.ts', 'docs/key.md']) assert.equal(deniedPath(name), false, name)
  assert.match((await json(view.read(repo.dir, { path: 'src/secrets.ts' }))).text, /store/)
  // Committed files of every class are omitted from the listing and counted, never named.
  const files: Record<string, string> = {}
  for (const name of Object.values(classes).flat().filter(name => !name.includes('/'))) files[`classes/${name}`] = ENV_MARKER + '\n'
  const withClasses = await makeRepo(t, files)
  const listed = await json(view.tree(withClasses.dir, { path: 'classes' }))
  assert.deepEqual([listed.entries.length, listed.withheld], [0, Object.keys(files).length])
  assert.ok(listed.withheld >= 30, `most class names are hidden (${listed.withheld})`)
  assert.equal(JSON.stringify(listed).includes(ENV_MARKER), false)
  assert.deepEqual((await json(view.search(withClasses.dir, { text: ENV_MARKER }))).matches, [])
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

test('a read page that would exceed the result bound is shortened, ends on a boundary and the cursor continues from there', async t => {
  const text = '"\n'.repeat(400)
  const repo = await makeRepo(t, { 'docs/escaped.txt': text })
  const { view } = makeView({ pageBytes: 800, maxPageBytes: 800, maxResultBytes: 1_000 })
  let offset: number | null = 0, assembled = '', pages = 0
  while (offset !== null) {
    const result: { text: string } = await view.read(repo.dir, { path: 'docs/escaped.txt', offset })
    assert.ok(Buffer.byteLength(result.text) <= 1_000, 'the serialized result stays inside the bound')
    const page: Record<string, any> = JSON.parse(result.text)
    assert.ok(page.text.length > 0 && page.text.length < 800, 'shortened below the asked page')
    assert.equal(page.more, true === (page.nextOffset !== null))
    assembled += page.text; offset = page.nextOffset; pages++
    assert.ok(pages < 100)
  }
  assert.equal(assembled, text); assert.ok(pages > 1)
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

test('a path is a literal name for every tool: glob and pathspec magic never widen a search', async t => {
  const repo = await makeRepo(t, { 'glob/a*b.txt': 'needle2 star\n', 'glob/aXb.txt': 'needle2 x\n', 'glob/:(top)README.md': 'needle2 magic\n' })
  const { view } = makeView()
  assert.deepEqual((await json(view.search(repo.dir, { text: 'needle2', path: 'glob/a*b.txt' }))).matches.map((match: any) => match.path), ['glob/a*b.txt'])
  assert.deepEqual((await json(view.search(repo.dir, { text: 'needle2', path: 'glob/:(top)README.md' }))).matches.map((match: any) => match.path), ['glob/:(top)README.md'])
  assert.equal((await json(view.search(repo.dir, { text: 'needle2', path: 'glob' }))).matches.length, 3)
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
  assert.deepEqual(Object.keys(byName.get(LEAD_PROJECT_TREE_TOOL)!.properties).sort(), ['cursor', 'limit', 'offset', 'path', 'recursive', 'ref'])
  assert.deepEqual(Object.keys(byName.get(LEAD_PROJECT_READ_TOOL)!.properties).sort(), ['cursor', 'limit', 'offset', 'path', 'ref'])
  assert.deepEqual(Object.keys(byName.get(LEAD_PROJECT_SEARCH_TOOL)!.properties).sort(), ['cursor', 'limit', 'offset', 'path', 'ref', 'text'])
  assert.deepEqual([byName.get(LEAD_PROJECT_TREE_TOOL)!.required, byName.get(LEAD_PROJECT_READ_TOOL)!.required, byName.get(LEAD_PROJECT_SEARCH_TOOL)!.required], [undefined, ['path'], ['text']])
  for (const schema of byName.values()) assert.equal(schema.additionalProperties, false)
  for (const tool of PROJECT_VIEW_TOOLS) assert.match(tool.description, /Read-only/)
})

// ---- review fixes -----------------------------------------------------------------------------

test('H1: the content of a hidden file cannot change any field of a search (no oracle on a committed secret)', async t => {
  const outputs = new Map<string, string[]>()
  for (const secret of ['hunter2-database-password', 'xylophone-database-password']) {
    const repo = await makeRepo(t, { '.env': `DB_PASSWORD=${secret}\n`, 'config/.env.production': `TOKEN=${secret}\n`, 'keys/id_rsa': `${secret}\n`, 'src/note.ts': 'const note = "visible"\n' })
    const { view } = makeView()
    for (const text of ['h', 'x', 'hunter2', 'xylophone', 'DB_PASSWORD', 'database-password', 'visible', '=']) {
      const out = JSON.parse((await view.search(repo.dir, { text })).text)
      assert.equal(out.commit, repo.head)
      out.commit = 'normalised'
      outputs.set(text, [...(outputs.get(text) ?? []), JSON.stringify(out)])
      assert.equal(JSON.stringify(out).includes(secret.slice(0, 6)), false)
    }
  }
  for (const [text, [a, b]] of outputs) assert.equal(a, b, `search ${JSON.stringify(text)}: every output field is the same whatever the hidden files hold`)
  for (const text of ['hunter2', 'xylophone', 'DB_PASSWORD']) {
    const sample = JSON.parse(outputs.get(text)![0]!)
    assert.deepEqual(sample.matches, [], text); assert.equal('withheld' in sample, false)
  }
  assert.equal(JSON.parse(outputs.get('visible')![0]!).matches.length, 1)
})

test('a search runs over the scrubbed text: a registered secret (also a multi-line one) is neither found nor leaked line by line', async t => {
  const pem = 'PEMLINE-aaaaaaaa\nPEMLINE-bbbbbbbb\nPEMLINE-cccccccc'
  const repo = await makeRepo(t, { 'src/cert.txt': `before\n${pem}\nafter\n`, 'src/config.ts': `const key = '${REGISTERED}'\n` })
  const scrubber = new SecretScrubber()
  scrubber.register('secret://test/registered', REGISTERED)
  scrubber.register('secret://test/pem', pem)
  const view = new ProjectView({ scrubber })
  for (const text of ['PEMLINE-bbbbbbbb', 'PEMLINE', 'PEMLINE-aaaaaaaa', REGISTERED, 'zz-registered-secret', '0123456789']) {
    const out = await json(view.search(repo.dir, { text }))
    assert.deepEqual(out.matches, [], `no match for a piece of a redacted value: ${text}`)
  }
  const around = await json(view.search(repo.dir, { text: 'before' }))
  assert.equal(around.matches[0].text, 'before')
  assert.equal(JSON.stringify(await json(view.search(repo.dir, { text: 'after' }))).includes('PEMLINE'), false)
  const key = await json(view.search(repo.dir, { text: 'const key' }))
  assert.equal(JSON.stringify(key).includes(REGISTERED.slice(0, 8)), false)
})

test('M1: a huge single-line blob is never buffered whole; a big allowed line is cut around the match and the figures say what was skipped', async t => {
  const repo = await makeRepo(t, { 'big/huge.txt': `needle${'h'.repeat(3_000_000)}`, 'big/long.txt': `${'a'.repeat(300_000)}needle${'b'.repeat(300_000)}`, 'big/binary.bin': Buffer.from([0, 1, 2]), 'big/small.txt': 'needle small\n' })
  const { view } = makeView({ maxFileBytes: 1_000_000, lineChars: 60 })
  const found = await json(view.search(repo.dir, { text: 'needle' }))
  assert.deepEqual(found.matches.map((match: any) => match.path).sort(), ['big/long.txt', 'big/small.txt'])
  const long = found.matches.find((match: any) => match.path === 'big/long.txt')
  assert.match(long.text, /^….*needle.*…\[line clipped, \d+ more characters\]$/)
  assert.ok(long.text.length < 200, 'the excerpt is bounded by lineChars, not by the line')
  // The fixture also holds 3 committed symlinks and 4 ordinary files; hidden files are in no figure.
  assert.equal(found.scan.skippedTooLarge, 1); assert.equal(found.scan.skippedNotText, 4); assert.equal(found.scan.files, 6); assert.equal(found.scan.complete, true)
  assert.equal(found.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(found)) < 2_000)
  assert.equal(await code(view.read(repo.dir, { path: 'big/huge.txt' })), 'file_too_large: size 3000006 bytes, limit 1000000')
  // A scan budget smaller than the allowed files is reported, not hidden.
  const budget = await json(makeView({ maxScanBytes: 100_000, maxFileBytes: 1_000_000 }).view.search(repo.dir, { text: 'needle' }))
  assert.equal(budget.scan.complete, false); assert.ok(budget.scan.unscanned >= 1); assert.equal(budget.truncated, true)
})

test('M2: repository-local configuration changes nothing (submodule recursion, filters, fsmonitor, attributes) and a gitlink is only listed', async t => {
  const marker = join(tmpdir(), `guanxi-pview-marker-${process.pid}-${Date.now()}`)
  const repo = await makeRepo(t, { '.gitattributes': '* filter=evil text=auto diff=evil\n', 'src/a.txt': 'needle in a\n' })
  git(repo.dir, 'update-index', '--add', '--cacheinfo', `160000,${repo.head},vendor/sub`)
  git(repo.dir, 'commit', '-q', '-m', 'gitlink')
  for (const [key, value] of Object.entries({ 'submodule.recurse': 'true', 'grep.recurseSubmodules': 'true', 'core.fsmonitor': `touch ${marker}-fsmonitor`, 'filter.evil.smudge': `touch ${marker}-smudge; cat`,
    'filter.evil.clean': `touch ${marker}-clean; cat`, 'diff.evil.textconv': `touch ${marker}-textconv; cat`, 'core.attributesFile': join(repo.dir, 'src/a.txt'), 'core.pager': `touch ${marker}-pager`,
    'core.hooksPath': repo.dir, 'protocol.ext.allow': 'always', 'core.untrackedCache': 'true' })) git(repo.dir, 'config', key, value)
  const { view } = makeView()
  const tree = await json(view.tree(repo.dir, { path: 'vendor' }))
  assert.deepEqual(tree.entries, [{ path: 'vendor/sub', type: 'submodule' }])
  assert.equal(await code(view.read(repo.dir, { path: 'vendor/sub' })), 'not_a_file')
  assert.equal((await json(view.search(repo.dir, { text: 'needle' }))).matches.length, 1)
  assert.match((await json(view.read(repo.dir, { path: 'src/a.txt' }))).text, /^needle in a/)
  const { readdirSync } = await import('node:fs')
  assert.deepEqual(readdirSync(tmpdir()).filter(name => name.startsWith(`guanxi-pview-marker-${process.pid}-`)), [], 'no configured command ran')
})

test('L1/L4: the path and text bounds come from the policy and are reported', async t => {
  const repo = await makeRepo(t)
  const { view } = makeView({ maxPathBytes: 20, maxTextChars: 5 })
  assert.equal(await code(view.read(repo.dir, { path: 'src/deep/inner.ts/xxxxxxxxxxxxx' })), 'path_invalid')
  assert.equal(await code(view.search(repo.dir, { text: 'abcdef' })), 'invalid_input: text: longer than 5 characters')
  const search = await json(view.search(repo.dir, { text: 'abcde' }))
  assert.equal(search.bounds.maxTextChars, 5); assert.equal(search.bounds.maxPathBytes, 20)
  assert.equal((await json(view.tree(repo.dir, {}))).bounds.maxPathBytes, 20)
  assert.equal((await json(view.read(repo.dir, { path: 'README.md' }))).bounds.maxPathBytes, 20)
  // A listing record longer than the path bound is dropped unread: counted as withheld in a tree, as skipped in a search, never buffered or named.
  const longName = `long/${'d'.repeat(200)}/${'e'.repeat(200)}/${'f'.repeat(200)}.txt`
  const odd = await makeRepo(t, { [longName]: 'needle\n', 'long/ok.txt': 'needle\n' })
  const listed = await json(view.tree(odd.dir, { path: 'long', recursive: true }))
  assert.deepEqual([listed.entries.map((entry: any) => entry.path), listed.withheld], [['long/ok.txt'], 1])
  const searched = await json(view.search(odd.dir, { text: 'need', path: 'long' }))
  // Review L1: a record that cannot be parsed (it may be a hidden path) is counted in no search figure.
  assert.deepEqual([searched.matches.map((match: any) => match.path), searched.scan.skippedNotText], [['long/ok.txt'], 0])
  assert.equal((await json(makeView().view.search(repo.dir, { text: 'x'.repeat(1_000) }))).bounds.maxTextChars, 1_000)
  assert.equal(await code(makeView().view.search(repo.dir, { text: 'x'.repeat(1_001) })), 'invalid_input: text: longer than 1000 characters')
})

test('L3: a git process that outlives the timeout or prints past the bound is ended with its own fixed code', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-pview-fakegit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const repo = await makeRepo(t)
  const slow = join(dir, 'slow-git'), loud = join(dir, 'loud-git')
  await writeFile(slow, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 })
  await writeFile(loud, "#!/bin/sh\nexec head -c 200000 /dev/zero\n", { mode: 0o755 })
  const scrubber = new SecretScrubber()
  const started = Date.now()
  assert.equal(await code(new ProjectView({ scrubber, git: slow, policy: { timeoutMs: 300 } }).tree(repo.dir, {})), 'project_view_timeout')
  assert.ok(Date.now() - started < 5_000, 'the call returns at the timeout, not when the process ends')
  assert.equal(await code(new ProjectView({ scrubber, git: loud }).tree(repo.dir, {})), 'project_view_output_limit')
  assert.equal(await code(new ProjectView({ scrubber, git: join(dir, 'absent') }).tree(repo.dir, {})), 'project_view_unavailable')
})

test('L5/L7: a cursor keeps the commit of the first page while HEAD moves; names with newlines and odd bytes are listed and searched exactly', async t => {
  const files: Record<string, string> = {}
  for (let i = 0; i < 12; i++) files[`pages/f${String(i).padStart(2, '0')}.txt`] = `needle ${i}\n`
  files['pages/line\nbreak.txt'] = 'needle with newline name\n'
  files['pages/tab\tname é.txt'] = 'needle tab\n'
  const repo = await makeRepo(t, files)
  const { view } = makeView()
  const first = await json(view.tree(repo.dir, { path: 'pages', limit: 5 }))
  assert.equal(first.nextCursor, `${repo.head}:5`)
  const search1 = await json(view.search(repo.dir, { text: 'needle', limit: 5 }))
  const read1 = await json(view.read(repo.dir, { path: 'pages/f00.txt', limit: 3 }))
  assert.equal(search1.nextCursor, `${repo.head}:5`); assert.equal(read1.nextCursor, `${repo.head}:3`)
  // HEAD moves: a file sorting before every other entry appears.
  await writeFile(join(repo.dir, 'pages/aaa-new.txt'), 'needle newest\n')
  await writeFile(join(repo.dir, 'pages/f00.txt'), 'changed\n')
  const moved = repo.commit('moves HEAD')
  const seen = [...first.entries.map((entry: any) => entry.path)]
  for (let next: string | null = first.nextCursor; next;) {
    const page: Record<string, any> = await json(view.tree(repo.dir, { path: 'pages', cursor: next }))
    assert.equal(page.commit, repo.head, 'the continuation stays on the first page\'s commit')
    seen.push(...page.entries.map((entry: any) => entry.path)); next = page.nextCursor
  }
  assert.equal(seen.length, 14); assert.equal(new Set(seen).size, 14, 'no gap and no duplicate')
  assert.ok(seen.includes('pages/line\nbreak.txt') && seen.includes('pages/tab\tname é.txt'), 'names are exact')
  const hits: string[] = search1.matches.map((match: any) => match.path)
  for (let next: string | null = search1.nextCursor; next;) {
    const page: Record<string, any> = await json(view.search(repo.dir, { text: 'needle', cursor: next, limit: 5 }))
    assert.equal(page.commit, repo.head)
    hits.push(...page.matches.map((match: any) => match.path)); next = page.nextCursor
  }
  assert.equal(hits.length, 14); assert.equal(new Set(hits).size, 14)
  assert.ok(hits.includes('pages/line\nbreak.txt'))
  const rest = await json(view.read(repo.dir, { path: 'pages/f00.txt', cursor: read1.nextCursor }))
  assert.equal(rest.commit, repo.head); assert.equal(read1.text + rest.text, 'needle 0\n')
  // Without a cursor the moved HEAD is what a plain request sees.
  assert.equal((await json(view.tree(repo.dir, { path: 'pages' }))).commit, moved)
  // A cursor is exclusive with ref/offset, must be one this tool issues and must name a commit that exists.
  for (const bad of [{ cursor: first.nextCursor, ref: repo.head }, { cursor: first.nextCursor, offset: 1 }, { cursor: 'nonsense' }, { cursor: `${repo.head}:-1` }, { cursor: `HEAD:5` }]) {
    assert.match(await code(view.tree(repo.dir, bad)), /^invalid_input: cursor:/, JSON.stringify(bad))
  }
  assert.equal(await code(view.tree(repo.dir, { cursor: `${'e'.repeat(40)}:0` })), 'ref_not_found')
})

// ---- review round 2 ---------------------------------------------------------------------------

const waitFor = async (what: () => boolean, ms = 10_000) => { for (let waited = 0; !what() && waited < ms; waited += 20) await new Promise(resolve => setTimeout(resolve, 20)); return what() }
const gone = (pid: number) => { try { process.kill(pid, 0); return false } catch { return true } }
/** A `git` stand-in: a shell script, or a node script that runs the real git and rewrites what `cat-file --batch` prints. */
async function stand(t: TestContext, name: string, source: string, shell = true): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-pview-stand-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, name)
  await writeFile(file, `#!${shell ? '/bin/sh' : process.execPath}\n${source}`, { mode: 0o755 })
  return file
}
const hang = (t: TestContext, pidFile: string) => stand(t, 'hang-git', `echo $$ > ${pidFile}\nexec sleep 30\n`)
const batchStand = (t: TestContext, rewrite: string) => stand(t, 'batch-git.mjs', `import { spawn, spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
if (!(args.includes('cat-file') && args.includes('--batch'))) { const r = spawnSync('/usr/bin/git', args, { stdio: 'inherit' }); process.exit(r.status ?? 1) }
const child = spawn('/usr/bin/git', args, { stdio: ['inherit', 'pipe', 'inherit'] })
const chunks = []
child.stdout.on('data', c => chunks.push(c))
child.on('close', async () => { const out = Buffer.concat(chunks); ${rewrite} })
`, false)

test('review M1: a partial clone with a missing blob never runs the repository\'s transport command or fetches; read and search fail with fixed answers', async t => {
  const source = await makeRepo(t, { 'f.txt': 'needle here\n' }, {}, { plain: true })
  git(source.dir, 'config', 'uploadpack.allowFilter', 'true'); git(source.dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
  const parent = await mkdtemp(join(tmpdir(), 'guanxi-pview-clone-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const clone = join(parent, 'clone'), marker = join(parent, 'MARK')
  execFileSync(GIT, ['clone', '-q', '--no-checkout', '--filter=blob:none', `file://${source.dir}`, clone], { env })
  git(clone, 'config', 'remote.origin.url', 'ssh://nohost.invalid/repo'); git(clone, 'config', 'core.sshCommand', `touch ${marker}; false #`)
  const { view } = makeView()
  const tree = await json(view.tree(clone, { path: '' }))
  assert.ok(tree.entries.some((entry: any) => entry.path === 'f.txt' && entry.type === 'file' && entry.size === undefined), 'listed, size unknown')
  assert.equal(await code(view.read(clone, { path: 'f.txt' })), 'project_view_unavailable')
  const found = await json(view.search(clone, { text: 'needle' }))
  assert.deepEqual(found.matches, []); assert.equal(found.scan.files, 0)
  assert.equal(existsSync(marker), false, 'no transport command ran')
  // Control: with lazy fetching allowed the same configuration does run the command, so the assertions above prove something.
  assert.throws(() => execFileSync(GIT, ['cat-file', 'blob', 'HEAD:f.txt'], { cwd: clone, env, stdio: 'pipe' }))
  assert.equal(existsSync(marker), true)
})

test('review M2: nothing about a hidden file (size, emptiness, binary, symlink, count, long path) reaches any field of a search', async t => {
  const policy = { maxFileBytes: 1_000, maxPathBytes: 40 }
  const visible = { 'src/a.ts': 'needle a\n', 'src/b.ts': 'needle b\n', 'docs/big.txt': 'x'.repeat(2_000), 'docs/bin.dat': Buffer.from([0, 1]), 'docs/empty.txt': '' }
  const search = async (hidden: Record<string, string | Buffer>, links: Record<string, string> = {}) => {
    const repo = await makeRepo(t, { ...visible, ...hidden }, links, { plain: true })
    const out = JSON.parse((await makeView(policy).view.search(repo.dir, { text: 'needle' })).text)
    out.commit = 'normalised'
    return JSON.stringify(out)
  }
  const baseline = await search({})
  assert.equal(JSON.parse(baseline).matches.length, 2)
  assert.equal(JSON.parse(baseline).scan.skippedTooLarge, 1)
  const deep = `.ssh/${'d'.repeat(200)}/${'e'.repeat(200)}/${'f'.repeat(200)}`
  const variants: Record<string, [Record<string, string | Buffer>, Record<string, string>?]> = {
    'above maxFileBytes': [{ '.env': 'x'.repeat(5_000) }],
    'empty': [{ '.env': '' }],
    'binary': [{ '.env': Buffer.from([0, 1, 2]) }],
    'a symlink': [{}, { '.env.local': '/etc/hosts' }],
    'more hidden files': [{ '.env': 'a', '.ssh/id': 'b', 'secrets.json': 'c', 'keys/id_rsa': 'd', 'certs/x.pem': 'e' }],
    'a record over the path bound': [{ [deep]: 'a' }],
    'all of them': [{ '.env': 'x'.repeat(5_000), '.ssh/id': '', 'keys/id_rsa': Buffer.from([0]), [deep]: 'needle' }, { '.env.local': '/etc/hosts' }],
  }
  for (const [name, [hidden, links]] of Object.entries(variants)) assert.equal(await search(hidden, links), baseline, `hidden: ${name}`)
})

test('review L2/L3: a stuck git process is killed at the timeout, on abort and on close, and a lying cat-file is refused', async t => {
  const repo = await makeRepo(t, { 'src/a.ts': 'needle a\n', 'src/b.ts': 'needle b\n' }, {}, { plain: true })
  const scrubber = new SecretScrubber()
  const pidDir = await mkdtemp(join(tmpdir(), 'guanxi-pview-pid-'))
  t.after(() => rm(pidDir, { recursive: true, force: true }))
  const pidFile = join(pidDir, 'pid')
  const pidOf = async () => { assert.ok(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== ''), 'the process started'); const pid = Number(readFileSync(pidFile, 'utf8')); await rm(pidFile); return pid }
  const hanging = await hang(t, pidFile)

  // timeout
  assert.equal(await code(new ProjectView({ scrubber, git: hanging, policy: { timeoutMs: 1_500 } }).tree(repo.dir, {})), 'project_view_timeout')
  const timedOut = await pidOf()
  assert.ok(await waitFor(() => gone(timedOut)), 'the timed-out process is gone')

  // abort
  const view = new ProjectView({ scrubber, git: hanging })
  const abort = new AbortController()
  const aborted = code(view.tree(repo.dir, {}, abort.signal))
  const abortedPid = await pidOf()
  abort.abort()
  assert.equal(await aborted, 'project_view_cancelled')
  assert.ok(await waitFor(() => gone(abortedPid)), 'the aborted process is gone')
  assert.equal(await code(view.tree(repo.dir, {}, abort.signal)), 'project_view_cancelled', 'an already aborted signal starts nothing')
  assert.equal(existsSync(pidFile), false)

  // close (the node's shutdown)
  const closing = code(view.read(repo.dir, { path: 'src/a.ts' }))
  const closingPid = await pidOf()
  view.close()
  assert.equal(await closing, 'project_view_cancelled')
  assert.ok(await waitFor(() => gone(closingPid)), 'close ends the running process')
  assert.equal(await code(view.tree(repo.dir, {})), 'project_view_cancelled', 'a closed view starts nothing')
  assert.equal(existsSync(pidFile), false)

  // cat-file --batch answers that disagree with ls-tree
  const via = async (rewrite: string) => new ProjectView({ scrubber, git: await batchStand(t, rewrite) })
  const honest = await json((await via('process.stdout.write(out)')).search(repo.dir, { text: 'needle' }))
  assert.equal(honest.matches.length, 2)
  const split = await json((await via('for (const byte of out) { process.stdout.write(Buffer.from([byte])); await new Promise(r => setImmediate(r)) }')).search(repo.dir, { text: 'needle' }))
  assert.deepEqual(split.matches, honest.matches, 'a frame split at every byte is read the same')
  const lies: Record<string, string> = {
    'a size that disagrees with ls-tree': "process.stdout.write(Buffer.from(out.toString('latin1').replace(/^([a-f0-9]+ blob )(\\d+)/, (m, a, b) => a + (Number(b) + 1)), 'latin1'))",
    'a missing object': "process.stdout.write('0000000000000000000000000000000000000000 missing\\n')",
    'trailing bytes': "process.stdout.write(Buffer.concat([out, Buffer.from('junk\\n')]))",
    'a truncated stream': 'process.stdout.write(out.subarray(0, out.length - 3))',
    // The byte after the first frame's body is not the newline git prints; every later header is still well formed.
    'a corrupted frame terminator': "const nl = out.indexOf(10); const size = Number(out.subarray(0, nl).toString().split(' ')[2]); const copy = Buffer.from(out); copy[nl + 1 + size] = 88; process.stdout.write(copy)",
    'no header newline': "process.stdout.write('a'.repeat(1000))",
  }
  for (const [what, rewrite] of Object.entries(lies)) assert.equal(await code((await via(rewrite)).search(repo.dir, { text: 'needle' })), 'project_view_unavailable', what)
})

test('review L4/L5: the scan budget keeps only what fits and counts the rest exactly; a long scan yields to the event loop; the default budget is 64 MiB', async t => {
  assert.equal(DEFAULT_PROJECT_VIEW_POLICY.maxScanBytes, 64 * 1_048_576)
  const files: Record<string, string> = {}
  for (let i = 0; i < 10; i++) files[`many/f${i}.txt`] = `needle ${'x'.repeat(92)}\n`
  const repo = await makeRepo(t, files, {}, { plain: true })
  const found = await json(makeView({ maxScanBytes: 450 }).view.search(repo.dir, { path: 'many', text: 'needle' }))
  assert.equal(found.matches.length, 4); assert.deepEqual([found.scan.files, found.scan.unscanned, found.scan.complete, found.truncated], [4, 6, false, true])
  assert.equal(found.bounds.maxScanBytes, 450)
  assert.equal((await json(makeView().view.search(repo.dir, { path: 'many', text: 'needle' }))).bounds.maxScanBytes, 67_108_864)

  const big = await makeRepo(t, { 'big/a.txt': `needle\n${'a'.repeat(3_500_000)}`, 'big/b.txt': `${'b'.repeat(3_500_000)}\nneedle\n`, 'big/c.txt': `needle\n${'c'.repeat(3_500_000)}` }, {}, { plain: true })
  const yields = t.mock.method(globalThis, 'setImmediate')
  const before = yields.mock.callCount()
  await json(makeView().view.search(repo.dir, { path: 'many', text: 'needle' }))
  const small = yields.mock.callCount() - before
  const found3 = await json(makeView().view.search(big.dir, { path: 'big', text: 'needle' }))
  const large = yields.mock.callCount() - before - small
  assert.deepEqual(found3.matches.map((match: any) => [match.path, match.line]), [['big/a.txt', 1], ['big/b.txt', 2], ['big/c.txt', 1]])
  assert.ok(large > small, `10.5 MB of blobs paused the process for the event loop (${large} vs ${small})`)
})

// ---- in the lead service ----------------------------------------------------------------------

/** Captures the project tools of each turn's grant, so a test can call a handler the way the HTTP server would. */
class CapturingTools extends LeadToolServer {
  readonly captured: { context: ToolGrantContext; extra: readonly ExtraTool[]; handler: ToolHandler }[] = []
  override grant(...args: Parameters<LeadToolServer['grant']>) { this.captured.push({ context: args[0], handler: args[1], extra: args[2] ?? [] }); return super.grant(...args) }
}
type Answer = { kind: 'result'; text: string; isError?: boolean } | { kind: 'hold' }
/** A lead whose turn stays open (the fixture agent hangs), with the project view over `repo`. */
async function openTurn(t: TestContext, repo: Repo, options: { roots?: (id: string, signal: AbortSignal) => Promise<readonly string[]>; policy?: Partial<ProjectViewPolicy>; projectView?: boolean; git?: string } = {}) {
  const tools = new CapturingTools()
  t.after(() => tools.close())
  const projectView = options.projectView === false ? {} : { projectView: { roots: options.roots ?? (async () => [repo.dir]), ...(options.policy ? { policy: options.policy } : {}), ...(options.git ? { git: options.git } : {}) } }
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
  const finish = () => finished ??= (async () => { f.lead()?.cancel(started.runId); await started.first.catch(() => undefined) })()
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
  // A project named in the input is not a field: it is refused, and the root still comes from the lead session.
  const foreign = await turn.call(LEAD_PROJECT_TREE_TOOL, { project: 'other-project', projectId: 'other-project', root: repo.outside })
  assert.ok(foreign.kind === 'result' && foreign.isError === true && foreign.text.startsWith('invalid_input: '))
  assert.deepEqual(roots, ['p', 'p', 'p', 'p', 'p', 'p'], 'the project is the lead session\'s, never the input\'s')
  const notes = turn.notes()
  assert.deepEqual(notes.map(note => [note.tool, note.outcome]), [[LEAD_PROJECT_TREE_TOOL, 'ok'], [LEAD_PROJECT_READ_TOOL, 'ok'], [LEAD_PROJECT_SEARCH_TOOL, 'ok'],
    [LEAD_PROJECT_READ_TOOL, 'path_denied'], [LEAD_PROJECT_READ_TOOL, 'path_invalid'], [LEAD_PROJECT_TREE_TOOL, 'invalid_input']])
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

test('L1: exactly one project root is a project the view can show (the relay requires the same)', async t => {
  const repo = await makeRepo(t)
  const none = await openTurn(t, repo, { roots: async () => [] })
  assert.deepEqual(await none.call(LEAD_PROJECT_TREE_TOOL, {}), { kind: 'result', isError: true, text: 'project_view_unavailable' })
  await none.finish()
  const two = await openTurn(t, repo, { roots: async () => [repo.dir, repo.outside] })
  assert.deepEqual(await two.call(LEAD_PROJECT_TREE_TOOL, {}), { kind: 'result', isError: true, text: 'project_view_unavailable' })
  assert.deepEqual(two.notes().map(note => note.outcome), ['project_view_unavailable'])
  await two.finish()
  const one = await openTurn(t, repo, { roots: async () => [repo.dir] })
  assert.ok((await one.call(LEAD_PROJECT_TREE_TOOL, {})).kind === 'result')
  await one.finish()
})

test('review L3: cancelling the lead ends the git process of a project call that is running', async t => {
  const repo = await makeRepo(t)
  const pidDir = await mkdtemp(join(tmpdir(), 'guanxi-pview-pid-'))
  t.after(() => rm(pidDir, { recursive: true, force: true }))
  const pidFile = join(pidDir, 'pid')
  const turn = await openTurn(t, repo, { git: await hang(t, pidFile) })
  const running = turn.call(LEAD_PROJECT_TREE_TOOL, {})
  assert.ok(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== ''), 'the project call started git')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.equal(gone(pid), false)
  await turn.finish()
  const answer = await running
  assert.ok(answer.kind === 'result' && answer.isError === true)
  assert.ok(await waitFor(() => gone(pid)), 'the process ended with the lead turn, not at the 15 s timeout')
})

test('review L3: shutting the lead service down ends the git process of a project call that is running', async t => {
  const repo = await makeRepo(t)
  const pidDir = await mkdtemp(join(tmpdir(), 'guanxi-pview-pid-'))
  t.after(() => rm(pidDir, { recursive: true, force: true }))
  const pidFile = join(pidDir, 'pid')
  const turn = await openTurn(t, repo, { git: await hang(t, pidFile) })
  const running = turn.call(LEAD_PROJECT_TREE_TOOL, {})
  assert.ok(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== ''))
  const pid = Number(readFileSync(pidFile, 'utf8'))
  await turn.f.restartLead()
  assert.ok(await waitFor(() => gone(pid)), 'closing the service killed the process, not the 15 s timeout')
  assert.ok((await running).kind === 'result')
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
