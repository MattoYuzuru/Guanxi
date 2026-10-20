/**
 * Static inventory of @guanxi/ui for the manifest builder and the catalog gates (G10–G12,
 * G15). Node only; parses TypeScript with the compiler API and never imports component code.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { parseDocs, type ComponentDocs } from '../docs.ts'

export interface StoryInfo {
  exportName: string
  name: string | null
  hasRender: boolean
  frame: string | null
}

export interface ComponentFolder {
  id: string
  dir: string
  files: string[]
  hasImplementation: boolean
  hasIndex: boolean
  hasStories: boolean
  hasDocs: boolean
  hasReview: boolean
  docs: ComponentDocs | null
  docsSource: string | null
  stories: StoryInfo[]
  metaTitle: string | null
  storyParseErrors: string[]
  /** Names exported from the folder's index.ts (values and types). */
  exports: string[]
  valueExports: string[]
  reviewJson: unknown
  reviewParseError: string | null
}

export interface UiInventory {
  uiRoot: string
  /** Folders under src/components. */
  folders: ComponentFolder[]
  /** Component folder ids re-exported by src/index.ts, in order. */
  publicFolders: string[]
  /** `export * from '…'` targets of src/index.ts that are not component folders. */
  strayExports: string[]
}

function sourceFile(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

function stringValue(node: ts.Expression | undefined): string | null {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

function objectProperty(node: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === name) {
      return property.initializer
    }
    if (ts.isMethodDeclaration(property) && ts.isIdentifier(property.name) && property.name.text === name) {
      return property as unknown as ts.Expression
    }
  }
  return undefined
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node
  while (ts.isSatisfiesExpression(current) || ts.isAsExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression
  }
  return current
}

function frameOf(object: ts.ObjectLiteralExpression): string | null {
  const parameters = objectProperty(object, 'parameters')
  if (!parameters || !ts.isObjectLiteralExpression(unwrap(parameters))) return null
  const guanxi = objectProperty(unwrap(parameters) as ts.ObjectLiteralExpression, 'guanxi')
  if (!guanxi || !ts.isObjectLiteralExpression(unwrap(guanxi))) return null
  return stringValue(objectProperty(unwrap(guanxi) as ts.ObjectLiteralExpression, 'frame'))
}

/** Reads the portable CSF 3 profile: default meta object and one object per named export. */
export function readStories(path: string): { stories: StoryInfo[]; title: string | null; errors: string[] } {
  const file = sourceFile(path)
  const stories: StoryInfo[] = []
  const errors: string[] = []
  const locals = new Map<string, ts.Expression>()
  let title: string | null = null
  let defaultExpression: ts.Expression | undefined
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
        locals.set(declaration.name.text, declaration.initializer)
        if (!exported) continue
        const value = unwrap(declaration.initializer)
        if (!ts.isObjectLiteralExpression(value)) {
          errors.push(`export ${declaration.name.text} is not an object literal`)
          continue
        }
        stories.push({
          exportName: declaration.name.text,
          name: stringValue(objectProperty(value, 'name')),
          hasRender: objectProperty(value, 'render') !== undefined,
          frame: frameOf(value),
        })
      }
    }
    if (ts.isExportAssignment(statement)) defaultExpression = statement.expression
    if (ts.isFunctionDeclaration(statement) && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      errors.push(`export function ${statement.name?.text ?? ''} is not a story object`)
    }
  }
  if (defaultExpression) {
    const resolved = ts.isIdentifier(defaultExpression) ? locals.get(defaultExpression.text) : defaultExpression
    const meta = resolved ? unwrap(resolved) : undefined
    if (meta && ts.isObjectLiteralExpression(meta)) title = stringValue(objectProperty(meta, 'title'))
    else errors.push('default export is not a meta object literal')
  } else {
    errors.push('no default export (story meta)')
  }
  return { stories, title, errors }
}

