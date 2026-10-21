import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitRelayWorkspace } from '../../src/relay/workspace.ts'
import { fixture, plan } from './fixture.ts'
import type { NativeToolContext } from '../../src/native-agent/tools.ts'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
const exec = promisify(execFile)
async function git(root: string, args: string[]) { return (await exec('/usr/bin/git', ['-c','core.hooksPath=/dev/null',...args], { cwd: root })).stdout.trim() }
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'guanxi-r2-workspace-')), repo = join(root, 'repo'), scratch = join(root, 'scratch')
  await mkdir(repo); await mkdir(scratch); await mkdir(join(repo, 'tests')); await mkdir(join(repo, 'src'))
  await writeFile(join(repo, 'tests', 'accept.txt'), 'planner acceptance')
  await writeFile(join(repo, 'src', 'a.txt'), 'base')
  await git(repo, ['init']); await git(repo, ['add','.']); await git(repo,['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','fixture'])
  const p = { ...plan, base: await git(repo, ['rev-parse','HEAD']) }
  const f = fixture(), handle = f.log.open(f.run.session_id, { kind: 'agent' })
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
    const bundle = await w.bundle(); assert.ok(Buffer.byteLength(bundle)>0)
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
    await assert.rejects(w.bundle(), /bundle_secret/)
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
