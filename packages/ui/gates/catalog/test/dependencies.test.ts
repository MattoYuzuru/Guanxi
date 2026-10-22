/**
 * Pure tests for the component dependency scanner: the graph must follow value aliases,
 * helper barrels and re-exports, terminate cycles, ignore type-only/story edges and report
 * runtime relative imports it cannot resolve instead of dropping them.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { scanComponentDependencies } from '../../../catalog/tooling/dependencies.ts'

interface Tree {
  uiRoot: string
  dispose(): void
}

function tree(files: Record<string, string>): Tree {
  const root = mkdtempSync(join(tmpdir(), 'guanxi-component-deps-'))
  const uiRoot = join(root, 'packages', 'ui')
  for (const [path, text] of Object.entries(files)) {
    const file = join(uiRoot, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  return { uiRoot, dispose: () => rmSync(root, { recursive: true, force: true }) }
}

describe('scanComponentDependencies', () => {
  it('follows helper barrels, aliases and two-hop value imports', () => {
    const subject = tree({
      'src/components/a/index.ts': "export { A } from './a.tsx'\n",
      'src/components/a/a.tsx': "import { Alias } from '../../lib/barrel.ts'\nexport function A() { return <Alias /> }\n",
      'src/lib/barrel.ts': "export { B as Alias } from '../components/b/index.ts'\n",
      'src/components/b/index.ts': "export { B } from './b.tsx'\n",
      'src/components/b/b.tsx': "import { C } from '../c/c.tsx'\nexport function B() { return <C /> }\n",
      'src/components/c/c.tsx': 'export function C() { return null }\n',
    })
    try {
      const scan = scanComponentDependencies(subject.uiRoot, ['a'])
      assert.deepEqual([...(scan.closures.get('a') ?? [])].sort(), ['a', 'b', 'c'])
      assert.deepEqual(scan.unresolved, [])
    } finally {
      subject.dispose()
    }
  })

  it('preserves a named-import barrel runtime side effect', () => {
    const subject = tree({
      'src/components/a/index.ts': "export { A } from './a.tsx'\n",
      'src/components/a/a.tsx': "import { B } from '../../lib/barrel.ts'\nexport const A = B\n",
      'src/lib/barrel.ts': "import '../components/c/c.tsx'\nexport { B } from '../components/b/b.tsx'\n",
      'src/components/b/b.tsx': 'export function B() { return null }\n',
      'src/components/c/c.tsx': 'export function C() { return null }\nconsole.log(C)\n',
    })
    try {
      const scan = scanComponentDependencies(subject.uiRoot, ['a'])
      assert.deepEqual([...(scan.closures.get('a') ?? [])].sort(), ['a', 'b', 'c'])
      assert.deepEqual(scan.unresolved, [])
    } finally {
      subject.dispose()
    }
  })

  it('preserves a named-export barrel runtime side effect', () => {
    const subject = tree({
      'src/components/a/index.ts': "export { A } from '../../lib/barrel.ts'\n",
      'src/components/a/a.tsx': 'export function A() { return null }\n',
      'src/lib/barrel.ts': "import '../components/c/c.tsx'\nexport { A } from '../components/a/a.tsx'\n",
      'src/components/c/c.tsx': 'export function C() { return null }\n',
    })
    try {
      const scan = scanComponentDependencies(subject.uiRoot, ['a'])
      assert.deepEqual([...(scan.closures.get('a') ?? [])].sort(), ['a', 'c'])
      assert.deepEqual(scan.unresolved, [])
    } finally {
      subject.dispose()
    }
  })

  it('reports a resolved runtime import outside the UI source root instead of following it', () => {
    const subject = tree({
      'src/components/a/index.ts': "export { A } from './a.tsx'\n",
      'src/components/a/a.tsx': "import './a.css'\nimport { outside } from '../../../outside.ts'\nexport const A = outside\n",
      'outside.ts': "import { C } from './src/components/c/c.tsx'\nexport const outside = C\n",
      'src/components/c/c.tsx': 'export function C() { return null }\n',
    })
    try {
      const scan = scanComponentDependencies(subject.uiRoot, ['a'])
      assert.deepEqual([...(scan.closures.get('a') ?? [])], ['a'])
      assert.deepEqual(scan.unresolved, [{ file: 'src/components/a/a.tsx', specifier: '../../../outside.ts' }])
    } finally {
      subject.dispose()
    }
  })

  it('terminates cycles and still reaches a draft beyond the cycle', () => {
    const subject = tree({
      'src/components/a/index.ts': "export { A } from './a.tsx'\n",
      'src/components/a/a.tsx': "import { B } from '../b/index.ts'\nexport function A() { return <B /> }\n",
      'src/components/b/index.ts': "export { B } from './b.tsx'\n",
      'src/components/b/b.tsx': "import { A } from '../a/index.ts'\nimport { C } from '../c/c.tsx'\nexport function B() { return <A /><C /> }\n",
      'src/components/c/c.tsx': 'export function C() { return null }\n',
    })
    try {
      const scan = scanComponentDependencies(subject.uiRoot, ['a'])
      assert.deepEqual([...(scan.closures.get('a') ?? [])].sort(), ['a', 'b', 'c'])
    } finally {
      subject.dispose()
    }
  })

  it('skips type-only, story/test and external edges', () => {
    const subject = tree({
      'src/components/a/index.ts': "export { A } from './a.tsx'\n",
      'src/components/a/a.tsx': [
        "import type { CProps } from '../c/c.tsx'",
        "import { StoryOnly } from './a.stories.tsx'",
        "import { External } from 'external-package'",
        'export function A(_props: CProps) { return <StoryOnly /> }',
        'export function E() { return <External /> }',
        '',
      ].join('\n'),
      'src/components/a/a.stories.tsx': "import { D } from '../d/d.tsx'\nexport const StoryOnly = () => <D />\n",
      'src/components/c/c.tsx': 'export interface CProps { value: string }\nexport function C() { return null }\n',
      'src/components/d/d.tsx': 'export function D() { return null }\n',
    })
    try {
      const scan = scanComponentDependencies(subject.uiRoot, ['a'])
      assert.deepEqual([...(scan.closures.get('a') ?? [])].sort(), ['a'])
      assert.deepEqual(scan.unresolved, [])
    } finally {
      subject.dispose()
    }
  })

  it('reports an unresolvable runtime relative import instead of dropping it', () => {
    const subject = tree({
      'src/components/a/index.ts': "export { A } from './a.tsx'\n",
      'src/components/a/a.tsx': "import { Missing } from '../missing/missing.tsx'\nexport function A() { return <Missing /> }\n",
    })
    try {
      const scan = scanComponentDependencies(subject.uiRoot, ['a'])
      assert.deepEqual(scan.unresolved, [{ file: 'src/components/a/a.tsx', specifier: '../missing/missing.tsx' }])
    } finally {
      subject.dispose()
    }
  })

  it('reports a computed dynamic import as unsupported', () => {
    const subject = tree({
      'src/components/a/index.ts': "export { A } from './a.tsx'\n",
      'src/components/a/a.tsx': 'export function A(name: string) { return import(`./${name}.ts`) }\n',
    })
    try {
      const scan = scanComponentDependencies(subject.uiRoot, ['a'])
      assert.deepEqual(scan.unresolved, [{ file: 'src/components/a/a.tsx', specifier: '<computed dynamic import>' }])
    } finally {
      subject.dispose()
    }
  })
})
