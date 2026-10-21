import stylelint from 'stylelint'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cssDiagnostics } from './colours.mjs'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const ruleName = 'guanxi/no-literal-css'
const check = enabled => (ast, result) => {
  if (!enabled) return
  const file = relative(root, ast.source.input.file ?? '').replaceAll('\\', '/')
  const findings = cssDiagnostics(file, ast.source.input.css)
  const suppressions = JSON.parse(readFileSync(resolve(root, 'eslint-suppressions.json'), 'utf8'))
  const count = suppressions[file]?.[ruleName]?.count ?? 0
  if (findings.length <= count) return
  for (const finding of findings) stylelint.utils.report({ ruleName, result, node: ast, index: finding.offset, endIndex: finding.offset + 1, message: `G6 literal CSS ${finding.value}` })
}
check.ruleName = ruleName
check.meta = { url: 'https://stylelint.io/developer-guide/plugins/' }
export default stylelint.createPlugin(ruleName, check)
