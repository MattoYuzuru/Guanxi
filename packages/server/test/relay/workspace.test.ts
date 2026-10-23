import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { GitRelayWorkspace, protectedName, catObjects } from '../../src/relay/workspace.ts'
import { fixture, plan, reserves } from './fixture.ts'
import { canonical } from '../../src/relay/handoff.ts'
import { RelayExecutor } from '../../src/relay/executor.ts'
import type { NativeToolContext } from '../../src/native-agent/tools.ts'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
const exec = promisify(execFile)
async function git(root: string, args: string[]) { return (await exec('/usr/bin/git', ['-c','core.hooksPath=/dev/null',...args], { cwd: root })).stdout.trim() }
async function setup(options: Parameters<typeof fixture>[0] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'guanxi-r2-workspace-')), repo = join(root, 'repo'), scratch = join(root, 'scratch')
  await mkdir(repo); await mkdir(scratch); await mkdir(join(repo, 'tests')); await mkdir(join(repo, 'src'))
  await writeFile(join(repo, 'tests', 'accept.txt'), 'planner acceptance')
  await writeFile(join(repo, 'src', 'a.txt'), 'base')
  await git(repo, ['init']); await git(repo, ['add','.']); await git(repo,['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','fixture'])
  const p = { ...plan, base: await git(repo, ['rev-parse','HEAD']) }
  const f = fixture(options), handle = f.log.open(f.run.session_id, { kind: 'agent' })
  const context: NativeToolContext = { policy: { mode: 'full-access', roots: [repo], scratch, attachments: [], protectedPaths: [], domains: [], runtimeBase: root }, log: f.log, handle, scrubber: f.scrubber, queue: () => {} }
  return { root, repo, p, f, context, close: async () => { handle.close(); f.close(); await rm(root, { recursive:true, force:true }) } }
}
test('git checkpoint and seal validation reject protected test/spec/CI edits and dirty checkout', async () => {
  const s = await setup(); try {
    const w = await GitRelayWorkspace.create(s.repo, s.p, s.context)
    assert.ok(s.context.policy.protectedPaths.includes(join(w.root, 'tests')))
    assert.ok(s.context.policy.protectedPaths.includes(join(w.root, '.git')))
    await writeFile(join(s.repo,'tests','accept.txt'), 'executor replacement')
    await assert.rejects(w.checkpoint(), /protected_path/)
    assert.equal(await git(s.repo,['rev-parse','HEAD']), s.p.base)
    await writeFile(join(s.repo,'tests','accept.txt'), 'planner acceptance')
    await writeFile(join(s.repo,'src','a.txt'), 'changed')
    await assert.rejects(w.validate(s.p,s.p.base,[]), /checkout_dirty/)
    await w.checkpoint()
    const observation = await w.observe(s.p.base,s.p.base)
    assert.ok(observation.nonemptyCommit); assert.deepEqual(observation.files,['src/a.txt'])
    await w.validate(s.p,observation.head,observation.files)
    const bundle = await w.bundle(s.p.base); assert.ok(Buffer.byteLength(bundle)>0)
  } finally { await s.close() }
})
test('a cycle before the first checkpoint seals an empty bundle and the next committed cycle seals', async () => {
  const s = await setup({ caps: { cycles: 2 }, actions: () => canonical({ action: 'handoff' }) })
  try {
    const w = await GitRelayWorkspace.create(s.repo, s.p, s.context)
    s.f.relay.change(s.f.attempt, 'probe_plan', l => { l.plan = s.p; l.head = s.p.base; l.baseline = { ...l.baseline, head: s.p.base } })
    const sealCount = () => Number(s.f.db.prepare('SELECT COUNT(*) n FROM relay_seals').get()!.n)
    const call = s.f.model.call.bind(s.f.model)
    let work = 0
    s.f.model.call = async (prompt, options) => {
      if (prompt.startsWith('Execute') && ++work === 2) {
        assert.equal(sealCount(), 1, 'the first cycle sealed exactly once')
        await writeFile(join(s.repo, 'src', 'b.txt'), 'checkpoint')
        await w.checkpoint()
      }
      return call(prompt, options)
    }
    await new RelayExecutor(s.f.relay, s.f.model, w, reserves, s.f.scrubber).run(s.f.attempt)
    assert.equal(sealCount(), 2)
    assert.notEqual(s.f.store.get(s.f.run.id).state, 'input_required')
    assert.equal(s.f.store.get(s.f.run.id).state, 'wrapping_up')
    const rows = s.f.db.prepare('SELECT cycle,bundle FROM relay_seals ORDER BY cycle').all() as { cycle: number; bundle: Uint8Array }[]
    assert.equal(rows[0]!.bundle.length, 0, 'no commits means an empty bundle')
    assert.ok(rows[1]!.bundle.length > 0, 'a real checkpoint produces a bundle')
    const events = s.f.log.readAll(s.f.run.session_id, 'person')
    assert.equal(events.some(e => e.type === 'error'), false)
    assert.equal(events.some(e => e.type === 'agent.note' && e.data.text.includes('"relay":"probe_degraded"')), false)
  } finally { await s.close() }
})
test('catObjects frames stay byte-exact and an 8 MiB blob reads in under a second', async () => {
  const s = await setup()
  try {
    const blobs = [Buffer.alloc(0), Buffer.from('x'), Buffer.from('a'.repeat(40) + ' blob 5\nhello\n\n'),
      randomBytes(3 * 1024 * 1024), Buffer.concat([Buffer.from('\n\n\n'), randomBytes(70000)])]
    const ids: string[] = []
    for (const [index, blob] of blobs.entries()) {
      const file = join(s.root, `blob-${index}`)
      await writeFile(file, blob)
      ids.push(await git(s.repo, ['hash-object', '-w', file]))
    }
    const out: Buffer[] = []
    for await (const content of catObjects(s.repo, ids)) out.push(Buffer.from(content))
    assert.equal(out.length, blobs.length)
    out.forEach((content, index) => assert.ok(content.equals(blobs[index]!), `frame ${index} differs`))
    const big = randomBytes(8 * 1024 * 1024), file = join(s.root, 'blob-big')
    await writeFile(file, big)
    const id = await git(s.repo, ['hash-object', '-w', file])
    const started = performance.now()
    const received: Buffer[] = []
    const concat = Buffer.concat
    let copied = 0
    Buffer.concat = (list, totalLength) => { copied += list.reduce((sum, chunk) => sum + chunk.length, 0); return concat(list, totalLength) }
    try {
      for await (const content of catObjects(s.repo, [id])) received.push(Buffer.from(content))
    } finally { Buffer.concat = concat }
    const elapsed = performance.now() - started
    assert.equal(received.length, 1)
    assert.ok(received[0]!.equals(big), '8 MiB frame differs')
    assert.ok(elapsed < 1000, `8 MiB object took ${Math.round(elapsed)} ms`)
    assert.ok(copied < 2 * big.length, `catObjects copied ${copied} bytes to assemble ${big.length} bytes`)
  } finally { await s.close() }
})
test('gates see only the committed clean tree with planner protected paths and scrubbed output', async () => {
  const s = await setup(); try {
    let checked = false
    s.context.executeCommand = async (policy, command) => {
      checked = true
      assert.equal(await readFile(join(policy.roots[0]!, 'tests','accept.txt'),'utf8'),'planner acceptance')
      assert.equal(await readFile(join(policy.roots[0]!, 'src','a.txt'),'utf8'),'candidate')
      await assert.rejects(access(join(policy.roots[0]!, '.git')))
      assert.equal(policy.mode,'read-only'); assert.ok(command.includes("'true'"))
      return { code:0, stdout:'synthetic-relay-secret',stderr:'',truncated:false }
    }
    const w = await GitRelayWorkspace.create(s.repo,s.p,s.context)
    await writeFile(join(s.repo,'src','a.txt'),'candidate'); await w.checkpoint()
    s.f.scrubber.register('secret://fixture/relay','synthetic-relay-secret')
    const result = await w.verify(s.p,'one')
    assert.equal(checked,true); assert.equal(result.ok,true); assert.equal(result.output.includes('synthetic-relay-secret'),false)
  } finally { await s.close() }
})
test('bundle refuses a registered secret in reachable history before upload', async () => {
  const s=await setup(); try {
    const w=await GitRelayWorkspace.create(s.repo,s.p,s.context)
    await writeFile(join(s.repo,'src','a.txt'),'synthetic-relay-secret'); await w.checkpoint()
    s.f.scrubber.register('secret://fixture/bundle','synthetic-relay-secret')
    await assert.rejects(w.bundle(s.p.base), /bundle_secret/)
  } finally { await s.close() }
})
test('linked base trees cannot escape clean gate preparation or delete an outside sentinel', async () => {
  const s=await setup()
  try {
    const {symlink}=await import('node:fs/promises'), outside=join(s.root,'outside')
    await mkdir(outside); await writeFile(join(outside,'victim'),'retained')
    await symlink(outside,join(s.repo,'linked'))
    await git(s.repo,['add','linked']); await git(s.repo,['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','link'])
    const p={...s.p,base:await git(s.repo,['rev-parse','HEAD']),protectedPaths:['linked/victim']}
    await assert.rejects(GitRelayWorkspace.create(s.repo,p,s.context),/unsupported_tree_entry/)
    assert.equal(await readFile(join(outside,'victim'),'utf8'),'retained')
  } finally {await s.close()}
})
test('checkpoint, observation and gate preparation never execute git filters or archive attributes', async () => {
  const s=await setup()
  try {
    const marker=join(s.root,'outside-marker')
    await git(s.repo,['config','filter.review.clean',`touch ${marker}; cat`])
    await git(s.repo,['config','filter.review.smudge',`touch ${marker}; cat`])
    const w=await GitRelayWorkspace.create(s.repo,s.p,s.context)
    await writeFile(join(s.repo,'.gitattributes'),'src/a.txt filter=review export-ignore\n')
    await writeFile(join(s.repo,'src','a.txt'),'raw candidate')
    await w.checkpoint()
    const observed=await w.observe(s.p.base,s.p.base); await w.validate(s.p,observed.head,observed.files)
    s.context.executeCommand=async policy=>{
      assert.equal(await readFile(join(policy.roots[0]!,'src','a.txt'),'utf8'),'raw candidate')
      return {code:0,stdout:'pass',stderr:'',truncated:false}
    }
    assert.equal((await w.verify(s.p,'one')).ok,true)
    await assert.rejects(access(marker))
  } finally {await s.close()}
})
test('cleanup uncertainty from native tools is fatal before another checkpoint', async () => {
  const s=await setup()
  try {
    s.context.executeCommand=async()=>{throw new Error('cleanup_unconfirmed')}
    const w=await GitRelayWorkspace.create(s.repo,s.p,s.context)
    await assert.rejects(w.tool('shell',{command:'echo unsafe'}),/cleanup_unconfirmed/)
    assert.equal(await git(s.repo,['rev-parse','HEAD']),s.p.base)
  } finally {await s.close()}
})
test('attempt bundle lists base as a prerequisite, stays small/fast and still refuses a new secret', async () => {
  const s = await setup()
  try {
    const history = join(s.repo, 'history')
    await mkdir(history)
    await Promise.all(Array.from({ length: 5000 }, (_, i) => writeFile(join(history, `f${i}.txt`), `history ${i}`)))
    await git(s.repo, ['add', '.'])
    await git(s.repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'large history'])
    await git(s.repo, ['rm', '-r', 'history'])
    await git(s.repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'clean base'])
    const base = await git(s.repo, ['rev-parse', 'HEAD'])
    assert.ok(Number(await git(s.repo, ['rev-list', '--count', '--objects', base])) >= 5000)
    const p = { ...s.p, base }
    const w = await GitRelayWorkspace.create(s.repo, p, s.context)
    await writeFile(join(s.repo, 'src', 'new.txt'), 'one new file')
    await w.checkpoint()
    const started = performance.now()
    const bundle = await w.bundle(base)
    const elapsed = performance.now() - started
    const file = join(s.root, 'attempt.bundle')
    await writeFile(file, bundle)
    const verify = (await exec('/usr/bin/git', ['bundle', 'verify', file], { cwd: s.repo })).stdout
    assert.ok(verify.includes(base), 'base is a prerequisite')
    assert.ok(Buffer.byteLength(bundle) < 64 * 1024, `bundle is ${Buffer.byteLength(bundle)} bytes`)
    assert.ok(elapsed < 5000, `sealing took ${Math.round(elapsed)} ms`)
    await writeFile(join(s.repo, 'src', 'secret.txt'), 'synthetic-relay-secret')
    await w.checkpoint()
    s.f.scrubber.register('secret://fixture/new-bundle', 'synthetic-relay-secret')
    await assert.rejects(w.bundle(base), /bundle_secret/)
  } finally { await s.close() }
})
test('default protected names cover common test, manifest and CI layouts', () => {
  for (const path of ['src/__tests__/feature.js', 'pkg/foo_test.go', 'test_foo.py', 'pkg/foo_test.py', 'conftest.py',
    'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'jest.config.js', 'vitest.config.ts',
    'playwright.config.ts', 'pytest.ini', 'pyproject.toml', 'tox.ini', 'setup.cfg', '.circleci/config.yml',
    '.travis.yml', 'azure-pipelines.yml', '.buildkite/pipeline.yml', 'Makefile', 'src/a.test.ts', 'tests/x.py',
    '.github/workflows/ci.yml', '.gitlab-ci.yml', 'Jenkinsfile']) assert.equal(protectedName(path), true, path)
  for (const path of ['src/a.ts', 'README.md', 'src/components/Button.tsx', 'src/latest/readme.txt']) assert.equal(protectedName(path), false, path)
})
test('package and test-runner indirection cannot reach the clean gate checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guanxi-r2-protected-')), repo = join(root, 'repo'), scratch = join(root, 'scratch')
  await mkdir(repo); await mkdir(scratch); await mkdir(join(repo, 'src', '__tests__'), { recursive: true })
  const pkg = JSON.stringify({ scripts: { test: 'node --test src/__tests__' } })
  await writeFile(join(repo, 'package.json'), pkg)
  await writeFile(join(repo, 'src', '__tests__', 'feature.js'), "throw new Error('planner acceptance: not implemented')")
  await git(repo, ['init']); await git(repo, ['add', '.']); await git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'fixture'])
  const p = { ...plan, base: await git(repo, ['rev-parse', 'HEAD']), items: [{ ...plan.items[0]!, acceptance: ['npm', 'test'], protectedPaths: [] }], protectedPaths: [] }
  const f = fixture(), handle = f.log.open(f.run.session_id, { kind: 'agent' })
  const seen: Record<string, string> = {}
  const context: NativeToolContext = { policy: { mode: 'full-access', roots: [repo], scratch, attachments: [], protectedPaths: [], domains: [], runtimeBase: root }, log: f.log, handle, scrubber: f.scrubber, queue: () => {},
    executeCommand: async policy => { seen.pkg = await readFile(join(policy.roots[0]!, 'package.json'), 'utf8'); seen.test = await readFile(join(policy.roots[0]!, 'src', '__tests__', 'feature.js'), 'utf8'); return { code: 0, stdout: '', stderr: '', truncated: false } } }
  try {
    const w = await GitRelayWorkspace.create(repo, p, context)
    assert.ok(w.protectedPaths.includes('package.json'))
    assert.ok(w.protectedPaths.includes('src/__tests__/feature.js'))
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'exit 0' } }))
    await assert.rejects(w.checkpoint(), /protected_path/)
    await writeFile(join(repo, 'package.json'), pkg)
    await writeFile(join(repo, 'src', '__tests__', 'feature.js'), '// emptied by executor')
    await assert.rejects(w.checkpoint(), /protected_path/)
    await writeFile(join(repo, 'src', '__tests__', 'feature.js'), "throw new Error('planner acceptance: not implemented')")
    assert.equal((await w.verify(p, 'one')).ok, true)
    assert.match(seen.pkg!, /node --test/)
    assert.match(seen.test!, /not implemented/)
  } finally { handle.close(); f.close(); await rm(root, { recursive: true, force: true }) }
})

