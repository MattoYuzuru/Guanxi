import type { SessionPageNavigation } from '@guanxi/contract'
import { paths } from '../../lib/router.tsx'

/** Only the node's verified navigation projection chooses an executable session view. */
export function sessionNavigationPath(navigation: SessionPageNavigation): string {
  if (navigation.kind === 'native') return paths.agent(navigation.sessionId)
  if (navigation.kind === 'chat') return paths.workspace(navigation.threadId, navigation.projectId)
  return paths.inspector(navigation.sessionId)
}
