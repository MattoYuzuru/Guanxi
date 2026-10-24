import { PRODUCT_NAME, PRODUCT_FILE_PREFIX } from '@guanxi/contract'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, mkdir, lstat, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep, dirname } from 'node:path'
import { DEFAULT_RELAY_LIMITS, type Plan, type Evidence } from './types.ts'
import { invariant, relativePath, RelayError } from './types.ts'
import { sandboxCommand, quote, type SandboxPolicy } from '../native-agent/sandbox.ts'
import { nativeTools, type NativeToolContext } from '../native-agent/tools.ts'
import type { EgressScrubber } from '../egress/types.ts'
import { byteHash } from './handoff.ts'
import { strictParameters } from './json-schema.ts'
import type { RelayToolSpec } from './response-schemas.ts'
const exec = promisify(execFile)
export const gitEnv = { PATH: '/usr/bin:/bin', HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' }
export const gitFlags = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', '-c', 'commit.gpgsign=false']
/** One long-running cat-file process for a set of objects. Frames are `<oid> <type> <size>\n<content>\n`;
 * blobs are streamed so no fixed maxBuffer applies to object contents. */
export async function* catObjects(root: string, ids: readonly string[], signal?: AbortSignal): AsyncGenerator<Buffer> {
  if (!ids.length) return
  const child = spawn('/usr/bin/git', [...gitFlags, 'cat-file', '--batch'], { cwd: root, env: gitEnv, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk })
  child.stdin.on('error', () => {})
  const closed = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  const abort = () => child.kill()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    child.stdin.end(ids.join('\n') + '\n')
    // Keep the unread bytes as chunks. Concat only when a complete frame is available, so
    // assembling one large blob is linear in its size instead of repeatedly recopying it.
    const chunks: Buffer[] = []
    let length = 0, offset = 0
    const compact = () => {
      while (chunks.length && offset >= chunks[0]!.length) {
        offset -= chunks[0]!.length
        chunks.shift()
      }
    }
    const newline = (): number => {
      let seen = 0
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index]!, from = index === 0 ? offset : 0
        const found = chunk.indexOf(10, from)
        if (found >= 0) return seen + found - from
        seen += chunk.length - from
      }
      return -1
    }
    const copy = (size: number): Buffer => {
      const out = Buffer.allocUnsafe(size)
      let written = 0
      for (let index = 0; index < chunks.length && written < size; index++) {
        const chunk = chunks[index]!, from = index === 0 ? offset : 0
        const take = Math.min(chunk.length - from, size - written)
        chunk.copy(out, written, from, from + take)
        written += take
      }
      invariant(written === size, 'git_object_invalid')
      return out
    }
    const consume = (size: number) => { length -= size; offset += size; compact() }
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      chunks.push(chunk); length += chunk.length
      while (true) {
        const newlineAt = newline()
        if (newlineAt < 0) break
        const match = /^([a-f0-9]{40,64}) (blob|tree|commit|tag) (\d+)$/.exec(copy(newlineAt).toString('utf8'))
        invariant(match, 'git_object_invalid')
        const size = Number(match[3])
        invariant(Number.isSafeInteger(size) && size >= 0, 'git_object_invalid')
        const end = newlineAt + 1 + size
        if (length < end + 1) break
        const content = copy(end).subarray(newlineAt + 1)
        consume(end + 1)
        yield content
      }
    }
    const code = await closed
    invariant(code === 0 && length === 0, stderr ? `git_failed:${stderr}` : 'git_failed')
  } finally {
    signal?.removeEventListener('abort', abort)
    child.kill()
  }
}
const protectedSegments = new Set(['test', 'tests', 'spec', 'specs', '__tests__', '.github', '.circleci', '.buildkite'])
const protectedFiles = /(^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|jest\.config\.[^/]+|vitest\.config\.[^/]+|playwright\.config\.[^/]+|pytest\.ini|pyproject\.toml|tox\.ini|setup\.cfg|\.travis\.yml|azure-pipelines\.yml|Makefile|\.gitlab-ci\.yml|Jenkinsfile)$/
const protectedTests = /(^|\/)(?:[^/]+_test\.go|test_[^/]+\.py|[^/]+_test\.py|conftest\.py)$/
/** Planner tests, manifests and CI/runner indirection are harness-owned. */
export const protectedName = (p: string) => p.split('/').some(s => protectedSegments.has(s)) || /\.(test|spec)\.[^/]+$/.test(p) || protectedFiles.test(p) || protectedTests.test(p)
/** Native tools that are the session's, not the relay model's. */
const NOT_RELAY_TOOLS = ['plan', 'queue', 'note_add']
/** The model-callable tools of a native tool context, with their parameters as strict JSON Schema objects. */
export function relayToolSpecs(context: NativeToolContext): RelayToolSpec[] {
  return nativeTools(context).filter(t => !NOT_RELAY_TOOLS.includes(t.name)).map(t => ({ name: t.name, parameters: strictParameters(t.parameters) }))
}
export interface WorkspaceObservation { head: string; files: string[]; diffstat: string; nonemptyCommit: boolean }
export interface RelayWorkspace {
  observe(base: string, baseline: string): Promise<WorkspaceObservation>
  bundle(base: string): Promise<Uint8Array>
  verify(plan: Plan, item: string, signal?: AbortSignal, timeoutMs?: number): Promise<{ item: string; head: string; ok: boolean; output: string }>
  checkpoint(signal?: AbortSignal): Promise<void>
  /** The tools the model may call, with their parameters. Absent in a test double: the executor then assumes the usual names. */
  tools?(): RelayToolSpec[]
  /** `pageBytes` is the largest result the caller can keep whole; a paged tool sizes its page to it. */
  tool(name: string, args: Record<string, unknown>, signal?: AbortSignal, options?: { pageBytes?: number }): Promise<string>
  validate(plan: Plan, head: string, files: string[]): Promise<void>
}
/** Trusted git plumbing: no shell interpolation, hooks, global config or credential env.
 * Arbitrary acceptance argv still runs inside K4's ExecutionOwner. */
