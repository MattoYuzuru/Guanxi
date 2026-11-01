import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { tasks } from './ci/tasks.mjs'
import { githubClient, localContext, publishRelease, releaseBundle, releaseContext, releaseRun, ReleaseError } from './release.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const input = () => ({ actions: 'true', eventName: 'push', ref: 'refs/tags/v0.1.0-alpha.1', version: '0.1.0-alpha.1',
  commit: 'a'.repeat(40), tree: 'b'.repeat(40), tagCommit: 'a'.repeat(40), repository: 'MattoYuzuru/Guanxi', runId: 42, runAttempt: 1, mainAncestor: true, clean: true })
const context = () => releaseContext(input())
const code = expected => error => error instanceof ReleaseError && error.code === expected
const clone = value => structuredClone(value)

async function files(t, ctx = context()) {
  const directory = await mkdtemp(join(tmpdir(), 'guanxi-release-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const assets = []
  for (const ext of ['dmg', 'zip']) {
    const name = `guanxi-desktop-${ctx.version}-arm64.${ext}`, bytes = Buffer.from(`${ext}: synthetic package bytes`)
    await writeFile(join(directory, name), bytes)
    assets.push({ name, size: bytes.length, sha256: hash(bytes) })
  }
  const evidence = { schema: 1, commit: ctx.commit, tree: ctx.tree, version: ctx.version, appId: 'io.github.mattoyuzuru.guanxi',
    architecture: 'arm64', signing: 'ad-hoc', notarized: false, assets }
  await writeFile(join(directory, 'package-evidence.json'), JSON.stringify(evidence) + '\n')
  await writeFile(join(directory, 'SHA256SUMS'), assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join(''))
  return { directory, evidence }
}
async function bundle(t, ctx = context()) {
  const fixture = await files(t, ctx), result = await releaseBundle(fixture.directory, ctx)
  t.after(() => result.close())
  return { ...fixture, ...result }
}

/** A stateful fake service: mutation success is visible to a later, separate publisher attempt. */
function github(ctx = context()) {
  const state = { requests: [], releases: [], assets: [], nextAsset: 1,
    jobs: ['plan', 'Full gate', ...tasks.map(task => `check / ${task.id}`)].map((name, index) => ({ id: index + 1, name, status: 'completed', conclusion: 'success', head_sha: ctx.commit, run_attempt: ctx.runAttempt })),
    artifacts: [{ id: 77, name: `macos-arm64-package-${ctx.runAttempt}`, expired: false, workflow_run: { id: ctx.runId, head_sha: ctx.commit } }],
    tag: { type: 'commit', sha: ctx.commit }, tags: {}, compare: { status: 'ahead', base_commit: { sha: ctx.commit } },
    run: { id: ctx.runId, run_attempt: ctx.runAttempt, event: 'push', head_sha: ctx.commit, repository: { full_name: ctx.repository }, path: '.github/workflows/full-gate.yml', status: 'in_progress', conclusion: null },
    before: undefined, after: undefined }
  const root = `/repos/${ctx.repository}`
  const api = async request => {
    const method = request.method ?? 'GET', url = new URL(request.path, 'https://api.github.com')
    state.requests.push({ method, path: request.path })
    const early = await state.before?.(request, state)
    if (early) return early
    const path = url.pathname
    const page = items => items.slice((Number(url.searchParams.get('page') ?? 1) - 1) * 100, Number(url.searchParams.get('page') ?? 1) * 100)
    let data, status = 200
    if (method === 'GET') {
      if (path === root) data = { full_name: ctx.repository, default_branch: 'main' }
      else if (path === `${root}/git/ref/tags/${ctx.tag}`) data = { object: state.tag }
      else if (path.startsWith(`${root}/git/tags/`)) data = { object: state.tags[path.split('/').at(-1)] }
      else if (path === `${root}/git/ref/heads/main`) data = { object: { type: 'commit', sha: 'c'.repeat(40) } }
      else if (path.startsWith(`${root}/compare/`)) data = state.compare
      else if (path === `${root}/actions/runs/${ctx.runId}`) data = state.run
      else if (path === `${root}/actions/runs/${ctx.runId}/jobs`) data = { jobs: page(state.jobs) }
      else if (path === `${root}/actions/runs/${ctx.runId}/artifacts`) data = { artifacts: page(state.artifacts) }
      else if (path === `${root}/releases`) data = page(state.releases)
      else if (path === `${root}/releases/501/assets`) data = page(state.assets)
      else if (path === `${root}/releases/501`) data = state.releases.find(item => item.id === 501)
      else throw new Error(`Unexpected fake read ${path}`)
    } else if (method === 'POST' && path === `${root}/releases`) {
      data = { id: 501, ...request.body, immutable: false }; state.releases.push(data); status = 201
    } else if (method === 'POST' && path === `${root}/releases/501/assets`) {
      const chunks = []
      for await (const bytes of request.asset.stream()) chunks.push(bytes)
      const bytes = Buffer.concat(chunks)
      data = { id: state.nextAsset++, name: url.searchParams.get('name'), size: bytes.length, digest: `sha256:${hash(bytes)}`, state: 'uploaded', content_type: request.asset.contentType }
      state.assets.push(data); status = 201
    } else if (method === 'PATCH' && path === `${root}/releases/501`) {
      const release = state.releases.find(item => item.id === 501)
      Object.assign(release, request.body, { immutable: true }); data = release
    } else throw new Error(`Unexpected fake write ${method} ${path}`)
    const response = { status, data: clone(data) }
    return await state.after?.(request, response, state) ?? response
  }
  return { state, api, mutations: () => state.requests.filter(request => request.method !== 'GET') }
}

test('release policy accepts matching version tags and refuses branch/PR/manual/forced/dirty/off-main sources', () => {
  assert.equal(context().tag, 'v0.1.0-alpha.1')
  for (const change of [value => { value.actions = 'false' }, value => { value.eventName = 'pull_request' }, value => { value.eventName = 'workflow_dispatch' },
    value => { value.ref = 'refs/heads/main' }, value => { value.forced = true }, value => { value.deleted = true },
    value => { value.version = '0.2.0' }, value => { value.ref = 'refs/tags/v01.0.0' }, value => { value.ref = 'refs/tags/v0.1.0-01' },
    value => { value.clean = false }, value => { value.mainAncestor = false }, value => { value.tagCommit = 'd'.repeat(40) },
    value => { value.commit = 'main' }, value => { value.tree = '' }, value => { value.repository = '../Guanxi' }, value => { value.runId = 0 }]) {
    const value = input(); change(value); assert.throws(() => releaseContext(value), ReleaseError)
  }
})

test('real local source verification peels an annotated tag and rejects a dirty, mismatched or off-main checkout', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'guanxi-release-git-')), event = join(directory, 'event.json'), root = join(directory, 'repo')
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(root, 'packages/desktop'), { recursive: true })
  await writeFile(join(root, 'packages/desktop/package.json'), JSON.stringify({ version: '0.1.0-alpha.1' }))
  await writeFile(event, JSON.stringify({ ref: 'refs/tags/v0.1.0-alpha.1', forced: false, deleted: false }))
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'Synthetic Test'); git('config', 'user.email', 'synthetic@example.invalid')
  git('add', '.'); git('commit', '-m', 'Synthetic release'); git('update-ref', 'refs/remotes/origin/main', 'HEAD'); git('tag', '-a', 'v0.1.0-alpha.1', '-m', 'Synthetic tag')
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v0.1.0-alpha.1', GITHUB_SHA: git('rev-parse', 'HEAD'),
    GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'MattoYuzuru/Guanxi', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' }
  assert.equal((await localContext(env, root)).commit, env.GITHUB_SHA)
  await writeFile(join(root, 'dirty'), 'synthetic')
  await assert.rejects(localContext(env, root), code('release_source_refused'))
  await rm(join(root, 'dirty'))
  git('checkout', '-b', 'side'); await writeFile(join(root, 'side'), 'synthetic'); git('add', '.'); git('commit', '-m', 'Unmerged source')
  env.GITHUB_SHA = git('rev-parse', 'HEAD')
  await assert.rejects(localContext(env, root), code('release_source_refused'))
  await assert.rejects(localContext({ ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' }, root), code('release_event_refused'))
})

test('same-run selection reuses the successful package job artifact on publisher-only reruns', async () => {
  const ctx = releaseContext({ ...input(), runAttempt: 2 }), f = github(ctx)
  f.state.jobs.find(job => job.name === 'check / desktop-package').run_attempt = 1
  f.state.artifacts = [{ id: 77, name: 'macos-arm64-package-1', expired: false, workflow_run: { id: ctx.runId, head_sha: ctx.commit } }]
  assert.deepEqual(await releaseRun(f.api, ctx), { id: 77, name: 'macos-arm64-package-1', runId: 42 })
  assert.ok(f.state.requests.some(request => request.path.includes('/jobs?filter=all')))
  assert.equal(f.mutations().length, 0)
})

test('all-attempt history accepts a repaired newest check while preserving earlier successful package bytes', async () => {
  const ctx = releaseContext({ ...input(), runAttempt: 2 }), f = github(ctx)
  const packageJob = f.state.jobs.find(job => job.name === 'check / desktop-package')
  packageJob.run_attempt = 1
  f.state.jobs.push({ ...f.state.jobs.find(job => job.name === 'check / core-1'), id: 901, run_attempt: 1, conclusion: 'failure' })
  f.state.artifacts = [{ id: 77, name: 'macos-arm64-package-1', expired: false, workflow_run: { id: ctx.runId, head_sha: ctx.commit } }]
  assert.equal((await releaseRun(f.api, ctx)).id, 77)
})

test('newer failed, unfinished, duplicated or foreign attempts cannot fall back to older successful checks', async () => {
  const ctx = releaseContext({ ...input(), runAttempt: 2 })
  for (const mutation of ['failed', 'unfinished', 'duplicate', 'future', 'foreign']) {
    const f = github(ctx)
    for (const job of f.state.jobs) job.run_attempt = 1
    const latest = { ...f.state.jobs.find(job => job.name === 'check / core-1'), id: 901, run_attempt: 2 }
    f.state.jobs.push(latest)
    if (mutation === 'failed') latest.conclusion = 'failure'
    if (mutation === 'unfinished') latest.status = 'in_progress'
    if (mutation === 'duplicate') f.state.jobs.push({ ...latest, id: 902 })
    if (mutation === 'future') latest.run_attempt = 3
    if (mutation === 'foreign') latest.head_sha = 'd'.repeat(40)
    f.state.artifacts[0].name = 'macos-arm64-package-1'
    await assert.rejects(releaseRun(f.api, ctx), code('release_gate_incomplete'))
    assert.equal(f.mutations().length, 0)
  }
})

test('remote tag peeling and complete matrix identity fail closed without mutation', async () => {
  const accepted = github()
  accepted.state.tag = { type: 'tag', sha: 'd'.repeat(40) }
  accepted.state.tags['d'.repeat(40)] = { type: 'commit', sha: context().commit }
  assert.equal((await releaseRun(accepted.api, context())).id, 77)
  for (const change of [state => { state.tag.sha = 'd'.repeat(40) }, state => { state.compare.status = 'diverged' },
    state => { state.run.event = 'pull_request' }, state => { state.run.run_attempt = 2 }, state => { state.run.head_sha = 'd'.repeat(40) },
    state => { state.run.status = 'completed'; state.run.conclusion = 'cancelled' },
    state => { state.jobs.pop() }, state => { state.jobs.push({ ...state.jobs[0], id: 900 }) },
    state => { state.jobs[1].conclusion = 'skipped' }, state => { state.jobs[2].status = 'in_progress' },
    state => { state.jobs[3].conclusion = 'failure' }, state => { state.jobs[4].head_sha = 'd'.repeat(40) },
    state => { state.artifacts[0].expired = true }, state => { state.artifacts[0].workflow_run.id = 99 },
    state => { state.artifacts[0].workflow_run.head_sha = 'd'.repeat(40) }, state => { state.artifacts.push({ ...state.artifacts[0], id: 88 }) }]) {
    const f = github(); change(f.state); await assert.rejects(releaseRun(f.api, context()), ReleaseError); assert.equal(f.mutations().length, 0)
  }
})

test('bundle validation pins exact four regular files, binary hashes and source identity', async t => {
  const f = await bundle(t)
  assert.equal(f.assets.length, 4)
  for (const asset of f.assets) assert.equal(asset.sha256, hash(await readFile(join(f.directory, asset.name))))
  assert.deepEqual(f.assets.map(asset => asset.name), ['guanxi-desktop-0.1.0-alpha.1-arm64.dmg', 'guanxi-desktop-0.1.0-alpha.1-arm64.zip', 'SHA256SUMS', 'package-evidence.json'])
})
for (const invalid of ['extra file', 'symlink', 'hardlink', 'changed binary', 'wrong sums', 'wrong commit', 'wrong tree', 'wrong version', 'wrong app', 'wrong architecture', 'signed claim', 'notarized claim', 'extra evidence field']) {
  test(`bundle refuses ${invalid}`, async t => {
    const f = await files(t), binary = join(f.directory, f.evidence.assets[0].name)
    if (invalid === 'extra file') await writeFile(join(f.directory, 'private-extra'), 'synthetic')
    else if (invalid === 'symlink') { await rm(binary); await symlink(join(f.directory, f.evidence.assets[1].name), binary) }
    else if (invalid === 'hardlink') {
      const linked = `${f.directory}-linked`; await link(binary, linked); t.after(() => rm(linked, { force: true }))
    }
    else if (invalid === 'changed binary') await appendFile(binary, 'changed')
    else if (invalid === 'wrong sums') await appendFile(join(f.directory, 'SHA256SUMS'), 'unexpected\n')
    else {
      if (invalid === 'wrong commit') f.evidence.commit = 'd'.repeat(40)
      if (invalid === 'wrong tree') f.evidence.tree = 'd'.repeat(40)
      if (invalid === 'wrong version') f.evidence.version = '0.2.0'
      if (invalid === 'wrong app') f.evidence.appId = 'io.example.other'
      if (invalid === 'wrong architecture') f.evidence.architecture = 'x64'
      if (invalid === 'signed claim') f.evidence.signing = 'developer-id'
      if (invalid === 'notarized claim') f.evidence.notarized = true
      if (invalid === 'extra evidence field') f.evidence.private = 'synthetic'
      await writeFile(join(f.directory, 'package-evidence.json'), JSON.stringify(f.evidence))
    }
    await assert.rejects(releaseBundle(f.directory, context()))
  })
}

test('draft creation, verified uploads and publication occur in order; published identical rerun writes nothing', async t => {
  const b = await bundle(t), f = github(), artifact = await releaseRun(f.api, context())
  assert.equal((await publishRelease(f.api, context(), b, artifact)).status, 'published')
  const writes = f.mutations()
  assert.equal(writes.length, 6)
  assert.equal(writes[0].method, 'POST'); assert.equal(writes[0].path, '/repos/MattoYuzuru/Guanxi/releases')
  assert.ok(writes.slice(1, 5).every(request => request.path.includes('/assets?name=')))
  assert.equal(writes[5].method, 'PATCH')
  assert.equal(f.state.releases.length, 1); assert.equal(f.state.releases[0].draft, false); assert.equal(f.state.releases[0].prerelease, true)
  assert.match(f.state.releases[0].body, /ad-hoc signed; not Developer ID signed or notarized/)
  assert.match(f.state.releases[0].body, /Gatekeeper/)
  assert.deepEqual(f.state.assets.map(asset => asset.name), b.assets.map(asset => asset.name))
  f.state.requests = []
  assert.equal((await publishRelease(f.api, context(), b, artifact)).status, 'unchanged')
  assert.equal(f.mutations().length, 0)
})

test('a partial failed upload resumes the same draft and original same-run bytes without duplicate creation or replacement', async t => {
  const b = await bundle(t), f = github(), artifact = await releaseRun(f.api, context())
  let uploads = 0
  f.state.before = request => {
    if (request.asset && ++uploads === 2) throw new ReleaseError('release_request_failed')
  }
  await assert.rejects(publishRelease(f.api, context(), b, artifact), code('release_request_failed'))
  assert.equal(uploads, 2, 'failed mutation was not retried')
  assert.equal(f.state.releases.length, 1); assert.equal(f.state.releases[0].draft, true); assert.equal(f.state.assets.length, 1)
  const original = clone(f.state.assets[0]); f.state.before = undefined; f.state.requests = []
  assert.equal((await publishRelease(f.api, context(), b, artifact)).status, 'published')
  assert.deepEqual(f.state.assets[0], original)
  assert.equal(f.mutations().length, 4, 'three missing assets and publication only')
  assert.ok(!f.mutations().some(request => request.path.endsWith('/releases') || request.method === 'DELETE'))
})

test('ambiguous release creation is never retried automatically and a later attempt discovers the existing draft', async t => {
  const b = await bundle(t), f = github(), artifact = await releaseRun(f.api, context())
  f.state.after = request => { if (request.method === 'POST' && request.path.endsWith('/releases')) throw new ReleaseError('release_request_failed') }
  await assert.rejects(publishRelease(f.api, context(), b, artifact), code('release_request_failed'))
  assert.equal(f.state.releases.length, 1); assert.equal(f.mutations().length, 1)
  f.state.after = undefined
  await publishRelease(f.api, context(), b, artifact)
  assert.equal(f.state.releases.length, 1)
})

test('ambiguous publication is verified as identical on retry, without writing to an immutable release', async t => {
  const b = await bundle(t), f = github(), artifact = await releaseRun(f.api, context())
  f.state.after = request => { if (request.method === 'PATCH') throw new ReleaseError('release_request_failed') }
  await assert.rejects(publishRelease(f.api, context(), b, artifact), code('release_request_failed'))
  assert.equal(f.state.releases[0].draft, false)
  assert.equal(f.mutations().filter(request => request.method === 'PATCH').length, 1)
  f.state.after = undefined; f.state.requests = []
  assert.equal((await publishRelease(f.api, context(), b, artifact)).status, 'unchanged')
  assert.equal(f.mutations().length, 0)
})

test('even a stable-shaped version remains an explicitly ad-hoc alpha prerelease', async t => {
  const ctx = releaseContext({ ...input(), version: '1.2.3', ref: 'refs/tags/v1.2.3' }), b = await bundle(t, ctx), f = github(ctx)
  await publishRelease(f.api, ctx, b, await releaseRun(f.api, ctx))
  assert.equal(f.state.releases[0].prerelease, true)
  assert.equal(f.state.releases[0].make_latest, 'false')
  assert.match(f.state.releases[0].body, /Alpha macOS/)
})

for (const invalid of ['create status', 'create tag', 'create draft', 'publish status', 'publish draft']) {
  test(`${invalid} API response is refused without an automatic mutating retry`, async t => {
    const b = await bundle(t), f = github(), artifact = await releaseRun(f.api, context())
    f.state.after = (request, response) => {
      if (request.method === 'POST' && request.path.endsWith('/releases')) {
        if (invalid === 'create status') response.status = 200
        if (invalid === 'create tag') response.data.tag_name = 'v-other'
        if (invalid === 'create draft') response.data.draft = false
      }
      if (request.method === 'PATCH') {
        if (invalid === 'publish status') response.status = 201
        if (invalid === 'publish draft') response.data.draft = true
      }
      return response
    }
    await assert.rejects(publishRelease(f.api, context(), b, artifact), ReleaseError)
    assert.equal(f.mutations().filter(request => request.path.endsWith('/releases') && request.method === 'POST').length, 1)
    assert.equal(f.mutations().filter(request => request.method === 'PATCH').length, invalid.startsWith('create') ? 0 : 1)
  })
}

for (const boundary of ['fresh read', 'publish response']) {
  test(`a different positive release ID at ${boundary} cannot report successful promotion`, async t => {
    const b = await bundle(t), f = github(), artifact = await releaseRun(f.api, context())
    f.state.after = (request, response) => {
      if ((boundary === 'fresh read' && request.path.endsWith('/releases/501') && !request.method) ||
        (boundary === 'publish response' && request.method === 'PATCH')) response.data.id = 502
      return response
    }
    await assert.rejects(publishRelease(f.api, context(), b, artifact), code('release_conflict'))
    assert.equal(f.mutations().filter(request => request.method === 'PATCH').length, boundary === 'fresh read' ? 0 : 1)
  })
}

test('artifact pagination finds the correct same-run package beyond the first page', async () => {
  const f = github(), selected = f.state.artifacts[0]
  f.state.artifacts = [...Array.from({ length: 100 }, (_, n) => ({ id: n + 1000, name: `unrelated-${n}` })), selected]
  assert.equal((await releaseRun(f.api, context())).id, selected.id)
  assert.ok(f.state.requests.some(request => request.path.includes('/artifacts?') && request.path.endsWith('page=2')))
})

test('a newly failed full gate before publication leaves the complete draft unpublished', async t => {
  const b = await bundle(t), f = github(), artifact = await releaseRun(f.api, context())
  f.state.after = (request, response, state) => {
    if (request.asset?.name === 'package-evidence.json') state.jobs.find(job => job.name === 'Full gate').conclusion = 'failure'
    return response
  }
  await assert.rejects(publishRelease(f.api, context(), b, artifact), code('release_gate_incomplete'))
  assert.equal(f.state.assets.length, 4); assert.equal(f.state.releases[0].draft, true)
  assert.equal(f.mutations().filter(request => request.method === 'PATCH').length, 0)
})

test('all paginated releases and assets are inspected before any conflicting draft mutation', async t => {
  const b = await bundle(t), f = github(), artifact = await releaseRun(f.api, context())
  await publishRelease(f.api, context(), b, artifact)
  const release = f.state.releases[0]; release.draft = true
  f.state.releases = [...Array.from({ length: 100 }, (_, n) => ({ id: n + 1000, tag_name: `other-${n}` })), release]
  f.state.assets.push(...Array.from({ length: 97 }, (_, n) => ({ id: 2000 + n, name: `unexpected-${n}`, size: 1, digest: `sha256:${'0'.repeat(64)}`, state: 'uploaded' })))
  f.state.requests = []
  await assert.rejects(publishRelease(f.api, context(), b, artifact), code('release_asset_conflict'))
  assert.ok(f.state.requests.some(request => request.path.includes('/releases?') && request.path.endsWith('page=2')))
  assert.ok(f.state.requests.some(request => request.path.includes('/assets?') && request.path.endsWith('page=2')))
  assert.equal(f.mutations().length, 0)
})

for (const invalid of ['digest', 'size', 'state', 'duplicate name', 'extra asset', 'release source', 'duplicate release', 'different artifact', 'published incomplete']) {
  test(`existing ${invalid} refuses without clobber or publication`, async t => {
    const b = await bundle(t), f = github(), artifact = await releaseRun(f.api, context())
    await publishRelease(f.api, context(), b, artifact)
    f.state.releases[0].draft = invalid !== 'published incomplete'
    if (invalid === 'digest') f.state.assets[0].digest = `sha256:${'0'.repeat(64)}`
    if (invalid === 'size') f.state.assets[0].size++
    if (invalid === 'state') f.state.assets[0].state = 'starter'
    if (invalid === 'duplicate name') f.state.assets.push({ ...f.state.assets[0], id: 999 })
    if (invalid === 'extra asset') f.state.assets.push({ ...f.state.assets[0], name: 'unrelated', id: 999 })
    if (invalid === 'release source') f.state.releases[0].target_commitish = 'main'
    if (invalid === 'duplicate release') f.state.releases.push({ ...f.state.releases[0], id: 502 })
    if (invalid === 'different artifact') f.state.artifacts[0].id = 88
    if (invalid === 'published incomplete') f.state.assets.pop()
    f.state.requests = []
    await assert.rejects(publishRelease(f.api, context(), b, artifact), ReleaseError)
    assert.equal(f.mutations().length, 0)
  })
}

for (const invalid of ['status', 'name', 'id', 'digest', 'size', 'state', 'content type']) {
  test(`invalid upload ${invalid} response prevents publication`, async t => {
    const b = await bundle(t), f = github(), artifact = await releaseRun(f.api, context())
    f.state.after = (request, response) => {
      if (!request.asset) return response
      if (invalid === 'status') response.status = 200
      if (invalid === 'name') response.data.name = 'other'
      if (invalid === 'id') response.data.id = 0
      if (invalid === 'digest') response.data.digest = 'sha256:wrong'
      if (invalid === 'size') response.data.size++
      if (invalid === 'state') response.data.state = 'starter'
      if (invalid === 'content type') response.data.content_type = 'text/html'
      return response
    }
    await assert.rejects(publishRelease(f.api, context(), b, artifact), ReleaseError)
    assert.equal(f.state.releases[0].draft, true)
    assert.equal(f.mutations().filter(request => request.method === 'PATCH').length, 0)
  })
}

test('changed pinned bytes refuse before draft creation; a moved remote tag before publication leaves a draft', async t => {
  const b = await bundle(t), f = github(), artifact = await releaseRun(f.api, context())
  await appendFile(join(b.directory, b.assets[0].name), 'changed')
  await assert.rejects(publishRelease(f.api, context(), b, artifact), code('release_bundle_changed'))
  assert.equal(f.mutations().length, 0)
  const next = await bundle(t), g = github(), selected = await releaseRun(g.api, context())
  g.state.after = (request, response, state) => { if (request.asset) state.tag.sha = 'd'.repeat(40); return response }
  await assert.rejects(publishRelease(g.api, context(), next, selected), code('release_tag_mismatch'))
  assert.equal(g.state.releases[0].draft, true)
  assert.equal(g.mutations().filter(request => request.method === 'PATCH').length, 0)
})

test('transport confines authorization to GitHub, refuses redirects and suppresses raw network errors', async () => {
  let calls = 0
  const api = githubClient('synthetic-private-token', async (url, options) => {
    calls++; assert.equal(url.origin, 'https://api.github.com'); assert.equal(options.redirect, 'error')
    assert.equal(options.headers.authorization, 'Bearer synthetic-private-token')
    throw new Error('synthetic-private-token must not be printed')
  })
  await assert.rejects(api({ path: '/repos/MattoYuzuru/Guanxi' }), error => {
    assert.equal(error.code, 'release_request_failed'); assert.equal(error.message.includes('synthetic-private-token'), false); return true
  })
  await assert.rejects(api({ path: '//other.invalid/repos/test' }), code('release_endpoint_refused'))
  assert.equal(calls, 1)
})
