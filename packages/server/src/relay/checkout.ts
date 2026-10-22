import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, opendir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { assertRootsClean } from '../native-agent/cleanup.ts'
import { gitEnv, gitFlags } from './workspace.ts'
import type { OwnedRelayCheckout, RelayStartHost } from './start.ts'
import { invariant, RelayError } from './types.ts'

const exec = promisify(execFile)
const OWNER = 'guanxi-relay-checkout'
const MARKER = '.guanxi-relay-checkout.json'
const PREFIX = 'r-'
const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + sep)

export interface OwnedCheckoutOptions {
  /** The Guanxi-owned allowed root, for example `<data>/relay-checkouts`. Created when absent. */
  root: string
  git?: string
  /** Removal primitive, injectable so a cleanup failure can be exercised without a broken filesystem. */
  remove?: (path: string) => Promise<void>
}

/** `RelayStartHost.allocate` for an installed node: one isolated clone of the project's committed
 * history at the plan base, under a directory this allocator created and marked.
 *
 * ```
 * <root>/r-XXXXXX/                     owner marker (only a marked directory is ever deleted)
 *   checkout/                          sandbox root, detached at the base commit
 *   runtime/                           K4 runtime base and quarantine namespace
 *     scratch/                         K4 scratch
 * ```
 *
 * The clone is `--no-hardlinks` because the K4 sandbox refuses any writable hardlinked file, and
 * it keeps neither a remote nor a ref nor an object newer than the base: the executor cannot read
 * the project's future or learn where the source lives. The source repository is only read. */
