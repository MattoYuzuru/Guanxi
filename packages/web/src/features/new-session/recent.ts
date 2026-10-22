import { PRODUCT_FILE_PREFIX } from '../../lib/brand.ts'

export const RECENT_PROJECTS_KEY = `${PRODUCT_FILE_PREFIX}.newSession.recentProjects.v1`

/** Opaque project ids only, newest first; never names, prompts or paths. */
export function readRecentProjects(): string[] {
  try {
    const data: unknown = JSON.parse(window.localStorage.getItem(RECENT_PROJECTS_KEY) ?? 'null')
    if (!Array.isArray(data)) return []
    return [...new Set(data.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  } catch { return [] }
}

/** Moves the project to the front. A blocked store only loses the convenience. */
export function rememberProject(projectId: string): string[] {
  const next = [projectId, ...readRecentProjects().filter(id => id !== projectId)]
  try { window.localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next)) } catch { /* Per-viewer convenience only. */ }
  return next
}
