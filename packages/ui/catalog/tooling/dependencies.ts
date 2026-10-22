/**
 * Component dependency closure over the UI's own runtime imports and re-exports (G11).
 *
 * Product code is attributed to catalog components by its direct `@guanxi/ui` imports. This
 * helper expands each attributed component through its implementation and local helpers with
 * TypeScript's checker and module resolver: a reviewed wrapper cannot hide a draft child, and a
 * helper barrel or alias cannot launder one. Type-only edges, stories/tests and external
 * packages are not traversed; a runtime relative import that cannot be resolved inside the UI
 * source root is reported so it cannot silently become an approval bypass.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/
const NON_CODE = /\.(?:css|json|md|markdown|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|html?|txt|ya?ml)$/i
const EXCLUDED_FILE = /\.(?:stories|test|spec)\.[cm]?[jt]sx?$/

const COMPILER_OPTIONS: ts.CompilerOptions = {
  allowImportingTsExtensions: true,
  jsx: ts.JsxEmit.ReactJSX,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  types: [],
}

export interface UnresolvedRuntimeImport {
  /** Path relative to the UI root, with forward slashes. */
  file: string
  specifier: string
}

export interface ComponentDependencyScan {
  /** Requested component id -> every reachable component id, itself included. */
  closures: Map<string, Set<string>>
  /** Runtime relative imports that do not resolve to a file under the UI source root. */
  unresolved: UnresolvedRuntimeImport[]
}

function isCodeFile(file: string): boolean {
  return SOURCE_FILE.test(file) && !file.endsWith('.d.ts') && !EXCLUDED_FILE.test(file)
}

function under(root: string, file: string): boolean {
  const base = resolve(root)
  const full = resolve(file)
  return full === base || full.startsWith(base + sep)
}

function componentId(componentsRoot: string, file: string): string | null {
  const base = resolve(componentsRoot) + sep
  const full = resolve(file)
  if (!full.startsWith(base)) return null
  const parts = full.slice(base.length).split(sep)
  return parts.length > 1 ? (parts[0] ?? null) : null
}

function codeFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...codeFiles(full))
    else if (statSync(full).isFile() && isCodeFile(name)) out.push(full)
  }
  return out
}

function entryFiles(uiRoot: string, id: string): string[] {
  const dir = join(uiRoot, 'src', 'components', id)
  if (!existsSync(dir)) return []
  const candidates = [join(dir, 'index.ts'), join(dir, 'index.tsx'), join(dir, `${id}.tsx`), join(dir, `${id}.ts`)]
  const found = [...new Set(candidates.filter((file) => existsSync(file) && isCodeFile(file)))]
  return found.length > 0 ? found : codeFiles(dir)
}

function stringLiteral(node: ts.Node): string | null {
  return ts.isStringLiteral(node) ? node.text : null
}

/**
 * Expands each requested component id through runtime relative imports and re-exports. The
 * returned closure is per requested id, so G11 can attribute every reachable component to the
 * original product file; `unresolved` is the fail-closed list of local runtime imports the
 * resolver could not place under `src/`.
 */
export function scanComponentDependencies(uiRoot: string, ids: Iterable<string>): ComponentDependencyScan {
  const srcRoot = join(uiRoot, 'src')
  const componentsRoot = join(srcRoot, 'components')
  const requested = [...new Set(ids)]
  const rootNames = requested.flatMap((id) => entryFiles(uiRoot, id))
  const program = ts.createProgram(rootNames, COMPILER_OPTIONS)
  const checker = program.getTypeChecker()
  const unresolved = new Map<string, UnresolvedRuntimeImport>()
  const closures = new Map<string, Set<string>>()

  const walk = (id: string): Set<string> => {
    const reachable = new Set<string>([id])
    const visited = new Set<string>()
    const queue: string[] = []
    const push = (file: string): void => {
      const full = resolve(file)
      if (visited.has(full) || !under(srcRoot, full) || !isCodeFile(full)) return
      visited.add(full)
      queue.push(full)
    }
    for (const file of entryFiles(uiRoot, id)) push(file)

    const followModule = (from: string, specifier: string): void => {
      const clean = specifier.replace(/[?#].*$/, '')
      if (!specifier.startsWith('.') || NON_CODE.test(clean)) return
      const resolved = ts.resolveModuleName(specifier, from, COMPILER_OPTIONS, ts.sys).resolvedModule?.resolvedFileName
      if (!resolved) {
        const file = relative(uiRoot, from).split(sep).join('/')
        unresolved.set(`${file}\0${specifier}`, { file, specifier })
        return
      }
      const target = resolve(resolved)
      if (under(srcRoot, target) && isCodeFile(target)) push(target)
    }

    const followBinding = (node: ts.Node): boolean => {
      const symbol = checker.getSymbolAtLocation(node)
      if (!symbol) return false
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
      // A value import whose target is a type only does not depend on the target's runtime module.
      if ((target.flags & ts.SymbolFlags.Value) === 0) return true
      const declaration = target.valueDeclaration ?? target.declarations?.[0]
      if (!declaration) return false
      const file = resolve(declaration.getSourceFile().fileName)
      if (under(srcRoot, file) && isCodeFile(file)) push(file)
      return true
    }

    while (queue.length > 0) {
      const file = queue.shift() as string
      const owner = componentId(componentsRoot, file)
      if (owner) reachable.add(owner)
      const source =
        program.getSourceFile(file) ??
        ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement)) {
          const specifier = stringLiteral(statement.moduleSpecifier)
          if (!specifier) continue
          const clause = statement.importClause
          if (!clause) {
            followModule(file, specifier)
            continue
          }
          if (clause.isTypeOnly) continue
          if (clause.name && !followBinding(clause.name)) followModule(file, specifier)
          const bindings = clause.namedBindings
          if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              if (element.isTypeOnly) continue
              if (!followBinding(element.name)) followModule(file, specifier)
            }
          } else if (bindings) {
            // Namespace imports cannot name their members; follow the whole module (fail closed).
            followModule(file, specifier)
          }
        } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
          const specifier = stringLiteral(statement.moduleSpecifier)
          if (!specifier || statement.isTypeOnly) continue
          const clause = statement.exportClause
          if (clause && ts.isNamedExports(clause)) {
            for (const element of clause.elements) {
              if (element.isTypeOnly) continue
              if (!followBinding(element.name)) followModule(file, specifier)
            }
          } else {
            followModule(file, specifier)
          }
        }
      }
      const visitDynamic = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const argument = node.arguments[0]
          if (argument && ts.isStringLiteral(argument)) followModule(file, argument.text)
          else if (argument) {
            const relativeFile = relative(uiRoot, file).split(sep).join('/')
            unresolved.set(`${relativeFile}\0<computed dynamic import>`, {
              file: relativeFile,
              specifier: '<computed dynamic import>',
            })
          }
        }
        ts.forEachChild(node, visitDynamic)
      }
      visitDynamic(source)
    }
    return reachable
  }

  for (const id of requested) closures.set(id, walk(id))
  return {
    closures,
    unresolved: [...unresolved.values()].sort((a, b) => (a.file === b.file ? a.specifier.localeCompare(b.specifier) : a.file.localeCompare(b.file))),
  }
}
