import { readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'

const USER_FACING_ATTRIBUTES = new Set([
  'aria-label',
  'aria-roledescription',
  'description',
  'hint',
  'label',
  'placeholder',
  'summary',
  'title',
])

const USER_FACING_PROPERTIES = new Set([
  'ariaLabel',
  'description',
  'hint',
  'label',
  'placeholder',
  'summary',
  'title',
])

const LETTER = /\p{L}/u

// These are exact protocol/provider identifiers or units, not natural-language
// copy. Counts make every exception stale-checked instead of silently broad.
const TECHNICAL_EXCEPTIONS = [
  { file: 'App.tsx', value: 'Guanxi', count: 1, reason: 'central product brand' },
  { file: 'features/agent/ToolCallCard.tsx', value: 'mcp', count: 1, reason: 'protocol acronym badge' },
  { file: 'features/models/CompletionProbe.tsx', value: ':  · :  · : Ollama  · :  · : v', count: 1, reason: 'provider and evidence-version identifiers' },
  { file: 'features/models/HuggingFaceDiscovery.tsx', value: 'v', count: 1, reason: 'API version prefix' },
  { file: 'features/models/ModelCard.tsx', value: 'vram ~', count: 1, reason: 'hardware identifier' },
  { file: 'features/models/ModelCard.tsx', value: 'pro', count: 1, reason: 'provider plan identifier' },
  { file: 'features/recipes/RecipesPage.tsx', value: 'sha256:', count: 2, reason: 'digest algorithm identifier' },
  { file: 'features/recipes/RecipesPage.tsx', value: 'B', count: 1, reason: 'byte unit' },
  { file: 'features/settings/SettingsPage.tsx', value: 'Ollama Web Search', count: 1, reason: 'provider product name' },
  { file: 'features/settings/SettingsPage.tsx', value: 'SearXNG', count: 1, reason: 'provider product name' },
  { file: 'features/settings/SettingsPage.tsx', value: 'Brave Search', count: 1, reason: 'provider product name' },
  { file: 'features/settings/SettingsPage.tsx', value: 'Tavily', count: 1, reason: 'provider product name' },
  { file: 'features/chat/useChat.ts', value: 'thinking', count: 1, reason: 'runtime phase identifier' },
  { file: 'features/chat/useChat.ts', value: 'generating', count: 1, reason: 'runtime phase identifier' },
  { file: 'features/chat/useChat.ts', value: 'tools', count: 1, reason: 'runtime phase identifier' },
  { file: 'features/chat/useChat.ts', value: 'awaiting_approval', count: 1, reason: 'runtime phase identifier' },
  { file: 'features/chat/useChat.ts', value: 'finalizing', count: 1, reason: 'runtime phase identifier' },
  { file: 'features/chat/useChat.ts', value: 'sending', count: 1, reason: 'runtime phase identifier' },
  { file: 'features/chat/useChat.ts', value: 'prefill', count: 1, reason: 'runtime phase identifier' },
  { file: 'features/chat/ChatPage.tsx', value: 'Guanxi', count: 2, reason: 'central product brand' },
  { file: 'lib/api.ts', value: 'unknown', count: 1, reason: 'API error sentinel' },
]

function literalValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

function isTranslateKey(node) {
  const parent = node.parent
  return ts.isCallExpression(parent)
    && parent.arguments[0] === node
    && ts.isIdentifier(parent.expression)
    && parent.expression.text === 'translate'
}

function lexicalScope(node) {
  let current = node.parent
  while (current && !ts.isBlock(current) && !ts.isSourceFile(current)) current = current.parent
  return current ?? null
}

function resolveIdentifierInitializer(identifier) {
  const source = identifier.getSourceFile()
  const scopes = []
  for (let current = identifier.parent; current; current = current.parent) {
    if (ts.isBlock(current) || ts.isSourceFile(current)) scopes.push(current)
  }
  const candidates = []
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === identifier.text
      && node.initializer
      && node.getStart(source) < identifier.getStart(source)
    ) {
      const scopeIndex = scopes.indexOf(lexicalScope(node))
      if (scopeIndex >= 0) candidates.push({ node, scopeIndex })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  candidates.sort((left, right) => (
    left.scopeIndex - right.scopeIndex || right.node.getStart(source) - left.node.getStart(source)
  ))
  return candidates[0]?.node.initializer ?? null
}

function collectRenderedExpression(node, report, seen = new Set(), externalValues = new Map()) {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) node = node.expression
  if (seen.has(node)) return
  seen.add(node)
  const value = literalValue(node)
  if (value !== null) {
    if (LETTER.test(value) && !isTranslateKey(node)) report(node, value)
    return
  }
  if (ts.isTemplateExpression(node)) {
    const copy = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('')
    if (LETTER.test(copy)) report(node, copy)
    return
  }
  if (ts.isIdentifier(node)) {
    const initializer = resolveIdentifierInitializer(node)
    if (initializer) {
      collectRenderedExpression(initializer, report, seen, externalValues)
    } else {
      for (const copy of externalValues.get(node.text) ?? []) report(node, copy)
    }
    return
  }
  if (ts.isConditionalExpression(node)) {
    collectRenderedExpression(node.whenTrue, report, seen, externalValues)
    collectRenderedExpression(node.whenFalse, report, seen, externalValues)
    return
  }
  if (ts.isBinaryExpression(node)) {
    if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]
      .includes(node.operatorToken.kind)) {
      collectRenderedExpression(node.right, report, seen, externalValues)
    } else if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      collectRenderedExpression(node.left, report, seen, externalValues)
      collectRenderedExpression(node.right, report, seen, externalValues)
    }
  }
}

