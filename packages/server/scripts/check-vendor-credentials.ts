import ts from 'typescript'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative, resolve } from 'node:path'

const contentApis = new Set(['readFile', 'readFileSync', 'open', 'openSync', 'createReadStream', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'read', 'readSync'])
const vendorPath = /(?:\.claude|\.codex|\.copilot|\.gemini|(?:^|[/\\])(?:auth|oauth_creds|credentials)\.json|\.credentials\.json|CLAUDE_CONFIG_DIR|CODEX_HOME|COPILOT_HOME|GEMINI_CLI_HOME|GOOSE_PATH_ROOT)/

/** Conservative whole-module path taint, plus an unconditional no-content-read rule for K5.
 * This is a regression gate, not a general proof against arbitrary malicious JS computation. */
export function vendorCredentialViolations(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const imports = new Map<string, string>()
  const namespaces = new Set<string>()
  const violations: string[] = []
  let vendor = false
  const collect = (node: ts.Node) => {
    if ((ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) && vendorPath.test(node.text)) vendor = true
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /^(?:node:)?fs(?:\/promises)?$/.test(node.moduleSpecifier.text)) {
      const clause = node.importClause
      if (clause?.name) namespaces.add(clause.name.text)
      const bindings = clause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
      if (bindings && ts.isNamedImports(bindings)) for (const spec of bindings.elements) imports.set(spec.name.text, spec.propertyName?.text ?? spec.name.text)
    }
    ts.forEachChild(node, collect)
  }
  collect(file)
  const aliases = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer
      if (ts.isCallExpression(initializer) && (initializer.expression.kind === ts.SyntaxKind.ImportKeyword || initializer.expression.getText(file) === 'require') &&
        initializer.arguments.some(a => ts.isStringLiteralLike(a) && /^(?:node:)?fs(?:\/promises)?$/.test(a.text))) {
        if (ts.isIdentifier(node.name)) namespaces.add(node.name.text)
        if (ts.isObjectBindingPattern(node.name)) for (const element of node.name.elements) if (ts.isIdentifier(element.name)) imports.set(element.name.text, element.propertyName?.getText(file) ?? element.name.text)
      }
      if (ts.isIdentifier(node.name) && ts.isPropertyAccessExpression(initializer) && namespaces.has(initializer.expression.getText(file))) {
        if (initializer.name.text === 'promises') namespaces.add(node.name.text)
        else imports.set(node.name.text, initializer.name.text)
      }
    }
    ts.forEachChild(node, aliases)
  }
  aliases(file)
  const restricted = /[/\\]src[/\\]external-agents[/\\]/.test(fileName)
  const inspect = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression
      const direct = ts.isIdentifier(expression) ? imports.get(expression.text) : undefined
      const member = ts.isPropertyAccessExpression(expression) ? expression.name.text : ts.isElementAccessExpression(expression) && expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression) ? expression.argumentExpression.text : undefined
      const api = direct ?? member
      // K5 refuses even computed/dynamic filesystem imports and require: there is no valid use.
      if (restricted && (expression.kind === ts.SyntaxKind.ImportKeyword || expression.getText(file) === 'require') && node.arguments.some(a => /(?:node:)?fs/.test(a.getText(file)))) violations.push('dynamic filesystem access')
      if (api && contentApis.has(api) && (restricted || vendor) &&
        (direct || [...namespaces].some(name => expression.getText(file).startsWith(`${name}.`) || expression.getText(file).startsWith(`${name}[`)))) violations.push(`filesystem content access: ${api}`)
    }
    ts.forEachChild(node, inspect)
  }
  inspect(file)
  return violations
}
async function sources(root: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await sources(path))
    else if (/\.(?:ts|tsx|js|mjs)$/.test(path)) files.push(path)
  }
  return files
}
export async function checkVendorCredentials(root: string) {
  const failures: string[] = []
  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) if (entry.isDirectory()) {
    const directory = join(root, 'packages', entry.name)
    let paths: string[] = []
    try { paths = await sources(join(directory, 'src')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    for (const path of paths) for (const violation of vendorCredentialViolations(await readFile(path, 'utf8'), path)) failures.push(`${relative(root, path)}: ${violation}`)
    try {
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) for (const name of Object.keys(pkg[section] ?? {})) {
        if (['@anthropic-ai/claude-code', '@anthropic-ai/claude-agent-sdk', '@zed-industries/claude-agent-acp', '@agentclientprotocol/claude-agent-acp'].includes(name)) failures.push(`${entry.name}: process-only dependency`)
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return failures
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = await checkVendorCredentials(resolve(import.meta.dirname, '../../..'))
  if (failures.length) { for (const failure of failures) process.stderr.write(`${failure}\n`); process.exitCode = 1 }
  else process.stdout.write('Vendor credential boundary: passed\n')
}
