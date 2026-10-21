import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkLinks,
  listMarkdownFiles,
} from './check-doc-links.mjs'

const scriptPath = fileURLToPath(new URL('./check-doc-links.mjs', import.meta.url))

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doclinks-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, rel, text) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

function kinds(problems) {
  return problems.map(p => `${p.kind}@${p.line}`)
}

test('1. valid and missing relative file links', t => {
  const root = makeRoot(t)
  write(root, 'exists.md', '# Exists\n')
  write(root, 'doc.md', '# Doc\n\n[ok](exists.md)\n[bad](missing.md)\n')
  assert.deepEqual(kinds(checkLinks({ root, files: ['doc.md'] })), ['missing-file@4'])
})

test('2. a link to an existing directory is valid', t => {
  const root = makeRoot(t)
  fs.mkdirSync(path.join(root, 'sub'))
  write(root, 'doc.md', '# Doc\n\n[dir](sub)\n')
  assert.deepEqual(checkLinks({ root, files: ['doc.md'] }), [])
})

test('3. same-file fragments check headings', t => {
  const root = makeRoot(t)
  write(root, 'doc.md', '# Section\n\n[ok](#section)\n[bad](#nope)\n')
  assert.deepEqual(kinds(checkLinks({ root, files: ['doc.md'] })), ['missing-anchor@4'])
})

test('4. fragments are checked in another Markdown file', t => {
  const root = makeRoot(t)
  write(root, 'other.md', '# Heading Text\n')
  write(root, 'doc.md', '# Doc\n\n[other](other.md#heading-text)\n')
  assert.deepEqual(checkLinks({ root, files: ['doc.md'] }), [])
})

test('5. duplicate headings get numeric suffixes', t => {
  const root = makeRoot(t)
  write(root, 'doc.md', [
    '# Setup',
    '# Setup',
    '# Setup',
    '[a](#setup)',
    '[b](#setup-1)',
    '[c](#setup-2)',
    '[d](#setup-3)',
    '',
  ].join('\n'))
  assert.deepEqual(kinds(checkLinks({ root, files: ['doc.md'] })), ['missing-anchor@7'])
})

test('6. heading inline code, links and emphasis are reduced to text', t => {
  const root = makeRoot(t)
  write(root, 'x.md', '# X\n')
  write(root, 'doc.md', '## The `foo` [bar](x.md) *baz*\n\n[go](#the-foo-bar-baz)\n')
  assert.deepEqual(checkLinks({ root, files: ['doc.md'] }), [])
})

test('7. Cyrillic headings keep their letters', t => {
  const root = makeRoot(t)
  write(root, 'doc.md', '## Порядок запуска\n\n[go](#порядок-запуска)\n')
  assert.deepEqual(checkLinks({ root, files: ['doc.md'] }), [])
})

test('8. heading punctuation is removed by slugify', t => {
  const root = makeRoot(t)
  write(root, 'doc.md', '## D-158: relay (v1)?\n\n[go](#d-158-relay-v1)\n')
  assert.deepEqual(checkLinks({ root, files: ['doc.md'] }), [])
})

test('9. setext headings produce anchors', t => {
  const root = makeRoot(t)
  write(root, 'doc.md', [
    'Title One',
    '=========',
    '',
    'Title Two',
    '---',
    '',
    '[a](#title-one)',
    '[b](#title-two)',
    '',
  ].join('\n'))
  assert.deepEqual(checkLinks({ root, files: ['doc.md'] }), [])
})

test('10. explicit HTML anchors are collected', t => {
  const root = makeRoot(t)
  write(root, 'doc.md', '# Doc\n\n<a id="custom"></a>\n\n[go](#custom)\n')
  assert.deepEqual(checkLinks({ root, files: ['doc.md'] }), [])
})

test('11. links in fenced and inline code are ignored', t => {
  const root = makeRoot(t)
  write(root, 'doc.md', '# Doc\n\n`[inline](missing-inline.md)`\n\n```md\n[fenced](missing-fenced.md)\n```\n')
  assert.deepEqual(checkLinks({ root, files: ['doc.md'] }), [])
})

