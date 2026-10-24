import type { SessionPageNavigation } from '@guanxi/contract'
import { paths } from '../../lib/router.tsx'

/**
 * Only the node's verified navigation projection chooses an executable session view. A chat opens
 * as the full-width session timeline (round 4, owner feedback 2026-10-23); the free panel
 * arrangement (`/workspace/…`) stays one menu item away, never the default.
 */
export function sessionNavigationPath(navigation: SessionPageNavigation): string {
  if (navigation.kind === 'native') return paths.agent(navigation.sessionId)
  if (navigation.kind === 'chat') return navigation.projectId ? paths.projectChat(navigation.projectId, navigation.threadId) : paths.chat(navigation.threadId)
  return paths.inspector(navigation.sessionId)
}

/** Every view that shows the session: its navigation target and, for a chat, the free arrangement. */
export function sessionViewPaths(navigation: SessionPageNavigation): string[] {
  const target = sessionNavigationPath(navigation)
  return navigation.kind === 'chat' ? [target, paths.workspace(navigation.threadId, navigation.projectId), paths.workspace(navigation.threadId)] : [target]
}
