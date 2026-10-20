/**
 * Where product code uses @guanxi/ui (G11 and the manifest usage count). Product code is the
 * web app and plugins; the catalog feature folder is catalog-only and may use drafts.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'

export interface UsageScope {
  /** Repository root that `files` are reported relative to. */
  repoRoot: string
  /** Directories with product code. */
  productRoots: string[]
  /** Directories inside product roots that only the catalog uses. */
  catalogOnly: string[]
}

export function defaultUsageScope(repoRoot: string): UsageScope {
  const roots = [join(repoRoot, 'packages', 'web', 'src')]
  const plugins = join(repoRoot, 'plugins')
  if (existsSync(plugins)) {
    for (const name of readdirSync(plugins)) {
      const src = join(plugins, name, 'src')
      if (existsSync(src)) roots.push(src)
    }
  }
  return {
    repoRoot,
    productRoots: roots,
    catalogOnly: [join(repoRoot, 'packages', 'web', 'src', 'features', 'catalog')],
  }
}

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(tsx?|jsx?|mts)$/.test(name) && !/\.(test|spec|stories)\./.test(name)) out.push(full)
  }
}

/** Named imports from `@guanxi/ui` (the package root) per product file. */
export function scanUsage(scope: UsageScope): Map<string, string[]> {
  const files: string[] = []
  for (const root of scope.productRoots) walk(root, files)
  const usage = new Map<string, string[]>()
  for (const path of files.sort()) {
    if (scope.catalogOnly.some((dir) => path === dir || path.startsWith(dir + sep))) continue
    const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const rel = relative(scope.repoRoot, path).split(sep).join('/')
    for (const statement of file.statements) {
      const isImport = ts.isImportDeclaration(statement)
      const isReexport = ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined
      if (!isImport && !isReexport) continue
      const specifier = (statement as ts.ImportDeclaration | ts.ExportDeclaration).moduleSpecifier
      if (!specifier || !ts.isStringLiteral(specifier) || specifier.text !== '@guanxi/ui') continue
      const names: string[] = []
      if (isImport) {
        const clause = (statement as ts.ImportDeclaration).importClause
        if (clause?.isTypeOnly) continue
        const bindings = clause?.namedBindings
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text)
          }
        } else if (bindings && ts.isNamespaceImport(bindings)) {
          names.push('*')
        }
      } else {
        const clause = (statement as ts.ExportDeclaration).exportClause
        if ((statement as ts.ExportDeclaration).isTypeOnly) continue
        if (clause && ts.isNamedExports(clause)) {
          for (const element of clause.elements) names.push((element.propertyName ?? element.name).text)
        } else names.push('*')
      }
      for (const name of names) {
        const list = usage.get(name) ?? []
        if (!list.includes(rel)) list.push(rel)
        usage.set(name, list)
      }
    }
  }
  return usage
}