/** Value and type names exported by a folder's index.ts. */
export function readIndexExports(path: string): { all: string[]; values: string[] } {
  const file = sourceFile(path)
  const all: string[] = []
  const values: string[] = []
  for (const statement of file.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue
    for (const element of statement.exportClause.elements) {
      all.push(element.name.text)
      if (!statement.isTypeOnly && !element.isTypeOnly) values.push(element.name.text)
    }
  }
  return { all, values }
}

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listFiles(full))
    else out.push(full)
  }
  return out
}

export function readFolder(uiRoot: string, id: string): ComponentFolder {
  const dir = join(uiRoot, 'src', 'components', id)
  const file = (suffix: string) => join(dir, `${id}${suffix}`)
  const files = listFiles(dir).map((path) => relative(dir, path).split(sep).join('/'))
  const hasStories = existsSync(file('.stories.tsx'))
  const hasDocs = existsSync(file('.docs.md'))
  const hasReview = existsSync(file('.review.json'))
  const hasIndex = existsSync(join(dir, 'index.ts'))
  const docsSource = hasDocs ? readFileSync(file('.docs.md'), 'utf8') : null
  const storyData = hasStories ? readStories(file('.stories.tsx')) : { stories: [], title: null, errors: [] }
  const indexExports = hasIndex ? readIndexExports(join(dir, 'index.ts')) : { all: [], values: [] }
  let reviewJson: unknown = null
  let reviewParseError: string | null = null
  if (hasReview) {
    try {
      reviewJson = JSON.parse(readFileSync(file('.review.json'), 'utf8'))
    } catch (error) {
      reviewParseError = (error as Error).message
    }
  }
  return {
    id,
    dir,
    files,
    hasImplementation: existsSync(file('.tsx')),
    hasIndex,
    hasStories,
    hasDocs,
    hasReview,
    docs: docsSource === null ? null : parseDocs(docsSource),
    docsSource,
    stories: storyData.stories,
    metaTitle: storyData.title,
    storyParseErrors: storyData.errors,
    exports: indexExports.all,
    valueExports: indexExports.values,
    reviewJson,
    reviewParseError,
  }
}

export function readInventory(uiRoot: string): UiInventory {
  const componentsDir = join(uiRoot, 'src', 'components')
  const ids = existsSync(componentsDir)
    ? readdirSync(componentsDir).filter((name) => statSync(join(componentsDir, name)).isDirectory()).sort()
    : []
  const publicFolders: string[] = []
  const strayExports: string[] = []
  const indexPath = join(uiRoot, 'src', 'index.ts')
  if (existsSync(indexPath)) {
    for (const statement of sourceFile(indexPath).statements) {
      if (!ts.isExportDeclaration(statement) || statement.exportClause || !statement.moduleSpecifier) continue
      const target = (statement.moduleSpecifier as ts.StringLiteral).text
      const match = /^\.\/components\/([^/]+)\/index\.ts$/.exec(target)
      if (match?.[1]) publicFolders.push(match[1])
      else strayExports.push(target)
    }
  }
  return { uiRoot, folders: ids.map((id) => readFolder(uiRoot, id)), publicFolders, strayExports }
}

/** Every `var(--name)` a component's CSS reads (its tokens). */
export function cssVariables(dir: string): string[] {
  const names = new Set<string>()
  for (const path of listFiles(dir)) {
    if (!path.endsWith('.css')) continue
    for (const match of readFileSync(path, 'utf8').matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) names.add(match[1] as string)
  }
  return [...names].sort()
}

/** CSS imported by a component (its own files and shared ones like ../button/button.css). */
export function importedCss(dir: string, id: string): string[] {
  const path = join(dir, `${id}.tsx`)
  if (!existsSync(path)) return []
  const imports: string[] = []
  for (const statement of sourceFile(path).statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const spec = statement.moduleSpecifier.text
      if (spec.endsWith('.css')) imports.push(join(dir, spec))
    }
  }
  return imports
}

export function cssVariablesOf(folder: ComponentFolder): string[] {
  const names = new Set<string>()
  for (const css of importedCss(folder.dir, folder.id)) {
    if (!existsSync(css)) continue
    for (const match of readFileSync(css, 'utf8').matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) names.add(match[1] as string)
  }
  return [...names].sort()
}
