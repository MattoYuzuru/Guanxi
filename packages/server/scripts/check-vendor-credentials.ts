import ts from 'typescript'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative, resolve } from 'node:path'

const contentApis = new Set(['readFile', 'readFileSync', 'open', 'openSync', 'createReadStream', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'read', 'readSync'])
/** D-190 forbids moving a vendor token as well as reading it. */
const moveApis = new Set(['rename', 'renameSync', 'link', 'linkSync', 'symlink', 'symlinkSync'])
const executionApis = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'fork', 'spawnSync', 'spawn'])
const fsModule = /^(?:node:)?fs(?:\/promises)?$/
const childProcessModule = /^(?:node:)?child_process$/
const moduleModule = /^(?:node:)?module$/
const vendorPath = /(?:\.claude|\.codex|\.copilot|\.gemini|(?:^|[/\\])(?:auth|oauth_creds|credentials)\.json|\.credentials\.json|CLAUDE_CONFIG_DIR|CODEX_HOME|COPILOT_HOME|GEMINI_CLI_HOME|GOOSE_PATH_ROOT)/
const sourceFile = /\.(?:ts|tsx|js|mjs|cjs|mts|cts)$/

/** Conservative whole-module path taint, plus an unconditional no-content-read rule for K5.
 * This is a regression gate, not a general proof against arbitrary malicious JS computation:
 * a path built only at runtime, with no vendor-path text in the module, cannot be seen here. */
