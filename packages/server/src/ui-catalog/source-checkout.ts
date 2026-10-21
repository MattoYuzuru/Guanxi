import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Finds `packages/ui` of the source checkout that contains `fromDir`: the nearest ancestor
 * with both a `.git` entry (directory or worktree file) and `packages/ui/src/components`.
 * Returns null for installed packages, which have neither.
 */
export function findSourceCheckoutUiRoot(fromDir: string): string | null {
  let dir = fromDir
  for (;;) {
    const uiRoot = join(dir, 'packages', 'ui')
    if (existsSync(join(dir, '.git')) && existsSync(join(uiRoot, 'src', 'components'))) return uiRoot
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
