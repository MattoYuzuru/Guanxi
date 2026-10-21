import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir, realpath, lstat, readFile } from 'node:fs/promises'
import { join, relative, sep, extname, dirname, basename } from 'node:path'
import { execFile } from 'node:child_process'
import ignore from 'ignore'
import type { IndexSettings, TreeSnapshot } from './types.ts'

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export const inside = (root: string, path: string) => path === root || path.startsWith(root + sep)
export const languageOf = (path: string): string => ({ '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.md': 'markdown', '.mdx': 'markdown' })[extname(path).toLowerCase()] ?? 'file'
const blocked = (path: string) => path.split('/').some(p => p.toLowerCase().startsWith('.env') || p === '.git' || p === 'node_modules')
export type AllowContent = (text: string) => Promise<boolean>
const gitEnv = (home: string) => ({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' })

/** No git config, hooks, filters, helpers or shell expansion are executed. */
async function gitResult(root: string, ...args: string[]): Promise<string | null> {
  return new Promise(resolve => execFile('/usr/bin/git', ['--no-optional-locks', '-C', root, ...args], {
    env: gitEnv(root), timeout: 3000,
  }, (error, stdout) => resolve(error ? null : stdout.trim())))
}
const commitAt = (root: string) => gitResult(root, 'rev-parse', '--verify', 'HEAD').then(stdout => stdout && /^[a-f0-9]{40,64}$/.test(stdout) ? stdout : null)

export interface ProjectFingerprint { commit: string | null; fingerprint: string }
export interface ProjectEntry { path: string; absolute: string; size: number; mtimeMs: number }

/** Read only regular files, with no-follow open and canonical parent containment. */
export async function readProjectFile(root: string, path: string, maxBytes: number, afterContainment?: () => Promise<void>): Promise<string | null> {
  const absolute = join(root, path)
  if (!inside(root, await realpath(absolute))) return null
  await afterContainment?.()
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > maxBytes) return null
    const chunks: Buffer[] = []
    let length = 0
    while (length <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - length))
      const { bytesRead } = await file.read(buffer)
      if (!bytesRead) break
      chunks.push(buffer.subarray(0, bytesRead)); length += bytesRead
    }
    const bytes = Buffer.concat(chunks)
    const canonical = await realpath(absolute)
    const named = await lstat(canonical)
    if (!inside(root, canonical) || named.dev !== before.dev || named.ino !== before.ino) return null
    const after = await file.stat()
    if (bytes.length > maxBytes || before.mtimeMs !== after.mtimeMs || before.size !== after.size || bytes.includes(0)) return null
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text
  } finally { await file.close() }
}

