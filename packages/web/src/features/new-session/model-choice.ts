import { PRODUCT_FILE_PREFIX } from '../../lib/brand.ts'

/** Per-browser convenience only: one opaque connection id and one model ID, never a key. */
export const LAST_MODEL_CHOICE_KEY = `${PRODUCT_FILE_PREFIX}.newSession.modelChoice.v1`

export interface ModelChoice {
  connectionId: string
  model: string
}

export function readLastModelChoice(): ModelChoice | null {
  try {
    const data: unknown = JSON.parse(window.localStorage.getItem(LAST_MODEL_CHOICE_KEY) ?? 'null')
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    const value = data as Record<string, unknown>
    if (typeof value.connectionId !== 'string' || !value.connectionId) return null
    if (typeof value.model !== 'string' || !value.model.trim()) return null
    return { connectionId: value.connectionId, model: value.model.trim() }
  } catch {
    return null
  }
}

export function rememberModelChoice(connectionId: string, model: string): void {
  if (!connectionId || !model.trim()) return
  try {
    window.localStorage.setItem(LAST_MODEL_CHOICE_KEY, JSON.stringify({ connectionId, model: model.trim() }))
  } catch {
    // A blocked store only loses the convenience.
  }
}
