/**
 * Hashes that bind an approval to what the owner saw: the component's source, including the
 * shared code it imports, and its committed visual baselines.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

/** Editor, OS and tool leftovers that never belong to a component (and are often untracked). */
const JUNK = /(^|\/)\.|\.(tmp|orig|rej|swp|bak)$|~$/
const TEXT = /\.(tsx?|mts|mjs|css|md|json)$/
/**
 * Shared modules left out of the import closure on purpose: the message catalog changes with
 * every new key in any component. Its effect on what the owner saw is bound through the
 * visual baselines; accessible names are not (named in the DS1-b hand-off).
 */
const CLOSURE_EXCLUDED = new Set(['i18n/messages.ts'])
const IMPORT = /(?:^|[\s;])(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Regular files of a folder, sorted; symlinks, devices and junk are skipped, never followed. */
function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const stat = lstatSync(full)
    if (stat.isSymbolicLink() || JUNK.test(name)) continue
    if (stat.isDirectory()) out.push(...listFiles(full))
    else if (stat.isFile()) out.push(full)
  }
  return out
}

/** The component's own review record and docs: they do not change what the component is. */
export function isHashExcluded(componentDir: string, file: string): boolean {
  const id = basename(componentDir)
  return dirname(file) === componentDir && (basename(file) === `${id}.review.json` || basename(file) === `${id}.docs.md`)
}

function content(file: string): Buffer | string {
  const raw = readFileSync(file)
  return TEXT.test(file) ? raw.toString('utf8').replace(/\r\n/g, '\n') : raw
}

/** Relative imports of a source file that stay inside `root` and exist. */
function localImports(file: string, root: string): string[] {
  if (!/\.(tsx?|mts)$/.test(file)) return []
  const source = readFileSync(file, 'utf8')
  const found: string[] = []
  for (const match of source.matchAll(IMPORT)) {
    const target = resolve(dirname(file), match[1] as string)
    if (!target.startsWith(root + sep) || !existsSync(target)) continue
    const stat = lstatSync(target)
    if (stat.isFile() && !stat.isSymbolicLink()) found.push(target)
  }
  return found
}

/**
 * sha256 over `"<json path>\n<sha256 of the content>\n"` for the component's own files and every
 * file they import inside packages/ui/src (transitively), sorted by path. Paths are relative to
 * packages/ui/src and JSON-encoded, text is LF-normalised so checkouts on Windows hash the same,
 * and binary files are hashed as bytes.
 */
export function componentSourceHash(componentDir: string): string {
  const srcRoot = resolve(componentDir, '..', '..')
  const files = new Set(listFiles(componentDir).filter((file) => !isHashExcluded(componentDir, file)))
  const queue = [...files]
  while (queue.length > 0) {
    for (const target of localImports(queue.pop() as string, srcRoot)) {
      const rel = relative(srcRoot, target).split(sep).join('/')
      if (files.has(target) || CLOSURE_EXCLUDED.has(rel) || JUNK.test(rel)) continue
      files.add(target)
      queue.push(target)
    }
  }
  const entries = [...files]
    .map((file) => ({ file, rel: relative(srcRoot, file).split(sep).join('/') }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const hash = createHash('sha256')
  for (const { file, rel } of entries) hash.update(`${JSON.stringify(rel)}\n${sha256(content(file))}\n`)
  return `sha256:${hash.digest('hex')}`
}

/** `{ "<state>-<theme>": "sha256:…" }` for every committed baseline of the component. */
export function componentSnapshotHashes(snapshotsDir: string, id: string): Record<string, string> {
  const dir = join(snapshotsDir, id)
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return {}
  const result: Record<string, string> = {}
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (!name.endsWith('.png') || !lstatSync(full).isFile()) continue
    result[name.slice(0, -'.png'.length)] = `sha256:${sha256(readFileSync(full))}`
  }
  return result
}

export function sameSnapshotHashes(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a).sort()
  const keysB = Object.keys(b).sort()
  return keysA.length === keysB.length && keysA.every((key, index) => key === keysB[index] && a[key] === b[key])
}