export function collectLocalizedCopyViolations(
  sourceText,
  fileName = 'fixture.tsx',
  externalValues = new Map(),
) {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const violations = []
  const report = (node, value, kind = 'expression') => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source))
    violations.push({
      file: fileName,
      line: position.line + 1,
      column: position.character + 1,
      kind,
      value: value.trim(),
    })
  }

  const visitRenderedElements = (node) => {
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) node = node.expression
    if (ts.isJsxElement(node) || ts.isJsxFragment(node) || ts.isJsxSelfClosingElement(node)) {
      visit(node)
      return
    }
    if (ts.isConditionalExpression(node)) {
      visitRenderedElements(node.whenTrue)
      visitRenderedElements(node.whenFalse)
      return
    }
    if (ts.isBinaryExpression(node)
      && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]
        .includes(node.operatorToken.kind)) {
      visitRenderedElements(node.right)
    }
  }

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const value = node.getText(source).trim()
      if (LETTER.test(value)) report(node, value, 'jsx-text')
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source)
      if (USER_FACING_ATTRIBUTES.has(name) && node.initializer) {
        const value = literalValue(node.initializer)
        if (value !== null && LETTER.test(value)) report(node.initializer, value, `attribute:${name}`)
        if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          collectRenderedExpression(node.initializer.expression, (literal, copy) => {
            report(literal, copy, `attribute:${name}`)
          }, new Set(), externalValues)
          visitRenderedElements(node.initializer.expression)
        }
      }
      if (
        !USER_FACING_ATTRIBUTES.has(name)
        && node.initializer
        && ts.isJsxExpression(node.initializer)
        && node.initializer.expression
      ) {
        visit(node.initializer.expression)
      }
      return
    } else if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(source).replace(/^['"]|['"]$/gu, '')
      if (USER_FACING_PROPERTIES.has(name)) {
        collectRenderedExpression(node.initializer, (literal, copy) => {
          if (!/^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/u.test(copy)) {
            report(literal, copy, `property:${name}`)
          }
        }, new Set(), externalValues)
      }
    } else if (
      ts.isJsxExpression(node)
      && node.expression
      && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      collectRenderedExpression(
        node.expression,
        (literal, copy) => report(literal, copy, 'jsx-expression'),
        new Set(),
        externalValues,
      )
      visitRenderedElements(node.expression)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

/**
 * Formatters render strings outside JSX. Inspect every direct return branch so
 * a newly hardcoded unit or phrase cannot silently bypass the TSX inventory.
 */
export function collectDynamicCopyViolations(sourceText, fileName = 'lib/format.ts') {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const violations = []
  const report = (node, value) => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source))
    violations.push({
      file: fileName,
      line: position.line + 1,
      column: position.character + 1,
      kind: 'dynamic-return',
      value: value.trim(),
    })
  }
  const visit = (node) => {
    if (ts.isReturnStatement(node) && node.expression) {
      collectRenderedExpression(node.expression, report)
    }
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      collectRenderedExpression(node.body, report)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && /\.tsx?$/u.test(entry.name) ? [path] : []
  })
}

