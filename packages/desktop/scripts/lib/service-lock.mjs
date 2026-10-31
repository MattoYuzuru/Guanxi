// The shipped service's node_modules must be the tree the repository already locked and tested, not whatever
// `npm install` would resolve today. This derives, from the root package-lock.json, the lock of the CLI
// workspace's production subtree: every reachable package at the path the root lock gave it (so each package
// still finds its dependencies exactly where it did), with the workspace's own nested modules lifted to the top.
// `npm ci` on the result then reproduces that tree and verifies every integrity hash.

const WORKSPACE_PREFIX = (workspace) => `${workspace}/node_modules/`

/** Directory that holds `node_modules` for a lock path: '' for the root, `a/b` for `a/b/node_modules/x`. */
function parentOf(path) {
  const cut = path.lastIndexOf('/node_modules/')
  return cut >= 0 ? path.slice(0, cut) : ''
}

/** Node resolution over lock paths: the nearest `node_modules/<name>` walking up from `from`. */
function resolveFrom(packages, from, name) {
  let location = from
  for (;;) {
    const candidate = `${location === '' ? '' : `${location}/`}node_modules/${name}`
    if (packages[candidate]) return candidate
    if (location === '') return null
    location = parentOf(location)
  }
}

export class ServiceLockError extends Error {}

/**
 * @param {{ packages: Record<string, any> }} rootLock parsed root package-lock.json (lockfileVersion 2 or 3)
 * @param {{ workspace: string, name: string, version: string }} options workspace lock path (e.g. 'packages/cli') and the staged package
 * @returns {{ name: string, version: string, lockfileVersion: number, requires: boolean, packages: Record<string, any> }}
 */
export function serviceLock(rootLock, { workspace, name, version }) {
  const packages = rootLock.packages
  const entry = packages?.[workspace]
  if (!entry) throw new ServiceLockError(`Workspace ${workspace} is not in the root lockfile`)
  const dependencies = entry.dependencies ?? {}
  const staged = {}
  const origin = {}
  const queue = []

  const place = (lockPath) => {
    const target = lockPath.startsWith(WORKSPACE_PREFIX(workspace)) ? lockPath.slice(workspace.length + 1) : lockPath
    if (origin[target] !== undefined && origin[target] !== lockPath) {
      throw new ServiceLockError(`Two different packages want ${target}: ${origin[target]} and ${lockPath}; nest one by hand`)
    }
    if (origin[target] === lockPath) return
    origin[target] = lockPath
    const source = packages[lockPath]
    if (source.link) throw new ServiceLockError(`${lockPath} is a workspace link; the service must not depend on workspace packages`)
    const copy = { ...source }
    // Flags relative to the whole monorepo are meaningless in this subtree (everything here is production).
    delete copy.dev
    delete copy.devOptional
    delete copy.peer
    staged[target] = copy
    queue.push(lockPath)
  }

  const reach = (from, dependencyNames, { optional }) => {
    for (const dependency of dependencyNames) {
      const found = resolveFrom(packages, from, dependency)
      if (found === null) {
        if (optional) continue
        throw new ServiceLockError(`${dependency} (needed by ${from || 'the root'}) is not in the root lockfile`)
      }
      place(found)
    }
  }

  reach(workspace, Object.keys(dependencies), { optional: false })
  while (queue.length > 0) {
    const lockPath = queue.shift()
    const source = packages[lockPath]
    reach(lockPath, Object.keys(source.dependencies ?? {}), { optional: false })
    reach(lockPath, Object.keys(source.optionalDependencies ?? {}), { optional: true })
    const optionalPeers = new Set(Object.entries(source.peerDependenciesMeta ?? {}).filter(([, meta]) => meta?.optional).map(([peerName]) => peerName))
    reach(lockPath, Object.keys(source.peerDependencies ?? {}).filter((peerName) => !optionalPeers.has(peerName)), { optional: false })
  }

  // Lifting nested modules of the workspace to the top can shadow a different version that a hoisted package
  // resolves through the parent chain; the collision check above reports that case instead of guessing.
  return {
    name,
    version,
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name, version, dependencies }, ...Object.fromEntries(Object.entries(staged).sort(([a], [b]) => (a < b ? -1 : 1))) },
  }
}