test('the workspace lists exactly the model-callable native tools with strict parameters, and a paged read is sized to the budget it is given', async () => {
  const s = await setup()
  try {
    const w = await GitRelayWorkspace.create(s.repo, s.p, s.context), tools = w.tools()
    assert.deepEqual(tools.map(t => t.name), ['tool_output_read', 'project_info', 'file_read', 'file_write', 'shell', 'search', 'repo_map', 'fetch', 'attachments', 'session_log_query'])
    for (const name of ['plan', 'queue', 'note_add']) assert.equal(tools.some(t => t.name === name), false, name)
    for (const tool of tools) { assert.equal(tool.parameters.type, 'object', tool.name); assert.equal(tool.parameters.additionalProperties, false, tool.name) }
    assert.deepEqual(tools.find(t => t.name === 'file_read')!.parameters, { type: 'object', required: ['path'], properties: { path: { type: 'string' }, offset: { type: 'string' } }, additionalProperties: false })
    // Every listed tool is callable and every unlisted one is not.
    await assert.rejects(w.tool('plan', { items: '[]' }), /tool_denied/); await assert.rejects(w.tool('note_add', { text: 'x' }), /tool_denied/)
    const text = Array.from({ length: 400 }, (_, i) => `line ${i} of the fixture\n`).join('')
    await writeFile(join(s.repo, 'src', 'big.txt'), text)
    const first = JSON.parse(await w.tool('file_read', { path: 'src/big.txt' }, undefined, { pageBytes: 600 })) as { more: boolean; nextOffset: number; stdout: string }
    assert.equal(first.more, true); assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 600); assert.equal(first.stdout, text.slice(0, first.nextOffset))
    const next = JSON.parse(await w.tool('file_read', { path: 'src/big.txt', offset: String(first.nextOffset) }, undefined, { pageBytes: 600 })) as { stdout: string; offset: number }
    assert.equal(next.offset, first.nextOffset); assert.ok(next.stdout.startsWith(text.slice(first.nextOffset, first.nextOffset + 20)))
  } finally { await s.close() }
})
