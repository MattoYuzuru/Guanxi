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
const DYNAMIC_IMPORT = /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g
/** Package-wide inputs every component renders with: shared base styles and the token layer. */
const SHARED_DIR = 'styles'
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '.css', '/index.ts', '/index.tsx']

export class SourceHashError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceHashError'
  }
}

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

function regularFile(path: string): boolean {
  if (!existsSync(path)) return false
  const stat = lstatSync(path)
  return stat.isFile() && !stat.isSymbolicLink()
}

/** Bundler-style resolution of a relative specifier: extensionless, `.js` for `.ts`, index files. */
function resolveLocal(spec: string, from: string, root: string): string {
  const base = resolve(dirname(from), spec)
  const candidates = RESOLVE_SUFFIXES.map((suffix) => base + suffix)
  if (/\.(m?js|jsx)$/.test(base)) {
    const stem = base.replace(/\.(m?js|jsx)$/, '')
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`)
  }
  const found = candidates.find(regularFile)
  const rel = relative(root, from).split(sep).join('/')
  if (!found) throw new SourceHashError(`cannot resolve '${spec}' from ${rel}`)
  if (!found.startsWith(root + sep)) throw new SourceHashError(`'${spec}' from ${rel} leaves packages/ui/src`)
  return found
}

/** Every local static, re-export and dynamic import of a source file, resolved; fails closed. */
function localImports(file: string, root: string): string[] {
  if (!/\.(tsx?|mts|m?js)$/.test(file)) return []
  const source = readFileSync(file, 'utf8')
  const specs = [...source.matchAll(IMPORT), ...source.matchAll(DYNAMIC_IMPORT)].map((match) => match[1] as string)
  return specs.map((spec) => resolveLocal(spec, file, root))
}

/**
 * sha256 over `"<json path>\n<sha256 of the content>\n"` for the component's own files, the shared
 * styles and token layer (`src/styles/`), and every file they import inside packages/ui/src
 * (static, re-export and dynamic imports, resolved like the bundler; transitively), sorted by
 * path. An import that cannot be resolved, or that leaves packages/ui/src, throws. Paths are relative to
 * packages/ui/src and JSON-encoded, text is LF-normalised so checkouts on Windows hash the same,
 * and binary files are hashed as bytes.
 */
export function componentSourceHash(componentDir: string): string {
  const srcRoot = resolve(componentDir, '..', '..')
  const files = new Set(listFiles(componentDir).filter((file) => !isHashExcluded(componentDir, file)))
  const shared = join(srcRoot, SHARED_DIR)
  if (existsSync(shared) && lstatSync(shared).isDirectory()) for (const file of listFiles(shared)) files.add(file)
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
