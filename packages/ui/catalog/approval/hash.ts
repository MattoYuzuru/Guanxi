/**
 * Hashes that bind an approval to what the owner saw: the component's source, including the
 * shared code it imports, and its committed visual baselines.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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
/** Package-wide inputs every component renders with: shared base styles under src/styles. */
const SHARED_DIR = 'styles'
/**
 * The generated token layer and the self-hosted fonts (DS1-a), outside src: a token or font
 * change alters every component, so it makes every approval stale.
 */
const PACKAGE_INPUTS = ['generated/tokens.css', 'generated/theme.css', 'fonts']
const SCRIPT = /\.(tsx?|mts|m?js)$/
/** A bare package specifier (react, @base-ui/react/toast): the lockfile pins what it runs. */
const PACKAGE_SPECIFIER = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w.@-]+)*$/i

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

// Loaded on use: release bundles of the node never hash sources, and must not bundle these.
const load = createRequire(import.meta.url)

/**
 * The component's dependency closure as the bundler resolves it (N2): esbuild bundles every
 * script in the component folder with a metafile, so each local file a static, re-export,
 * side-effect or dynamic import reaches (any syntax, template specifiers included) is an input.
 * Packages stay external; a specifier esbuild cannot resolve fails closed.
 */
function bundledInputs(entries: string[], srcRoot: string): string[] {
  if (entries.length === 0) return []
  const esbuild = load('esbuild') as typeof import('esbuild')
  let metafile: import('esbuild').Metafile
  try {
    metafile = esbuild.buildSync({
      absWorkingDir: srcRoot,
      entryPoints: entries,
      bundle: true,
      write: false,
      metafile: true,
      packages: 'external',
      platform: 'browser',
      format: 'esm',
      jsx: 'automatic',
      outdir: join(srcRoot, '.source-hash'),
      logLevel: 'silent',
      loader: { '.css': 'css', '.md': 'text', '.svg': 'file', '.png': 'file', '.woff2': 'file' },
    }).metafile
  } catch (cause) {
    const first = (cause as { errors?: Array<{ text: string; location?: { file: string } | null }> }).errors?.[0]
    throw new SourceHashError(`cannot resolve the component's dependencies: ${first ? `${first.text}${first.location ? ` (${first.location.file})` : ''}` : String(cause)}`)
  }
  // Only third-party packages may stay external. A relative or absolute specifier esbuild could
  // not bind (an import() or require() in a try, say) would run code no hash covers (N10).
  for (const [input, info] of Object.entries(metafile.inputs)) {
    for (const edge of info.imports) {
      if (edge.external && !PACKAGE_SPECIFIER.test(edge.original ?? edge.path)) {
        throw new SourceHashError(`unresolved ${edge.kind} '${edge.original ?? edge.path}' in ${input}: the hash cannot bind it`)
      }
    }
  }
  return Object.keys(metafile.inputs).map((input) => resolve(srcRoot, input))
}

/**
 * A module chosen at run time is outside any hash: `import()` and `require()` must name a
 * literal specifier (a template with any substitution counts as computed), and
 * `import.meta.glob` is refused (N10).
 */
function rejectComputedImports(file: string, root: string): void {
  if (!SCRIPT.test(file)) return
  const ts = load('typescript') as typeof import('typescript')
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const visit = (node: import('typescript').Node): void => {
    const where = () => relative(root, file).split(sep).join('/')
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const loads = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')
      if (loads) {
        const [specifier] = node.arguments
        if (!specifier || !(ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier))) {
          throw new SourceHashError(`computed dynamic import in ${where()}: the hash cannot follow it`)
        }
      }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'glob' && ts.isMetaProperty(callee.expression)) {
        throw new SourceHashError(`import.meta.glob in ${where()}: the hash cannot follow it`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

/**
 * sha256 over `"<json path>\n<sha256 of the content>\n"` for the component's own files, the shared
 * styles (`src/styles/`), the generated token layer and fonts (`generated/tokens.css`,
 * `generated/theme.css`, `fonts/`), and every local file the bundler reaches from the
 * component's scripts (esbuild metafile; any import syntax), sorted by path. A dependency that
 * cannot be resolved, one outside packages/ui, or a computed dynamic import throws. Paths are
 * relative to packages/ui/src and JSON-encoded, text is LF-normalised so checkouts on Windows
 * hash the same, and binary files are hashed as bytes.
 */
export function componentSourceHash(dir: string): string {
  const componentDir = resolve(dir)
  const srcRoot = resolve(componentDir, '..', '..')
  const packageRoot = resolve(srcRoot, '..')
  const own = listFiles(componentDir).filter((file) => !isHashExcluded(componentDir, file))
  const files = new Set(own)
  const shared = join(srcRoot, SHARED_DIR)
  if (existsSync(shared) && lstatSync(shared).isDirectory()) for (const file of listFiles(shared)) files.add(file)
  for (const input of PACKAGE_INPUTS) {
    const path = join(packageRoot, input)
    if (!existsSync(path)) continue
    const stat = lstatSync(path)
    if (stat.isDirectory() && !stat.isSymbolicLink()) for (const file of listFiles(path)) files.add(file)
    else if (stat.isFile()) files.add(path)
  }
  for (const file of own) rejectComputedImports(file, srcRoot)
  for (const input of bundledInputs(own.filter((file) => SCRIPT.test(file)), srcRoot)) {
    if (input.includes(`${sep}node_modules${sep}`)) continue
    if (!input.startsWith(srcRoot + sep) && !input.startsWith(join(packageRoot, 'generated') + sep) && !input.startsWith(join(packageRoot, 'fonts') + sep)) {
      throw new SourceHashError(`${relative(srcRoot, input).split(sep).join('/')} is outside packages/ui/src`)
    }
    const rel = relative(srcRoot, input).split(sep).join('/')
    if (CLOSURE_EXCLUDED.has(rel) || JUNK.test(rel)) continue
    files.add(input)
  }
  for (const file of files) if (file.startsWith(srcRoot + sep)) rejectComputedImports(file, srcRoot)
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
