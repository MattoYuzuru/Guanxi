import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ESLint } from 'eslint'
import stylelint from 'stylelint'
import { resolve, relative, dirname } from 'node:path'
import { createContext, repositoryRoot } from './context.mjs'
import gates from './extensions/lint.gate.mjs'
import { cssDiagnostics } from './lint/colours.mjs'
import { suppressionErrors, growthErrors, auditSuppressions, suppressionPath } from './lint/suppressions.mjs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const eslint = new ESLint({ cwd: repositoryRoot })
const lint = async (text, file = 'packages/web/src/features/seeded/check.tsx') => (await eslint.lintText(text, { filePath: file }))[0].messages.filter(m => m.severity === 2)
test('G8 rejects every forbidden import form and relative internals in web and plugin source', async () => {
  for (const file of ['packages/web/src/features/check.tsx', 'plugins/example/src/check.tsx', 'packages/example-plugin/src/check.tsx']) {
    const internal = relative(dirname(resolve(repositoryRoot, file)), resolve(repositoryRoot, 'packages/ui/src/index.ts')).replaceAll('\\', '/')
    for (const target of ['@guanxi/ui/src/components/button', '@base-ui/react', '@base-ui/react/button', 'lucide-react', 'motion', 'motion/react', internal]) {
      for (const source of [`import { x } from '${target}'`, `export { x } from '${target}'`, `export * from '${target}'`, `const x = import('${target}')`, `const x = require('${target}')`, `type X = import('${target}').X`]) {
        assert.ok((await lint(source, file)).some(m => m.ruleId === 'guanxi/import-boundaries'), `${file} ${source}`)
      }
    }
  }
})
test('G8 allows the public package and underlying imports in UI implementation', async () => {
  assert.deepEqual(await lint("import { Button } from '@guanxi/ui'; export const x = <Button />"), [])
  assert.deepEqual(await lint("import { Button } from '@base-ui/react/button'", 'packages/ui/src/fixture.tsx'), [])
})
test('G9 rejects all raw controls separately, including createElement', async () => {
  for (const name of ['button', 'input', 'select', 'textarea', 'dialog']) {
    for (const source of [`const x = <${name} />`, `const x = React.createElement('${name}')`, `const x = createElement('${name}')`]) assert.ok((await lint(source)).some(m => m.ruleId === 'guanxi/reuse-primitives'), source)
  }
  assert.deepEqual(await lint('const x = <Button />'), [])
})
test('G9 rejects semantic and dynamic inline colours and bound style objects, permitting geometry', async () => {
  for (const source of [
    "const x = <div style={{ color: 'red' }} />",
    "const x = <div style={{ background: 'var(--color-background-primary)' }} />",
    'const x = <div style={{ borderColor: colour }} />',
    "const s = { maskImage: 'linear-gradient(red, blue)' }; const x = <div style={s} />",
    "const s = { ['color']: colour }; const x = <div style={{ ...s }} />",
    'const x = <div style={external} />',
  ]) assert.ok((await lint(source)).some(m => m.ruleId === 'guanxi/no-inline-colours'), source)
  assert.deepEqual(await lint('const s = { width: width, transform: transform }; const x = <div style={s} />'), [])
  assert.deepEqual(await lint('const x = <div style={{ borderWidth: width, backgroundPosition: position, backgroundSize: size }} />'), [])
})
test('N5 lexical fallback detects imported maps, arbitrary literals with any name and joined arrays', async () => {
  for (const source of [
    'export const palette = { primary: "bg-[var(--bg)]" }',
    'const base = "bg-red-500"; const x = <div className={[base].join(" ")} />',
    'export const anything = `hover:text-[var(--fg)]/80`',
  ]) assert.ok((await lint(source)).some(m => m.ruleId === 'guanxi/semantic-classes'), source)
  assert.deepEqual(await lint('export const palette = { primary: "bg-canvas text-foreground" }'), [])
})
test('N8 CSS colours include stop/mask/webkit/text-decoration/column-rule and avoid transition false positives', async () => {
  for (const decl of ['stop-color:red', '-webkit-text-fill-color:#f00', 'column-rule:1px solid blue', 'text-decoration:underline red', 'mask-image:linear-gradient(red, blue)', 'background:var(--token, #f00)']) {
    assert.ok(cssDiagnostics('fixture.css', `.x{${decl}}`).length, decl)
    assert.ok((await lint(`.x{${decl}}`, 'packages/web/src/fixture.css')).some(m => m.ruleId === 'guanxi/no-literal-css'), decl)
    const out = await stylelint.lint({ code: `.x{${decl}}`, codeFilename: resolve(repositoryRoot, 'packages/web/src/fixture.css'), configFile: resolve(repositoryRoot, 'stylelint.config.mjs') })
    assert.equal(out.errored, true, decl)
  }
  for (const decl of ['transition:opacity var(--motion-duration-fast) var(--motion-easing-standard)', 'transition-property:opacity', 'mask-image:linear-gradient(var(--color-background-primary), transparent)', 'stop-color:currentColor']) assert.deepEqual(cssDiagnostics('fixture.css', `.x{${decl}}`), [], decl)
})
test('D2 same-file bound styles and SVG style attributes fail literal lint', async () => {
  assert.ok((await lint("const s = { padding: '13px' }; const x = <div style={s} />")).some(m => m.ruleId === 'guanxi/no-literal-styles'))
  for (const file of ['packages/web/src/fixture.svg', 'packages/web/src/fixture.html']) {
    assert.ok((await lint('<svg style="stop-color:red;mask-image:linear-gradient(red,blue)"><path fill="#f00" /></svg>', file)).some(m => m.ruleId === 'guanxi/svg-styles'), file)
    assert.deepEqual(await lint('<svg style="color:var(--color-text-primary)"><path fill="currentColor" /></svg>', file), [])
  }
})
test('native ESLint suppression semantics match the gate matcher and stale counts fail', async () => {
  const ctx = await createContext(), data = await ctx.json(suppressionPath)
  const native = new ESLint({ cwd: repositoryRoot, applySuppressions: true })
  for (const file of Object.keys(data)) {
    const text = await ctx.read(file)
    assert.equal((await native.lintText(text, { filePath: file }))[0].errorCount, 0, file)
    assert.deepEqual(suppressionErrors(data[file] ? { [file]: data[file] } : {}, [[file, await lint(text, file)]]), [], file)
  }
  const file = 'packages/web/src/fixture.tsx', rule = 'guanxi/reuse-primitives'
  const allowance = { [file]: { [rule]: { count: 1 } } }
  assert.ok(growthErrors(allowance, { [file]: { [rule]: { count: 2 } } }).length)
  assert.ok(growthErrors(allowance, { ...allowance, 'packages/web/src/other.tsx': { [rule]: { count: 1 } } }).length)
  assert.ok(suppressionErrors(allowance, [[file, []]]).some(e => e.includes('must shrink')))
  assert.ok(suppressionErrors(allowance, [[file, [{ ruleId: rule, message: 'seed' }, { ruleId: rule, message: 'seed' }]]]).length)
})
test('suppression history rejects growth even after a later shrink and refuses shallow clones', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'guanxi-eslint-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'Gate Test', GIT_AUTHOR_EMAIL: 'gate@example.invalid', GIT_COMMITTER_NAME: 'Gate Test', GIT_COMMITTER_EMAIL: 'gate@example.invalid' } }).trim()
  const freeze = count => ({ 'packages/web/src/a.tsx': { 'guanxi/reuse-primitives': { count } } })
  async function commit(data) { await writeFile(resolve(root, suppressionPath), JSON.stringify(data)); git('add', '.'); git('commit', '-qm', 'test freeze') }
  git('init', '-q', '--initial-branch=main')
  await commit(freeze(2))
  assert.deepEqual(auditSuppressions(root, freeze(1)), [])
  assert.ok(auditSuppressions(root, freeze(3)).some(e => e.includes('grew')))
  await writeFile(resolve(root, suppressionPath), JSON.stringify({ ...freeze(2), 'packages/web/src/new.tsx': { 'guanxi/reuse-primitives': { count: 1 } } }))
  assert.throws(() => execFileSync(process.execPath, [resolve(repositoryRoot, 'packages/ui/gates/lint/suppressions.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }), error => error.status === 1 && String(error.stdout).includes('suppression grew'))
  await commit(freeze(3)); await commit(freeze(1))
  assert.ok(auditSuppressions(root, freeze(1)).some(e => e.includes('grew')))
  git('clone', '-q', '--depth=1', `file://${root}`, resolve(root, 'shallow'))
  assert.ok(auditSuppressions(resolve(root, 'shallow'), freeze(1)).some(e => e.includes('shallow')))
})
test('suppression removal/recreation and merge restoration cannot reopen a retired allowance', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'guanxi-eslint-merge-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'Gate Test', GIT_AUTHOR_EMAIL: 'gate@example.invalid', GIT_COMMITTER_NAME: 'Gate Test', GIT_COMMITTER_EMAIL: 'gate@example.invalid' } }).trim()
  const freeze = count => ({ 'packages/web/src/a.tsx': { 'guanxi/reuse-primitives': { count } } })
  const save = async data => { await writeFile(resolve(root, suppressionPath), JSON.stringify(data)); git('add', '.'); git('commit', '-qm', 'freeze') }
  git('init', '-q', '--initial-branch=main'); await save(freeze(2))
  git('checkout', '-qb', 'shrink'); await save(freeze(1))
  git('checkout', '-q', 'main'); git('merge', '--no-ff', '--no-commit', 'shrink'); await save(freeze(2))
  assert.ok(auditSuppressions(root, freeze(2)).some(e => e.includes('grew')))
  git('rm', '-q', suppressionPath); git('commit', '-qm', 'delete freeze'); await save(freeze(3))
  const errors = auditSuppressions(root, freeze(3))
  assert.ok(errors.some(e => e.includes('removed')))
  assert.ok(errors.some(e => e.includes('introduced more than once')))
})
test('G8 and G9 registered gates independently reject their own real overlaid seeds', async () => {
  const ctx = await createContext()
  for (const gate of gates) {
    const fixture = await ctx.json(gate.seed)
    const result = await gate.check(await ctx.withFiles(fixture.files))
    assert.equal(result.ok, false, gate.id)
    assert.ok(result.errors.some(e => e.includes(fixture.expectedError)), gate.id)
  }
})
