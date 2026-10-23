import { useSyncExternalStore } from 'react'

/**
 * The project of the view on screen, for "new session opens in the current project" (D-207).
 * A page that knows its project (an open native session) publishes it while mounted; the shell
 * falls back to the project in the route. Opaque ids only.
 */
let current: string | null = null, owner: symbol | undefined
const listeners = new Set<() => void>()
const notify = () => { for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

export function publishCurrentProject(writer: symbol, projectId: string | null): void {
  owner = writer
  if (current === projectId) return
  current = projectId
  notify()
}

export function clearCurrentProject(writer: symbol): void {
  if (owner !== writer) return
  owner = undefined
  if (current === null) return
  current = null
  notify()
}

export function useCurrentProject(): string | null {
  return useSyncExternalStore(subscribe, () => current)
}

/** The project a route names: project chats, or a workspace or new session with `?project=`. */
export function projectFromLocation(location: string): string | null {
  const [path = '/', search = ''] = location.split('?')
  const chats = /^\/projects\/([^/]+)\/chats(?:\/|$)/u.exec(path)
  if (chats) return decodeURIComponent(chats[1]!)
  const query = new URLSearchParams(search).get('project')
  return query && query.length > 0 ? query : null
}
