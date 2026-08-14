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
  { file: 'features/agent/ToolCallCard.tsx', value: 'mcp', count: 1, reason: 'protocol acronym badge' },
  { file: 'features/models/CompletionProbe.tsx', value: ':  · :  · : Ollama  · :  · : v', count: 1, reason: 'provider and evidence-version identifiers' },
  { file: 'features/models/HuggingFaceDiscovery.tsx', value: 'v', count: 1, reason: 'API version prefix' },
  { file: 'features/models/ModelCard.tsx', value: 'vram ~', count: 1, reason: 'hardware identifier' },
  { file: 'features/models/ModelCard.tsx', value: 'pro', count: 1, reason: 'provider plan identifier' },
  { file: 'features/recipes/RecipesPage.tsx', value: 'sha256:', count: 2, reason: 'digest algorithm identifier' },
  { file: 'features/recipes/RecipesPage.tsx', value: 'B', count: 1, reason: 'byte unit' },
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

function collectRenderedExpression(node, report) {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) node = node.expression
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
  if (ts.isConditionalExpression(node)) {
    collectRenderedExpression(node.whenTrue, report)
    collectRenderedExpression(node.whenFalse, report)
    return
  }
  if (ts.isBinaryExpression(node)) {
    if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]
      .includes(node.operatorToken.kind)) {
      collectRenderedExpression(node.right, report)
    } else if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      collectRenderedExpression(node.left, report)
      collectRenderedExpression(node.right, report)
    }
  }
}

export function collectLocalizedCopyViolations(sourceText, fileName = 'fixture.tsx') {
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
          })
          visitRenderedElements(node.initializer.expression)
        }
      }
      return
    } else if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(source).replace(/^['"]|['"]$/gu, '')
      if (USER_FACING_PROPERTIES.has(name)) {
        const value = literalValue(node.initializer)
        if (value !== null && LETTER.test(value) && !/^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/u.test(value)) {
          report(node.initializer, value, `property:${name}`)
        }
      }
    } else if (
      ts.isJsxExpression(node)
      && node.expression
      && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      collectRenderedExpression(node.expression, (literal, copy) => report(literal, copy, 'jsx-expression'))
      visitRenderedElements(node.expression)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

function tsxFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return tsxFiles(path)
    return entry.isFile() && entry.name.endsWith('.tsx') ? [path] : []
  })
}

export function scanLocalizedWebCopy(sourceDirectory) {
  const violations = tsxFiles(sourceDirectory).flatMap((path) => {
    const name = relative(sourceDirectory, path)
    return collectLocalizedCopyViolations(readFileSync(path, 'utf8'), name)
  })
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
