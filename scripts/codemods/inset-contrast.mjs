import ts from 'typescript'

// Adapted from Review 1's muted-on-inset probe: a literal surface applies to its
// JSX descendants until another background is declared. Conditional classes are
// conservative; runtime-computed class fragments still require browser checks.
export function insetMutedFindings(file, text) {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const findings = []
  function walk(node, surface = 'canvas') {
    let next = surface
    // Legacy inputs keep their placeholder and surface in a concatenated class constant.
    if (ts.isVariableDeclaration(node) && node.initializer && /class/i.test(node.name.getText(ast))) {
      const raw = node.initializer.getText(ast)
      if (/(?<![\w:-])bg-inset(?![\w-])/.test(raw)) for (const match of raw.matchAll(/(?<![\w-])text-muted(?![\w-])/g)) {
        const start = node.initializer.getStart(ast) + match.index
        findings.push({ start, end: start + match[0].length, line: ast.getLineAndCharacterOfPosition(start).line + 1 })
      }
    }
    const open = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null
    if (open) {
      const attr = open.attributes.properties.find(p => p.name?.getText(ast) === 'className')
      if (attr) {
        const raw = attr.getText(ast)
        const bg = raw.match(/(?<![\w:-])bg-(inset|canvas|surface|accent|\[var\(--(?:bg(?:-subtle|-inset|-raised)?|[\w-]+)\)\])(?![\w-])/)
        if (bg) next = /inset|subtle/.test(bg[1]) ? 'inset' : bg[1]
        if (next === 'inset') for (const match of raw.matchAll(/(?<![\w-])text-muted(?![\w-])/g)) {
          const start = attr.getStart(ast) + match.index
          findings.push({ start, end: start + match[0].length, line: ast.getLineAndCharacterOfPosition(start).line + 1 })
        }
      }
    }
    ts.forEachChild(node, child => walk(child, next))
  }
  walk(ast)
  return findings
}
