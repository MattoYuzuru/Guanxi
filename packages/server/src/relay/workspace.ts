import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, mkdir, lstat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { Plan, Evidence } from './types.ts'
import { invariant, relativePath } from './types.ts'
import { sandboxCommand, quote, type SandboxPolicy } from '../native-agent/sandbox.ts'
import { nativeTools, type NativeToolContext } from '../native-agent/tools.ts'
import type { EgressScrubber } from '../egress/types.ts'
import { byteHash } from './handoff.ts'
const exec = promisify(execFile)
const protectedName = (p: string) => p.split('/').some(s => ['test', 'tests', 'spec', 'specs', '.github'].includes(s)) || /\.(test|spec)\.[^/]+$/.test(p) || /(^|\/)(\.gitlab-ci\.yml|Jenkinsfile)$/.test(p)
export interface WorkspaceObservation { head: string; files: string[]; diffstat: string; nonemptyCommit: boolean }
export interface RelayWorkspace {
  observe(base: string, baseline: string): Promise<WorkspaceObservation>
  bundle(): Promise<Uint8Array>
  verify(plan: Plan, item: string, signal?: AbortSignal): Promise<{ item: string; ok: boolean; output: string }>
  checkpoint(signal?: AbortSignal): Promise<void>
  tool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>
  validate(plan: Plan, head: string, files: string[]): Promise<void>
}
/** Trusted git plumbing: no shell interpolation, hooks, global config or credential env.
 * Arbitrary acceptance argv still runs inside K4's ExecutionOwner. */