function sourceModule(specifier, importer) {
  const resolved = ts.resolveModuleName(specifier, importer, {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
  }, ts.sys).resolvedModule?.resolvedFileName
  return resolved && /\.tsx?$/u.test(resolved) && !resolved.endsWith('.d.ts') ? resolved : null
}

function exportedCopyIndex(files) {
  const index = new Map()
  const load = (path) => {
    if (!path) return new Map()
    if (index.has(path)) return index.get(path)
    const sourceText = readFileSync(path, 'utf8')
    const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const exports = new Map()
    index.set(path, exports) // Cyclic re-exports terminate without evaluating any module.
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const forwarded = load(sourceModule(statement.moduleSpecifier.text, path))
        if (!statement.exportClause) {
          for (const [name, values] of forwarded) exports.set(name, values)
        } else if (ts.isNamedExports(statement.exportClause)) {
          for (const binding of statement.exportClause.elements) {
            if (binding.isTypeOnly) continue
            const values = forwarded.get(binding.propertyName?.text ?? binding.name.text)
            if (values) exports.set(binding.name.text, values)
          }
        }
        continue
      }
      if (!ts.isVariableStatement(statement)) continue
      if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
        const values = []
        collectRenderedExpression(declaration.initializer, (_node, value) => values.push(value))
        if (values.length > 0) exports.set(declaration.name.text, values)
      }
    }
    return exports
  }
  for (const path of files.filter((candidate) => candidate.endsWith('.ts'))) load(path)
  return { get: load }
}

function importedCopyValues(sourceText, filePath, exportIndex) {
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const values = new Map()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!statement.importClause?.namedBindings || statement.importClause.isTypeOnly) continue
    if (!ts.isNamedImports(statement.importClause.namedBindings)) continue
    const exported = exportIndex.get(sourceModule(statement.moduleSpecifier.text, filePath))
    for (const binding of statement.importClause.namedBindings.elements) {
      const importedName = binding.propertyName?.text ?? binding.name.text
      const copies = exported.get(importedName)
      if (copies) values.set(binding.name.text, copies)
    }
  }
  return values
}

export function scanLocalizedWebCopy(sourceDirectory) {
  const files = sourceFiles(sourceDirectory)
  const exportIndex = exportedCopyIndex(files)
  const violations = files.filter((path) => path.endsWith('.tsx')).flatMap((path) => {
    const name = relative(sourceDirectory, path)
    const sourceText = readFileSync(path, 'utf8')
    return collectLocalizedCopyViolations(
      sourceText,
      name,
      importedCopyValues(sourceText, path, exportIndex),
    )
  })
  // Locale catalogs and the bilingual glossary are the localization boundary,
  // not consumers bypassing it. Every other non-JSX TS display return is
  // scanned; TSX user-facing expressions are handled by the render-aware pass.
  const localizedSources = new Set(['lib/locale.ts', 'lib/glossary.ts'])
  for (const path of files.filter((candidate) => candidate.endsWith('.ts'))) {
    const name = relative(sourceDirectory, path)
    if (localizedSources.has(name)) continue
    violations.push(...collectDynamicCopyViolations(readFileSync(path, 'utf8'), name))
  }
  const remaining = [...violations]
  for (const exception of TECHNICAL_EXCEPTIONS) {
    const matches = remaining.filter((item) => item.file === exception.file && item.value === exception.value)
    if (matches.length !== exception.count) {
      remaining.push({
        file: exception.file,
        line: 0,
        column: 0,
        kind: 'stale-technical-exception',
        value: `${exception.value} (${exception.reason}; expected ${exception.count}, found ${matches.length})`,
      })
      continue
    }
    for (const match of matches) remaining.splice(remaining.indexOf(match), 1)
  }
  return remaining
}