async function gitText(path: string, maxBytes: number): Promise<string | null | undefined> {
  try {
    const named = await lstat(path)
    if (!named.isFile() || named.size > maxBytes) return null
    const bytes = await readFile(path)
    if (bytes.includes(0)) return null
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) { return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') ? undefined : null }
}

async function repositoryRoot(path: string): Promise<boolean> {
  try { const named = await lstat(join(path, '.git')); return named.isFile() || named.isDirectory() } catch { return false }
}

/** The snapshot's only directory walk. Both the content snapshot and the
 * change fingerprint use it, so ignore rules, exclusions and submodule
 * boundaries cannot diverge. */
async function walkProject(root: string, settings: IndexSettings, allow: AllowContent, visit: (entry: ProjectEntry) => Promise<boolean>): Promise<number> {
  let skipped = 0
  type Rule = { base: string; matcher: ReturnType<typeof ignore> }
  async function rulesAt(dir: string, inherited: Rule[], repository: boolean): Promise<Rule[] | null> {
    // Git does not apply a parent repository's ignore rules inside a submodule.
    const rules = repository ? [] : [...inherited]
    if (repository) {
      const resolved = await gitResult(dir, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude')
      const fallback = join(dir, '.git', 'info', 'exclude')
      const exclude = await gitText(resolved ?? fallback, settings.maxFileBytes)
      // Missing policy is normal; an existing policy we cannot safely read
      // must not turn locally excluded files into indexable content.
      if (exclude === null) { skipped++; return null }
      if (exclude) rules.push({ base: relative(root, dir).split(sep).join('/'), matcher: ignore().add(exclude) })
    }
    const ignorePath = relative(root, join(dir, '.gitignore')).split(sep).join('/')
    try {
      const text = await readProjectFile(root, ignorePath, settings.maxFileBytes)
      if (text === null) { skipped++; return null }
      rules.push({ base: relative(root, dir).split(sep).join('/'), matcher: ignore().add(text) })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { skipped++; return null }
    }
    return rules
  }
  async function walk(dir: string, inherited: Rule[], repository: boolean) {
    const rules = await rulesAt(dir, inherited, repository)
    if (!rules) return
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(dir, entry.name)
      const path = relative(root, absolute).split(sep).join('/')
      if (blocked(path) || entry.isSymbolicLink()) { skipped++; continue }
      let ignored = false
      for (const rule of rules) {
        const local = rule.base ? path.slice(rule.base.length + 1) : path
        const result = rule.matcher.test(local + (entry.isDirectory() ? '/' : ''))
        if (result.ignored) ignored = true
        else if (result.unignored) ignored = false
      }
      if (ignored) { skipped++; continue }
      if (!(await allow(path))) { skipped++; continue }
      try {
        if (entry.isDirectory()) {
          // Do not traverse a directory replaced by a symlink after readdir.
          if (!(await lstat(absolute)).isDirectory() || !inside(root, await realpath(absolute))) { skipped++; continue }
          await walk(absolute, rules, await repositoryRoot(absolute))
        } else if (entry.isFile()) {
          const named = await lstat(absolute)
          if (!named.isFile() || named.size > settings.maxFileBytes) { skipped++; continue }
          if (!(await visit({ path, absolute, size: named.size, mtimeMs: named.mtimeMs }))) skipped++
        } else skipped++
      } catch { skipped++ }
    }
  }
  await walk(root, [], await repositoryRoot(root))
  return skipped
}

export async function snapshot(rootPath: string, settings: IndexSettings, allow: AllowContent): Promise<TreeSnapshot> {
  const root = await realpath(rootPath)
  if (root === sep) throw new Error('index_root_denied')
  const rootStat = await lstat(root)
  if (rootStat.isFile()) {
    const path = basename(root)
    const text = blocked(path) || !(await allow(path)) ? null : await readProjectFile(dirname(root), path, settings.maxFileBytes)
    const files = text !== null && await allow(text) ? [{ path, text, hash: hash(text), language: languageOf(path) }] : []
    return { rootKey: hash(root), commit: await commitAt(dirname(root)), observedAt: new Date().toISOString(), fingerprint: hash(JSON.stringify(files.map(f => [f.path, f.hash]))), files, skipped: files.length ? 0 : 1 }
  }
  if (!rootStat.isDirectory()) throw new Error('index_root_denied')
  const files: TreeSnapshot['files'] = []
  const before = await commitAt(root)
  const skipped = await walkProject(root, settings, allow, async entry => {
    const text = await readProjectFile(root, entry.path, settings.maxFileBytes)
    if (text === null || !(await allow(text))) return false
    files.push({ path: entry.path, text, hash: hash(text), language: languageOf(entry.path) })
    return true
  })
  const commit = await commitAt(root)
  if (before !== commit) throw new Error('index_tree_changed')
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { rootKey: hash(root), commit, files, skipped, observedAt: new Date().toISOString(), fingerprint: hash(JSON.stringify(files.map(f => [f.path, f.hash]))) }
}

/** Cheap change detection with the same ignore policy as `snapshot`. It stats
 * eligible files but never reads their bytes. */
export async function projectFingerprint(rootPath: string, settings: IndexSettings, allow: AllowContent): Promise<ProjectFingerprint> {
  const root = await realpath(rootPath)
  if (root === sep) throw new Error('index_root_denied')
  const rootStat = await lstat(root)
  if (rootStat.isFile()) {
    const path = basename(root)
    const line = blocked(path) || !(await allow(path)) ? null : `${path}\0${rootStat.size}\0${rootStat.mtimeMs}`
    const commit = await commitAt(dirname(root))
    return { commit, fingerprint: hash(JSON.stringify([commit, line === null ? [] : [line]])) }
  }
  if (!rootStat.isDirectory()) throw new Error('index_root_denied')
  const before = await commitAt(root)
  const lines: string[] = []
  await walkProject(root, settings, allow, async entry => { lines.push(`${entry.path}\0${entry.size}\0${entry.mtimeMs}`); return true })
  const commit = await commitAt(root)
  if (before !== commit) throw new Error('index_tree_changed')
  lines.sort()
  return { commit, fingerprint: hash(JSON.stringify([commit, lines])) }
}
