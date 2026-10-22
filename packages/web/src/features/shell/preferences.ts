import { PRODUCT_FILE_PREFIX } from '../../lib/brand.ts'

export interface ShellPreferences {
  side: 'left' | 'right'
  visibility: 'expanded' | 'rail' | 'hidden'
  pinned: string[]
}
export const SHELL_PREFERENCES_KEY = `${PRODUCT_FILE_PREFIX}.shell.preferences.v1`
export const defaultShellPreferences = (): ShellPreferences => ({ side: 'left', visibility: 'expanded', pinned: [] })

/** Only presentation choices and opaque session references; never titles or transcript content. */
export function readShellPreferences(): ShellPreferences {
  try {
    const data: unknown = JSON.parse(window.localStorage.getItem(SHELL_PREFERENCES_KEY) ?? 'null')
    if (!data || typeof data !== 'object' || Array.isArray(data)) return defaultShellPreferences()
    const value = data as Record<string, unknown>
    return {
      side: value.side === 'right' ? 'right' : 'left',
      visibility: value.visibility === 'rail' || value.visibility === 'hidden' ? value.visibility : 'expanded',
      pinned: Array.isArray(value.pinned) ? [...new Set(value.pinned.filter((id): id is string => typeof id === 'string' && id.length > 0))] : [],
    }
  } catch { return defaultShellPreferences() }
}
export function writeShellPreferences(value: ShellPreferences): void {
  try { window.localStorage.setItem(SHELL_PREFERENCES_KEY, JSON.stringify(value)) } catch { /* Remain usable when browser storage is unavailable. */ }
}
