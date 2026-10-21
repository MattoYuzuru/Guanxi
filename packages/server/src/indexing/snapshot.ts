import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir, realpath, lstat } from 'node:fs/promises'
import { join, relative, sep, extname, dirname, basename } from 'node:path'
import { execFile } from 'node:child_process'
import ignore from 'ignore'
import type { IndexSettings, TreeSnapshot } from './types.ts'

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export const inside = (root: string, path: string) => path === root || path.startsWith(root + sep)
export const languageOf = (path: string): string => ({ '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.md': 'markdown', '.mdx': 'markdown' })[extname(path).toLowerCase()] ?? 'file'
const blocked = (path: string) => path.split('/').some(p => p === '.git' || p.startsWith('.env') || p === 'node_modules')
export type AllowContent = (text: string) => Promise<boolean>

/** No git config, hooks, filters, helpers or shell expansion are executed. */
async function commitAt(root: string): Promise<string | null> {
  return new Promise(resolve => execFile('/usr/bin/git', ['--no-optional-locks', '-C', root, 'rev-parse', '--verify', 'HEAD'], {
    env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' }, timeout: 3000,
  }, (error, stdout) => resolve(!error && /^[a-f0-9]{40,64}\s*$/.test(stdout) ? stdout.trim() : null)))
}

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
  let skipped = 0
  type Rule = { base: string; matcher: ReturnType<typeof ignore> }
  // Nested gitignore rules are evaluated in order, including negations. Ignored
  // parents are not traversed, matching git's inability to re-include their children.
  async function walk(dir: string, inherited: Rule[]) {
    const rules = [...inherited]
    const ignorePath = relative(root, join(dir, '.gitignore')).split(sep).join('/')
    try {
      const text = await readProjectFile(root, ignorePath, settings.maxFileBytes)
      if (text === null) { skipped++; return }
      rules.push({ base: relative(root, dir).split(sep).join('/'), matcher: ignore().add(text) })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { skipped++; return }
    }
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
          await walk(absolute, rules)
        } else if (entry.isFile()) {
          const text = await readProjectFile(root, path, settings.maxFileBytes)
          if (text === null || !(await allow(text))) { skipped++; continue }
          files.push({ path, text, hash: hash(text), language: languageOf(path) })
        } else skipped++
      } catch { skipped++ }
    }
  }
  const before = await commitAt(root)
  await walk(root, [])
  const commit = await commitAt(root)
  if (before !== commit) throw new Error('index_tree_changed')
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { rootKey: hash(root), commit, files, skipped, observedAt: new Date().toISOString(), fingerprint: hash(JSON.stringify(files.map(f => [f.path, f.hash]))) }
}
