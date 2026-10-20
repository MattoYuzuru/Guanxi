import { join } from 'node:path'

/** Layout of @guanxi/ui inside a checkout; every reader and writer goes through here. */
export function uiPaths(uiRoot: string) {
  return {
    uiRoot,
    components: join(uiRoot, 'src', 'components'),
    snapshots: join(uiRoot, 'catalog', 'snapshots'),
    trustedKeys: join(uiRoot, 'catalog', 'approval-keys.json'),
    manifest: join(uiRoot, 'catalog', 'manifest.json'),
    componentDir: (id: string) => join(uiRoot, 'src', 'components', id),
    reviewFile: (id: string) => join(uiRoot, 'src', 'components', id, `${id}.review.json`),
  }
}