export class GitRelayWorkspace implements RelayWorkspace {
  readonly root: string; readonly plan: Plan; readonly context: NativeToolContext; readonly protectedPaths: string[]; readonly scrubber: EgressScrubber
  private constructor(root: string, plan: Plan, context: NativeToolContext, protectedPaths: string[], scrubber: EgressScrubber) {
    this.root = root; this.plan = plan; this.context = context; this.protectedPaths = protectedPaths; this.scrubber = scrubber
  }
  static async create(root: string, plan: Plan, context: NativeToolContext): Promise<GitRelayWorkspace> {
    root = await realpath(root)
    invariant(context.policy.mode === 'full-access' && context.policy.roots.length === 1 && await realpath(context.policy.roots[0]!) === root, 'relay_root_policy')
    const w = new GitRelayWorkspace(root, plan, context, [], context.scrubber)
    const tracked = (await w.git(['ls-tree', '-r', '--name-only', plan.base])).trim().split('\n').filter(Boolean)
    w.protectedPaths.push(...new Set([...plan.protectedPaths, ...plan.items.flatMap(i => i.protectedPaths), ...tracked.filter(protectedName)]))
    for (const p of w.protectedPaths) relativePath.parse(p)
    // Keep the repository metadata harness-owned. The model checkpoints through a fixed tool.
    context.policy = { ...context.policy, protectedPaths: [...context.policy.protectedPaths, join(root, '.git'), ...w.protectedPaths.map(p => resolve(root, p))] }
    invariant((await w.git(['status', '--porcelain', '--untracked-files=all'])).trim() === '', 'checkout_dirty')
    invariant((await w.git(['rev-parse', 'HEAD'])).trim() === plan.base, 'base_mismatch')
    return w
  }
  async git(args: string[], cwd = this.root): Promise<string> {
    const { stdout } = await exec('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', ...args],
      { cwd, maxBuffer: 32 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' } })
    return stdout
  }
  protected(p: string): boolean { return protectedName(p) || this.protectedPaths.some(v => p === v || p.startsWith(v + '/')) }
  async observe(base: string, baseline: string): Promise<WorkspaceObservation> {
    const head = (await this.git(['rev-parse', 'HEAD'])).trim()
    const files = (await this.git(['diff', '--name-only', base, head])).trim().split('\n').filter(Boolean)
    return { head, files, diffstat: await this.git(['diff', '--stat', base, head]), nonemptyCommit: !!(await this.git(['diff', '--name-only', baseline, head])).trim() }
  }
  async validate(plan: Plan, head: string, files: string[]): Promise<void> {
    invariant(plan.base === this.plan.base && plan.revision === this.plan.revision, 'plan_changed')
    invariant((await this.git(['rev-parse', 'HEAD'])).trim() === head, 'head_changed')
    invariant((await this.git(['status', '--porcelain', '--untracked-files=all'])).trim() === '', 'checkout_dirty')
    invariant(files.every(p => !this.protected(p)), 'protected_path')
    await this.git(['merge-base', '--is-ancestor', plan.base, head])
  }
  async checkpoint(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const files = (await this.git(['ls-files', '-m', '-o', '--exclude-standard'])).trim().split('\n').filter(Boolean)
    invariant(files.every(p => !this.protected(p)), 'protected_path')
    // Reject links/gitlinks; no staging of paths that escape the immutable root policy.
    for (const p of files) {
      relativePath.parse(p)
      try { invariant((await lstat(join(this.root, p))).isFile(), 'file_type_denied') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    }
    if (!files.length) return
    await this.git(['add', '--all'])
    await this.git(['-c', 'user.name=Guanxi Relay', '-c', 'user.email=relay@localhost', 'commit', '-m', 'chore: relay checkpoint'])
  }
  async bundle(): Promise<Uint8Array> {
    // A compressed git bundle cannot be scrubbed in place. Refuse it if ANY reachable
    // blob contains a registered value; never persist unsanitized verification output.
    const objects = (await this.git(['rev-list', '--objects', 'HEAD'])).trim().split('\n')
    for (const row of objects) {
      const object = row.split(' ')[0]!
      const value = await this.git(['cat-file', '-p', object])
      invariant(this.scrubber.scrub(value) === value, 'bundle_secret')
    }
    const dir = await mkdtemp(join(tmpdir(), 'guanxi-relay-bundle-'))
    try { await this.git(['bundle', 'create', join(dir, 'attempt.bundle'), 'HEAD']); return await readFile(join(dir, 'attempt.bundle')) }
    finally { await rm(dir, { recursive: true, force: true }) }
  }
  async verify(plan: Plan, itemId: string, signal?: AbortSignal): Promise<{ item: string; ok: boolean; output: string }> {
    const item = plan.items.find(i => i.id === itemId)
    invariant(item, 'invalid_item')
    const before = await this.observe(plan.base, plan.base)
    await this.validate(plan, before.head, before.files)
    const temp = await mkdtemp(join(tmpdir(), 'guanxi-relay-gate-'))
    try {
      // Archive has no .git/config, hooks, untracked files or dirty executor tree.
      const archive = join(temp, 'candidate.tar'), checkout = join(temp, 'checkout'), scratch = join(temp, 'scratch')
      await mkdir(checkout); await mkdir(scratch)
      await this.git(['archive', '--format=tar', '--output=' + archive, before.head])
      await exec('/usr/bin/tar', ['-xf', archive, '-C', checkout])
      // Remove protected additions and restore ALL planner-owned tests/specs/CI from base.
      const paths = [...new Set([...this.protectedPaths, ...before.files.filter(p => this.protected(p))])]
      for (const path of paths) await rm(join(checkout, path), { recursive: true, force: true })
      const basePaths = (await this.git(['ls-tree', '-r', '--name-only', plan.base])).trim().split('\n').filter(p => this.protected(p))
      if (basePaths.length) {
        await this.git(['archive', '--format=tar', '--output=' + archive, plan.base, '--', ...basePaths])
        await exec('/usr/bin/tar', ['-xf', archive, '-C', checkout])
      }
      const policy: SandboxPolicy = { ...this.context.policy, roots: [checkout], scratch, protectedPaths: paths.map(p => join(checkout, p)), attachments: [], mode: 'read-only' }
      const output = await (this.context.executeCommand ?? sandboxCommand)(policy, `cd ${quote(checkout)} && ${item.acceptance.map(quote).join(' ')}`, signal, 120_000, false, this.scrubber)
      const after = await this.observe(plan.base, plan.base)
      invariant(after.head === before.head, 'head_changed')
      return { item: itemId, ok: output.code === 0 && !output.truncated, output: this.scrubber.scrub(JSON.stringify(output)) }
    } finally { await rm(temp, { recursive: true, force: true }) }
  }
  async tool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const tool = nativeTools(this.context).find(t => t.name === name && !['plan', 'queue', 'note_add'].includes(name))
    invariant(tool, 'tool_denied')
    const result = await tool.execute('relay', args, signal)
    return result.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
  }
}
