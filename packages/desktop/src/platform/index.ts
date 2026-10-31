import { darwin } from './darwin.ts'
import { generic } from './generic.ts'
import type { PlatformAdapter } from './types.ts'

export type { MenuContext, PlatformAdapter } from './types.ts'

/** The single dispatch point. U6 adds `case 'linux'`; Windows is not built (D-221). */
export function platformFor(platform: NodeJS.Platform): PlatformAdapter {
  switch (platform) {
    case 'darwin':
      return darwin
    default:
      return generic
  }
}