export class GitRelayWorkspace implements RelayWorkspace {
  readonly root: string; readonly plan: Plan; readonly context: NativeToolContext; readonly protectedPaths: string[]; readonly scrubber: EgressScrubber
  private filterArgs: string[] = []
  private constructor(root: string, plan: Plan, context: NativeToolContext, protectedPaths: string[], scrubber: EgressScrubber) {
    this.root = root; this.plan = plan; this.context = context; this.protectedPaths = protectedPaths; this.scrubber = scrubber
  }
  static async create(root: string, plan: Plan, context: NativeToolContext): Promise<GitRelayWorkspace> {
    root = await realpath(root)
    invariant(context.policy.mode === 'full-access' && context.policy.roots.length === 1 && await realpath(context.policy.roots[0]!) === root, 'relay_root_policy')
    const w = new GitRelayWorkspace(root, plan, context, [], context.scrubber)
    w.filterArgs = await w.noFilterArgs()
    await w.tree(plan.base)
    const tracked = (await w.git(['ls-tree', '-r', '--name-only', plan.base])).trim().split('\n').filter(Boolean)
    w.protectedPaths.push(...new Set([...plan.protectedPaths, ...plan.items.flatMap(i => i.protectedPaths), ...tracked.filter(protectedName)]))
    for (const p of w.protectedPaths) relativePath.parse(p)
    // Keep the repository metadata harness-owned. The model checkpoints through a fixed tool.
    context.policy = { ...context.policy, protectedPaths: [...context.policy.protectedPaths, join(root, '.git'), ...w.protectedPaths.map(p => resolve(root, p))] }
    // The relay's unit of work is this checkout, not K4's scratch (the gate also starts with `cd` to its
    // clean checkout). Without this, `node --test test/…` resolves in the empty scratch directory.
    context.cwd = root
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
  /** Status may re-hash a stat-less index entry; neutralise every configured driver so
   * no host clean/smudge/process filter runs outside K4. */
  private async noFilterArgs(): Promise<string[]> {
    let names: string[] = []
    try {
      const out = (await exec('/usr/bin/git', ['config', '--local', '--name-only', '--get-regexp', '^filter\\.'], { cwd: this.root, env: gitEnv })).stdout
      names = out.split('\n').map(line => /^filter\.(.+)\.(?:clean|smudge|process|required)$/.exec(line)?.[1] ?? '').filter(Boolean)
    } catch { /* no local filter drivers */ }
    return [...new Set(names)].flatMap(name => ['-c', `filter.${name}.clean=cat`, '-c', `filter.${name}.smudge=cat`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`])
  }
  private async dirty(): Promise<boolean> {
    return (await this.git([...this.filterArgs, 'status', '--porcelain=v2', '-z', '--untracked-files=all'])).length > 0
  }
  private async materialize(revision: string, target: string, protectedOnly = false): Promise<void> {
    // No archive attributes, tar interpretation or symlink traversal. Every parent is
    // created here in a private tree, and linked/gitlink entries fail before extraction.
    const rows = (await this.tree(revision)).filter(row => !protectedOnly || this.protected(row.path))
    if (!rows.length) return
    for (const row of rows) await mkdir(dirname(join(target, row.path)), { recursive: true, mode: 0o700 })
    let index = 0
    for await (const content of catObjects(this.root, rows.map(row => row.object))) {
      const row = rows[index++]!
      await writeFile(join(target, row.path), content, { mode: row.mode === '100755' ? 0o500 : 0o400, flag: 'wx' })
    }
    invariant(index === rows.length, 'git_object_missing')
  }
  async checkpoint(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const files = (await this.git(['ls-files', '-z', '-o', '--exclude-standard'])).split('\0').filter(Boolean)
    for (const row of await this.tree('HEAD')) {
      try {
        const entry = await lstat(join(this.root, row.path))
        const object = entry.isFile() ? (await this.git(['hash-object', '--no-filters', '--', row.path])).trim() : ''
        if (object !== row.object || (entry.mode & 0o111 ? '100755' : '100644') !== row.mode) files.push(row.path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        files.push(row.path)
      }
    }
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
    const commit = (await this.git(['-c', `user.name=${PRODUCT_NAME} Relay`, '-c', 'user.email=relay@localhost', 'commit-tree', tree, '-p', head, '-m', 'chore: relay checkpoint'])).trim()
    await this.git(['update-ref', 'HEAD', commit, head])
  }
  async bundle(base: string): Promise<Uint8Array> {
    // No checkpoint commit yet: HEAD == base and git refuses an empty range. The empty
    // bundle is the authoritative "no changes since base" artifact, not a failure.
    const changes = (await this.git(['rev-list', `${base}..HEAD`])).trim()
    if (!changes) return new Uint8Array(0)
    // A compressed git bundle cannot be scrubbed in place. Refuse it if ANY object in
    // THIS attempt contains a registered value; never persist unsanitized output.
    const rows = (await this.git(['rev-list', '--objects', `${base}..HEAD`])).trim().split('\n').filter(Boolean)
    const ids = rows.map(row => row.split(' ')[0]!)
    let seen = 0
    for await (const content of catObjects(this.root, ids)) {
      seen++
      const value = content.toString('utf8')
      invariant(this.scrubber.scrub(value) === value, 'bundle_secret')
    }
    invariant(seen === ids.length, 'git_object_missing')
    const dir = await mkdtemp(join(tmpdir(), `${PRODUCT_FILE_PREFIX}-relay-bundle-`))
    try { await this.git(['bundle', 'create', join(dir, 'attempt.bundle'), `${base}..HEAD`]); return await readFile(join(dir, 'attempt.bundle')) }
    finally { await rm(dir, { recursive: true, force: true }) }
  }
  async verify(plan: Plan, itemId: string, signal?: AbortSignal, timeoutMs = DEFAULT_RELAY_LIMITS.gateTimeoutMs): Promise<{ item: string; head: string; ok: boolean; output: string }> {
    const item = plan.items.find(i => i.id === itemId)
    invariant(item, 'invalid_item')
    const before = await this.observe(plan.base, plan.base)
    await this.validate(plan, before.head, before.files)
    const temp = await mkdtemp(join(this.context.policy.runtimeBase ?? tmpdir(), `${PRODUCT_FILE_PREFIX}-relay-gate-`))
    let cleanup = true
    try {
      const checkout = join(temp, 'checkout'), scratch = join(temp, 'scratch')
      await mkdir(checkout); await mkdir(scratch)
      await this.materialize(before.head, checkout)
      const paths = [...new Set([...this.protectedPaths, ...before.files.filter(p => this.protected(p))])]
      for (const path of paths) await rm(join(checkout, path), { recursive: true, force: true })
      await this.materialize(plan.base, checkout, true)
      const policy: SandboxPolicy = { ...this.context.policy, roots: [checkout], scratch, protectedPaths: paths.map(p => join(checkout, p)), attachments: [], mode: 'read-only' }
      const output = await (this.context.executeCommand ?? sandboxCommand)(policy, `cd ${quote(checkout)} && ${item.acceptance.map(quote).join(' ')}`, signal, timeoutMs, false, this.scrubber)
      const after = await this.observe(plan.base, plan.base)
      invariant(after.head === before.head, 'head_changed')
      return { item: itemId, head: before.head, ok: output.code === 0 && !output.truncated, output: this.scrubber.scrub(JSON.stringify(output)) }
    } catch (error) {
      if (error instanceof Error && error.message === 'cleanup_unconfirmed') cleanup = false
      throw error
    } finally { if (cleanup) await rm(temp, { recursive: true, force: true }) }
  }
  tools(): RelayToolSpec[] {
    return relayToolSpecs(this.context)
  }
  async tool(name: string, args: Record<string, unknown>, signal?: AbortSignal, options: { pageBytes?: number } = {}): Promise<string> {
    const tool = nativeTools({ ...this.context, ...(options.pageBytes === undefined ? {} : { pageBytes: options.pageBytes }) }).find(t => t.name === name && !NOT_RELAY_TOOLS.includes(name))
    invariant(tool, 'tool_denied')
    const result = await tool.execute('relay', args, signal)
    if (result.isError) {
      // The native wrapper already reduced the failure to a fixed code (or the generic one). Throw it
      // so the executor records `status: "error"` with that code instead of a successful tool result
      // whose text happens to be a failure. cleanup_unconfirmed keeps its fatal meaning.
      const code = (result.details as { code?: string } | null)?.code
      throw new RelayError(code && /^[a-z0-9_]{1,64}$/.test(code) ? code : 'tool_failed')
    }
    return result.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
  }
}