export function vendorCredentialViolations(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const imports = new Map<string, string>()
  const namespaces = new Set<string>()
  const childImports = new Map<string, string>()
  const childNamespaces = new Set<string>()
  const moduleImports = new Map<string, string>()
  const moduleNamespaces = new Set<string>()
  const violations: string[] = []
  const restricted = /[/\\]src[/\\]external-agents[/\\]/.test(fileName)
  const processFile = /[/\\]src[/\\]external-agents[/\\]process\.ts$/.test(fileName)
  let vendor = false
  const collect = (node: ts.Node) => {
    if ((ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && vendorPath.test(node.text)) vendor = true
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const requested = node.moduleSpecifier.text
      const clause = node.importClause
      const bindings = clause?.namedBindings
      const typeOnly = !clause || clause.isTypeOnly || (bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.every(element => element.isTypeOnly))
      if (fsModule.test(requested)) {
        if (clause?.name) namespaces.add(clause.name.text)
        if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
        if (bindings && ts.isNamedImports(bindings)) for (const spec of bindings.elements) imports.set(spec.name.text, spec.propertyName?.text ?? spec.name.text)
      }
      if (childProcessModule.test(requested)) {
        const onlySpawn = processFile && !clause?.name && bindings !== undefined && ts.isNamedImports(bindings) &&
          bindings.elements.every(spec => spec.isTypeOnly || (spec.propertyName?.text ?? spec.name.text) === 'spawn')
        if (restricted && !onlySpawn && !typeOnly) violations.push(`child_process import${processFile ? ': only spawn is allowed' : ''}`)
        if (clause?.name) childNamespaces.add(clause.name.text)
        if (bindings && ts.isNamespaceImport(bindings)) childNamespaces.add(bindings.name.text)
        if (bindings && ts.isNamedImports(bindings)) for (const spec of bindings.elements) childImports.set(spec.name.text, spec.propertyName?.text ?? spec.name.text)
      }
      if (moduleModule.test(requested) && !typeOnly) {
        if (clause?.name) moduleNamespaces.add(clause.name.text)
        if (bindings && ts.isNamespaceImport(bindings)) moduleNamespaces.add(bindings.name.text)
        if (bindings && ts.isNamedImports(bindings)) for (const spec of bindings.elements) moduleImports.set(spec.name.text, spec.propertyName?.text ?? spec.name.text)
      }
    }
    ts.forEachChild(node, collect)
  }
  collect(file)
  const addBindings = (name: ts.BindingName, map: Map<string, string>, set: Set<string>) => {
    if (ts.isIdentifier(name)) set.add(name.text)
    else if (ts.isObjectBindingPattern(name)) for (const element of name.elements) if (ts.isIdentifier(element.name)) {
      map.set(element.name.text, element.propertyName?.getText(file) ?? element.name.text)
    }
  }
  const aliases = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer
      if (ts.isCallExpression(initializer) && (initializer.expression.kind === ts.SyntaxKind.ImportKeyword || initializer.expression.getText(file) === 'require')) {
        const requested = initializer.arguments.find(argument => ts.isStringLiteralLike(argument))
        const text = requested && ts.isStringLiteralLike(requested) ? requested.text : ''
        if (fsModule.test(text)) addBindings(node.name, imports, namespaces)
        if (childProcessModule.test(text)) addBindings(node.name, childImports, childNamespaces)
        if (moduleModule.test(text)) addBindings(node.name, moduleImports, moduleNamespaces)
      }
      const base = ts.isPropertyAccessExpression(initializer) && initializer.name.text === 'promises' ? initializer.expression.getText(file) : initializer.getText(file)
      if (ts.isIdentifier(node.name) && ts.isPropertyAccessExpression(initializer) && namespaces.has(initializer.expression.getText(file))) {
        if (initializer.name.text === 'promises') namespaces.add(node.name.text)
        else imports.set(node.name.text, initializer.name.text)
      } else if (ts.isObjectBindingPattern(node.name)) {
        // `const { readFileSync: r } = fs` and the same from a `node:fs/promises` namespace.
        if (namespaces.has(base)) addBindings(node.name, imports, namespaces)
        if (childNamespaces.has(base)) addBindings(node.name, childImports, childNamespaces)
        if (moduleNamespaces.has(base)) addBindings(node.name, moduleImports, moduleNamespaces)
      }
    }
    ts.forEachChild(node, aliases)
  }
  aliases(file)
  const resolveCall = (expression: ts.Expression) => {
    let callee: ts.Expression = expression
    // `fs.readFileSync.call(...)`, `.apply(...)` and `.bind(...)` invoke the same API.
    while (ts.isPropertyAccessExpression(callee) && ['call', 'apply', 'bind'].includes(callee.name.text)) callee = callee.expression
    if (ts.isIdentifier(callee)) {
      const api = imports.get(callee.text)
      if (api) return { api, text: callee.text, direct: true, child: false }
      const childApi = childImports.get(callee.text)
      if (childApi) return { api: childApi, text: callee.text, direct: true, child: true }
      const moduleApi = moduleImports.get(callee.text)
      if (moduleApi) return { api: moduleApi, text: callee.text, direct: true, child: false }
      return null
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const text = callee.getText(file)
      return { api: callee.name.text, text, direct: false, child: childNamespaces.has(callee.expression.getText(file)) || [...childNamespaces].some(name => text.startsWith(`${name}.`)) }
    }
    if (ts.isElementAccessExpression(callee) && callee.argumentExpression && ts.isStringLiteralLike(callee.argumentExpression)) {
      const text = callee.getText(file)
      return { api: callee.argumentExpression.text, text, direct: false, child: childNamespaces.has(callee.expression.getText(file)) || [...childNamespaces].some(name => text.startsWith(`${name}[`)) }
    }
    return null
  }
  const inspect = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression
      // K5 refuses even computed/dynamic filesystem and process imports: there is no valid use.
      if (restricted && (expression.kind === ts.SyntaxKind.ImportKeyword || expression.getText(file) === 'require')) {
        if (node.arguments.some(argument => /(?:node:)?fs/.test(argument.getText(file)))) violations.push('dynamic filesystem access')
        if (node.arguments.some(argument => childProcessModule.test(ts.isStringLiteralLike(argument) ? argument.text : ''))) violations.push('child_process import')
      }
      const callee = resolveCall(expression)
      if (callee) {
        const fsNamespace = [...namespaces].some(name => callee.text === name || callee.text.startsWith(`${name}.`) || callee.text.startsWith(`${name}[`))
        if (contentApis.has(callee.api) && (restricted || vendor) && (callee.direct || fsNamespace)) violations.push(`filesystem content access: ${callee.api}`)
        if (moveApis.has(callee.api) && (restricted || vendor) && (callee.direct || fsNamespace)) violations.push(`filesystem move access: ${callee.api}`)
        if (executionApis.has(callee.api) && callee.child && (restricted || vendor) && !(processFile && callee.api === 'spawn' && !vendor)) {
          violations.push(`child_process execution: ${callee.api}`)
        }
        if (restricted && callee.api === 'createRequire') violations.push('createRequire')
      }
      const called = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : undefined
      if (restricted && called === 'createRequire') violations.push('createRequire')
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
    else if (sourceFile.test(path)) files.push(path)
  }
  return files
}
export async function checkVendorCredentials(root: string) {
  const failures: string[] = []
  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) if (entry.isDirectory()) {
    const directory = join(root, 'packages', entry.name)
    const paths: string[] = []
    const roots = ['src', 'scripts', ...(entry.name === 'kernel' ? ['bin'] : [])]
    for (const child of roots) try { paths.push(...await sources(join(directory, child))) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
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