export class OwnedCheckoutAllocator {
  private readonly root: string
  private readonly git: string
  private readonly remove: (path: string) => Promise<void>
  constructor(options: OwnedCheckoutOptions) {
    this.root = options.root; this.git = options.git ?? '/usr/bin/git'
    this.remove = options.remove ?? (path => rm(path, { recursive: true, force: true }))
  }
  allocate: NonNullable<RelayStartHost['allocate']> = async (policy, signal) => {
    signal.throwIfAborted()
    const source = policy.project.roots[0], base = policy.input.plan.base
    invariant(source && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base), 'relay_checkout_invalid')
    // The allowed root may neither hold the project nor live inside it. Decide before creating
    // anything, so a refused configuration leaves no directory beside or inside the project.
    const target = await this.resolvedRoot()
    invariant(!inside(source, target) && !inside(target, source), 'relay_checkout_invalid')
    await mkdir(target, { recursive: true, mode: 0o700 })
    const allowed = await realpath(target)
    invariant(allowed === target, 'relay_checkout_invalid')
    signal.throwIfAborted()
    const directory = await realpath(await mkdtemp(join(allowed, PREFIX))), id = randomUUID()
    try {
      await writeFile(join(directory, MARKER), JSON.stringify({ owner: OWNER, id }), { mode: 0o600, flag: 'wx' })
      const root = join(directory, 'checkout'), runtimeBase = join(directory, 'runtime'), scratch = join(runtimeBase, 'scratch')
      await mkdir(scratch, { recursive: true, mode: 0o700 })
      await this.prepare(source, root, base, signal)
      signal.throwIfAborted()
      let closing: Promise<void> | undefined
      // A failed release can be retried (for example after a quarantine was resolved); a successful one is final.
      const owned: OwnedRelayCheckout = { root, scratch, runtimeBase, close: () => closing ??= this.release(allowed, directory, id, root, scratch, runtimeBase)
        .catch((error: unknown) => { closing = undefined; throw error }) }
      return owned
    } catch (error) {
      // An aborted or failed allocation still owns what it created. A failure to remove it is
      // reported as such; it is never replaced by the cancellation that triggered it.
      try { await this.release(allowed, directory, id, join(directory, 'checkout'), join(directory, 'runtime', 'scratch'), join(directory, 'runtime')) }
      catch { throw new RelayError('cleanup_unconfirmed') }
      if (signal.aborted) throw new RelayError('relay_stopped')
      throw error instanceof RelayError ? error : new RelayError('relay_project_unavailable')
    }
  }
  /** The real path the allowed root has or would have, without creating any part of it. */
  private async resolvedRoot(): Promise<string> {
    let existing = resolve(this.root)
    const missing: string[] = []
    for (;;) {
      try { return join(await realpath(existing), ...missing.reverse()) }
      catch (error) {
        const parent = dirname(existing)
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === existing) throw new RelayError('relay_checkout_invalid')
        missing.push(basename(existing)); existing = parent
      }
    }
  }
  private async run(args: string[], cwd: string, signal: AbortSignal, input?: string): Promise<string> {
    signal.throwIfAborted()
    try {
      const pending = exec(this.git, [...gitFlags, ...args], { cwd, env: gitEnv, signal, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 })
      pending.child.stdin?.on('error', () => undefined)
      pending.child.stdin?.end(input ?? '')
      return (await pending).stdout
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error
      throw new RelayError('relay_project_unavailable')
    }
  }
  private async prepare(source: string, root: string, base: string, signal: AbortSignal): Promise<void> {
    const parent = dirname(root)
    // A directory that is not a usable repository is a project problem; a missing base is a plan problem.
    await this.run(['rev-parse', '--git-dir'], source, signal)
    try { await this.run(['cat-file', '-e', `${base}^{commit}`], source, signal) }
    catch (error) { if (signal.aborted) throw error; throw new RelayError('relay_checkout_invalid') }
    await this.run(['clone', '--quiet', '--no-checkout', '--no-hardlinks', '--', source, root], parent, signal)
    await this.run(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', base], root, signal)
    // No path back to the source and no history past the base: drop every ref and reflog, then
    // rewrite the object store so only what the base commit reaches remains.
    await this.run(['remote', 'remove', 'origin'], root, signal)
    const refs = (await this.run(['for-each-ref', '--format=delete %(refname)'], root, signal)).trim()
    if (refs) await this.run(['update-ref', '--stdin'], root, signal, refs + '\n')
    await this.run(['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'], root, signal)
    await this.run(['repack', '-a', '-d', '-q'], root, signal)
    await this.run(['prune', '--expire=now'], root, signal)
    invariant((await this.run(['rev-parse', 'HEAD'], root, signal)).trim() === base, 'relay_checkout_invalid')
    invariant((await this.run(['for-each-ref'], root, signal)).trim() === '' && (await this.run(['remote'], root, signal)).trim() === '', 'relay_checkout_invalid')
    invariant((await this.run(['status', '--porcelain=v2', '-z', '--untracked-files=all'], root, signal)).length === 0, 'relay_checkout_invalid')
  }
  /** Delete one allocation and prove it is gone. Idempotent through the caller's memoised promise. */
  private async release(allowed: string, directory: string, id: string, root: string, scratch: string, runtimeBase: string): Promise<void> {
    try {
      // Re-derive everything: this path may be deleted only when it is a marked allocation directly
      // under the allowed root. Anything else is left alone and reported.
      const real = await realpath(directory).catch(() => null)
      if (real === null) return await this.gone(directory)
      invariant(dirname(real) === allowed && basename(real).startsWith(PREFIX), 'cleanup_unconfirmed')
      const marker = JSON.parse(await readFile(join(real, MARKER), 'utf8')) as { owner?: unknown; id?: unknown }
      invariant(marker.owner === OWNER && marker.id === id, 'cleanup_unconfirmed')
      // A K4 quarantine means a sandbox container may still hold these paths: keep everything.
      assertRootsClean(runtimeBase, [runtimeBase, root, scratch])
      try { await this.remove(real) }
      catch { await this.writable(real); await this.remove(real) }
      await this.gone(real)
    } catch { throw new RelayError('cleanup_unconfirmed') }
  }
  private async gone(path: string): Promise<void> {
    try { await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    throw new Error('present')
  }
  /** A workload can leave read-only or searchable-only directories that a plain removal refuses. */
  private async writable(path: string): Promise<void> {
    // A failed first removal may already have deleted part of the tree: a vanished entry is progress.
    const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (!entry || entry.isSymbolicLink()) return
    await chmod(path, entry.isDirectory() ? 0o700 : 0o600).catch(() => undefined)
    if (!entry.isDirectory()) return
    const names: string[] = []
    for await (const item of await opendir(path)) names.push(item.name)
    for (const name of names) await this.writable(join(path, name))
  }
}
