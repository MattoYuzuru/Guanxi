/**
 * Renders the plugin-contributed sidebar list slot. Nothing is rendered while
 * no plugin contributes, so unloading the last contributor removes the list.
 */
import { useSyncExternalStore } from 'react'
import { Link } from '../lib/router.tsx'
import { translate } from '../lib/locale.ts'
import { useLocale } from '../lib/locale-context.tsx'
import type { ListSlotEntry, SlotRegistry } from '@guanxi/kernel'
import { webKernel } from './runtime.ts'
import { SIDEBAR_SLOT, type SidebarEntry } from './slots.ts'

export function SidebarSlot({ slots = webKernel.slots }: { slots?: SlotRegistry }) {
  useLocale()
  const entries = useSyncExternalStore(
    (listener) => slots.subscribe(listener),
    () => slots.list<SidebarEntry>(SIDEBAR_SLOT),
  ) as readonly ListSlotEntry<SidebarEntry>[]
  if (entries.length === 0) return null
  return (
    <nav aria-label={translate('kernel.sidebar.navigation')} className="mb-2 border-b border-[var(--border)] pb-2">
      <ul className="space-y-0.5">
        {entries.map((entry) => (
          <li key={entry.key} data-plugin-entry={entry.key} data-plugin-revision={entry.value.revision}>
            <Link
              to={entry.value.href}
              className="block rounded-md px-2 py-1.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]"
            >
              {translate(entry.value.labelKey)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
