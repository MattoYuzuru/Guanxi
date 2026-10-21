import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, mkdir, lstat, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep, dirname } from 'node:path'
import type { Plan, Evidence } from './types.ts'
import { invariant, relativePath, RelayError } from './types.ts'
import { sandboxCommand, quote, type SandboxPolicy } from '../native-agent/sandbox.ts'
import { nativeTools, type NativeToolContext } from '../native-agent/tools.ts'
import type { EgressScrubber } from '../egress/types.ts'
import { byteHash } from './handoff.ts'
const exec = promisify(execFile)
const gitEnv = { PATH: '/usr/bin:/bin', HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' }
const gitFlags = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', '-c', 'commit.gpgsign=false']
const protectedName = (p: string) => p.split('/').some(s => ['test', 'tests', 'spec', 'specs', '.github'].includes(s)) || /\.(test|spec)\.[^/]+$/.test(p) || /(^|\/)(\.gitlab-ci\.yml|Jenkinsfile)$/.test(p)
export interface WorkspaceObservation { head: string; files: string[]; diffstat: string; nonemptyCommit: boolean }
export interface RelayWorkspace {
  observe(base: string, baseline: string): Promise<WorkspaceObservation>
  bundle(): Promise<Uint8Array>
  verify(plan: Plan, item: string, signal?: AbortSignal): Promise<{ item: string; head: string; ok: boolean; output: string }>
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
    await w.tree(plan.base)
    const tracked = (await w.git(['ls-tree', '-r', '--name-only', plan.base])).trim().split('\n').filter(Boolean)
    w.protectedPaths.push(...new Set([...plan.protectedPaths, ...plan.items.flatMap(i => i.protectedPaths), ...tracked.filter(protectedName)]))
    for (const p of w.protectedPaths) relativePath.parse(p)
    // Keep the repository metadata harness-owned. The model checkpoints through a fixed tool.
    context.policy = { ...context.policy, protectedPaths: [...context.policy.protectedPaths, join(root, '.git'), ...w.protectedPaths.map(p => resolve(root, p))] }
    invariant(!await w.dirty(), 'checkout_dirty')
    invariant((await w.git(['rev-parse', 'HEAD'])).trim() === plan.base, 'base_mismatch')
    return w
  }
  async git(args: string[], cwd = this.root): Promise<string> {
    const { stdout } = await exec('/usr/bin/git', [...gitFlags, ...args],
      { cwd, maxBuffer: 32 * 1024 * 1024, env: gitEnv })
    return stdout
  }
  protected(p: string): boolean { return protectedName(p) || this.protectedPaths.some(v => p === v || p.startsWith(v + '/')) }
  async observe(base: string, baseline: string): Promise<WorkspaceObservation> {
    const head = (await this.git(['rev-parse', 'HEAD'])).trim()
    const files = (await this.git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', base, head])).trim().split('\n').filter(Boolean)
    return { head, files, diffstat: await this.git(['diff', '--no-ext-diff', '--no-textconv', '--stat', base, head]), nonemptyCommit: !!(await this.git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', baseline, head])).trim() }
  }
  async validate(plan: Plan, head: string, files: string[]): Promise<void> {
    await this.tree(head)
    invariant(plan.base === this.plan.base && plan.revision === this.plan.revision, 'plan_changed')
    invariant((await this.git(['rev-parse', 'HEAD'])).trim() === head, 'head_changed')
    invariant(!await this.dirty(), 'checkout_dirty')
    invariant(files.every(p => !this.protected(p)), 'protected_path')
    await this.git(['merge-base', '--is-ancestor', plan.base, head])
  }
  private async tree(revision: string): Promise<{ path: string; mode: string; object: string }[]> {
    const rows = (await this.git(['ls-tree', '-rz', revision])).split('\0').filter(Boolean).map(row => {
      const tab = row.indexOf('\t'), [mode, type, object] = row.slice(0, tab).split(' '), path = row.slice(tab + 1)
      relativePath.parse(path)
      invariant(type === 'blob' && (mode === '100644' || mode === '100755') && /^[a-f0-9]{40,64}$/.test(object!), 'unsupported_tree_entry')
      return { path, mode: mode!, object: object! }
    })
    return rows
  }
  private async dirty(): Promise<boolean> {
    if ((await this.git(['ls-files', '-z', '-o', '--exclude-standard'])).length) return true
    if ((await this.git(['diff', '--cached', '--name-only', '-z', '--no-ext-diff', '--no-textconv'])).length) return true
    for (const row of await this.tree('HEAD')) {
      try {
        const file = join(this.root, row.path), entry = await lstat(file)
        if (!entry.isFile() || !((await realpath(file)).startsWith(this.root + sep))) return true
        if ((entry.mode & 0o111 ? '100755' : '100644') !== row.mode) return true
        if ((await this.git(['hash-object', '--no-filters', '--', row.path])).trim() !== row.object) return true
      } catch { return true }
    }
    return false
  }
  private async materialize(revision: string, target: string, protectedOnly = false): Promise<void> {
    // No archive attributes, tar interpretation or symlink traversal. Every parent is
    // created here in a private tree, and linked/gitlink entries fail before extraction.
    for (const row of await this.tree(revision)) {
      if (protectedOnly && !this.protected(row.path)) continue
      const destination = join(target, row.path)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      const { stdout } = await exec('/usr/bin/git', [...gitFlags, 'cat-file', 'blob', row.object],
        { cwd: this.root, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, env: gitEnv })
      await writeFile(destination, stdout, { mode: row.mode === '100755' ? 0o500 : 0o400, flag: 'wx' })
    }
  }
  async checkpoint(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const files = [...new Set((await this.git(['ls-files', '-z', '-m', '-o', '-d', '--exclude-standard'])).split('\0').filter(Boolean))]
    const staged = (await this.git(['diff', '--cached', '--name-only', '-z', '--no-ext-diff', '--no-textconv'])).split('\0').filter(Boolean)
    invariant(staged.length === 0, 'index_not_owned')
    invariant(files.every(p => !this.protected(p)), 'protected_path')
    if (!files.length) return
    const head = (await this.git(['rev-parse', 'HEAD'])).trim()
    await this.git(['read-tree', head])
    for (const p of files) {
      relativePath.parse(p)
      let entry
      try { entry = await lstat(join(this.root, p)) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      if (!entry) { await this.git(['update-index', '--force-remove', '--', p]); continue }
      invariant(entry.isFile(), 'file_type_denied')
      const canonical = await realpath(join(this.root, p))
      invariant(canonical.startsWith(this.root + sep), 'path_denied')
      // Raw object plumbing never runs clean/smudge/process filters, hooks or a shell.
      const object = (await this.git(['hash-object', '-w', '--no-filters', '--', p])).trim()
      invariant(/^[a-f0-9]{40,64}$/.test(object), 'object_invalid')
      await this.git(['update-index', '--add', '--cacheinfo', entry.mode & 0o111 ? '100755' : '100644', object, p])
    }
    const tree = (await this.git(['write-tree'])).trim()
    const commit = (await this.git(['-c', 'user.name=Guanxi Relay', '-c', 'user.email=relay@localhost', 'commit-tree', tree, '-p', head, '-m', 'chore: relay checkpoint'])).trim()
    await this.git(['update-ref', 'HEAD', commit, head])
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
  async verify(plan: Plan, itemId: string, signal?: AbortSignal): Promise<{ item: string; head: string; ok: boolean; output: string }> {
    const item = plan.items.find(i => i.id === itemId)
    invariant(item, 'invalid_item')
    const before = await this.observe(plan.base, plan.base)
    await this.validate(plan, before.head, before.files)
    const temp = await mkdtemp(join(this.context.policy.runtimeBase ?? tmpdir(), 'guanxi-relay-gate-'))
    let cleanup = true
    try {
      const checkout = join(temp, 'checkout'), scratch = join(temp, 'scratch')
      await mkdir(checkout); await mkdir(scratch)
      await this.materialize(before.head, checkout)
      const paths = [...new Set([...this.protectedPaths, ...before.files.filter(p => this.protected(p))])]
      for (const path of paths) await rm(join(checkout, path), { recursive: true, force: true })
      await this.materialize(plan.base, checkout, true)
      const policy: SandboxPolicy = { ...this.context.policy, roots: [checkout], scratch, protectedPaths: paths.map(p => join(checkout, p)), attachments: [], mode: 'read-only' }
      const output = await (this.context.executeCommand ?? sandboxCommand)(policy, `cd ${quote(checkout)} && ${item.acceptance.map(quote).join(' ')}`, signal, 120_000, false, this.scrubber)
      const after = await this.observe(plan.base, plan.base)
      invariant(after.head === before.head, 'head_changed')
      return { item: itemId, head: before.head, ok: output.code === 0 && !output.truncated, output: this.scrubber.scrub(JSON.stringify(output)) }
    } catch (error) {
      if (error instanceof Error && error.message === 'cleanup_unconfirmed') cleanup = false
      throw error
    } finally { if (cleanup) await rm(temp, { recursive: true, force: true }) }
  }
  async tool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const tool = nativeTools(this.context).find(t => t.name === name && !['plan', 'queue', 'note_add'].includes(name))
    invariant(tool, 'tool_denied')
    const result = await tool.execute('relay', args, signal)
    if (result.isError && (result.details as { code?: string } | null)?.code === 'cleanup_unconfirmed') throw new RelayError('cleanup_unconfirmed')
    return result.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
  }
}
