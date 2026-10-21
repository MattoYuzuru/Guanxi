/**
 * Scratch copies of the repository for seeded violations. Only the paths the catalog gates
 * read are copied; node_modules is linked so TypeScript resolves the same types.
 */
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const COPIED = [
  'packages/ui/src',
  'packages/ui/catalog',
  'packages/ui/generated',
  'packages/ui/fonts',
  'packages/ui/tsconfig.json',
  'packages/ui/package.json',
  'packages/web/src',
]

export interface Scratch {
  repoRoot: string
  uiRoot: string
  dispose(): void
}

export function createScratch(repoRoot: string): Scratch {
  const root = mkdtempSync(join(tmpdir(), 'guanxi-catalog-gate-'))
  for (const path of COPIED) {
    const from = join(repoRoot, path)
    if (!existsSync(from)) continue
    cpSync(from, join(root, path), {
      recursive: true,
      filter: (source) => !/[/\\](node_modules|dist)([/\\]|$)/.test(source),
    })
  }
  symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir')
  return { repoRoot: root, uiRoot: join(root, 'packages', 'ui'), dispose: () => rmSync(root, { recursive: true, force: true }) }
}

/**
 * Overlays a committed fixture directory onto the scratch repository: files are copied over,
 * `<name>.append` files are appended to `<name>`.
 */
export function overlay(fixtureDir: string, repoRoot: string): void {
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      const rel = relative(fixtureDir, full)
      if (rel.endsWith('.append')) {
        appendFileSync(join(repoRoot, rel.slice(0, -'.append'.length)), `\n${readFileSync(full, 'utf8')}`)
      } else {
        mkdirSync(join(repoRoot, rel, '..'), { recursive: true })
        cpSync(full, join(repoRoot, rel))
      }
    }
  }
  walk(fixtureDir)
}
