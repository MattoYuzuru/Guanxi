import type { LocaleKey } from '../lib/locale.ts'

/** The chat sidebar's list slot (K1): plugins add navigation entries here. */
export const SIDEBAR_SLOT = 'sidebar.items'

export interface SidebarEntry {
  readonly labelKey: LocaleKey
  readonly href: string
  /** Identifies the module evaluation that contributed the entry; changes on hot update. */
  readonly revision: string
}