test('12. external and protocol-relative links are ignored', t => {
  const root = makeRoot(t)
  write(root, 'doc.md', [
    '# Doc',
    '',
    '[web](https://example.com/x)',
    '[mail](mailto:someone@example.com)',
    '[rel](//example.com/x)',
    '',
  ].join('\n'))
  assert.deepEqual(checkLinks({ root, files: ['doc.md'] }), [])
})

test('13. reference definitions are checked on their line', t => {
  const root = makeRoot(t)
  write(root, 'doc.md', '# Doc\n\n[ref]: missing.md\n')
  assert.deepEqual(kinds(checkLinks({ root, files: ['doc.md'] })), ['missing-file@3'])
})

test('14. image targets are checked', t => {
  const root = makeRoot(t)
  write(root, 'doc.md', '# Doc\n\n![x](img/missing.png)\n')
  const problems = checkLinks({ root, files: ['doc.md'] })
  assert.deepEqual(kinds(problems), ['missing-file@3'])
  assert.equal(problems[0].column, 2)
})

test('15. angle-bracket and percent-encoded targets resolve', t => {
  const root = makeRoot(t)
  write(root, 'dir with space/file.md', '# File\n')
  write(root, 'doc.md', [
    '# Doc',
    '',
    '[a](<dir with space/file.md>)',
    '[b](dir%20with%20space/file.md)',
    '',
  ].join('\n'))
  assert.deepEqual(checkLinks({ root, files: ['doc.md'] }), [])
})

test('16. machine-specific absolute paths are reported', t => {
  const root = makeRoot(t)
  write(root, 'doc.md', '# Doc\n\n[t](/Users/someone/file.md)\n')
  assert.deepEqual(kinds(checkLinks({ root, files: ['doc.md'] })), ['absolute-path@3'])
})

test('16b. links that leave the repository are reported even when the target exists', t => {
  const parent = makeRoot(t)
  write(parent, 'outside.md', '# Outside\n')
  write(parent, 'repo/doc.md', '# Doc\n\n[t](../outside.md)\n[u](sub/../../outside.md#outside)\n')
  const root = path.join(parent, 'repo')
  assert.deepEqual(kinds(checkLinks({ root, files: ['doc.md'] })), ['outside-root@3', 'outside-root@4'])
})

test('17. fragments on non-Markdown targets are not checked', t => {
  const root = makeRoot(t)
  write(root, 'code.ts', 'export const x = 1\n')
  write(root, 'doc.md', '# Doc\n\n[t](code.ts#L10)\n')
  assert.deepEqual(checkLinks({ root, files: ['doc.md'] }), [])
})

test('18. a link title is ignored and the target is checked', t => {
  const root = makeRoot(t)
  write(root, 'doc.md', '# Doc\n\n[t](missing.md "Title")\n')
  assert.deepEqual(kinds(checkLinks({ root, files: ['doc.md'] })), ['missing-file@3'])
})

test('19. discovery excludes generated and research trees', t => {
  const root = makeRoot(t)
  write(root, 'keep.md', '# Keep\n')
  write(root, 'node_modules/x/README.md', '# X\n\n[bad](missing.md)\n')
  write(root, 'docs/research/2026-10-21-fleet/a.md', '# A\n\n[bad](missing.md)\n')
  assert.deepEqual(listMarkdownFiles(root), ['keep.md'])
})

test('20. command line exit codes', t => {
  const root = makeRoot(t)
  write(root, 'clean.md', '# Clean\n')
  assert.equal(spawnSync(process.execPath, [scriptPath, root]).status, 0)

  write(root, 'broken.md', '# Broken\n\n[x](missing.md)\n')
  assert.equal(spawnSync(process.execPath, [scriptPath, root]).status, 1)
  assert.equal(spawnSync(process.execPath, [scriptPath, '--bogus']).status, 2)
})
