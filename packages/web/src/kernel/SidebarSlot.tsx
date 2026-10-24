/**
 * Renders the plugin-contributed sidebar list slot. Nothing but an empty
 * wrapper renders while no plugin contributes, so unloading the last
 * contributor removes the list. If the list held keyboard focus when it went
 * away, focus moves to the next control after the slot (or, when none follows, the nearest one
 * before it) instead of the page body.
 */
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { Link } from '../lib/router.tsx'
import { translate } from '../lib/locale.ts'
import { useLocale } from '../lib/locale-context.tsx'
import type { ListSlotEntry, SlotRegistry } from '@guanxi/kernel'
import { webKernel } from './runtime.ts'
import { SIDEBAR_SLOT, type SidebarEntry } from './slots.ts'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function SidebarSlot({ slots = webKernel.slots }: { slots?: SlotRegistry }) {
  useLocale()
  const subscribe = useCallback((listener: () => void) => slots.subscribe(listener), [slots])
  const snapshot = useCallback(() => slots.list<SidebarEntry>(SIDEBAR_SLOT), [slots])
  const entries = useSyncExternalStore(subscribe, snapshot) as readonly ListSlotEntry<SidebarEntry>[]
  const wrapper = useRef<HTMLDivElement>(null)
  const focusWasInside = useRef(false)
  // Read during render, before React removes a focused link from the DOM.
  focusWasInside.current = Boolean(wrapper.current?.contains(document.activeElement))

  useLayoutEffect(() => {
    if (!focusWasInside.current) return
    const root = wrapper.current
    if (!root || root.contains(document.activeElement)) return
    let next = root.nextElementSibling
    while (next) {
      const target = next.matches(FOCUSABLE) ? next : next.querySelector<HTMLElement>(FOCUSABLE)
      if (target instanceof HTMLElement) {
        target.focus()
        return
      }
      next = next.nextElementSibling
    }
    // Nothing focusable follows (the session list has no controls when it is empty): fall back to
    // the nearest focusable control before the slot, still never the page body.
    const before = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter(element => root.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING)
    before.at(-1)?.focus()
  }, [entries])

  return (
    <div ref={wrapper} data-slot="sidebar-slot">
      {entries.length > 0 && (
        <nav aria-label={translate('kernel.sidebar.navigation')} className="mb-2 border-b border-divider pb-2">
          <ul role="list" className="space-y-0.5">
            {entries.map((entry) => (
              <li key={entry.key} data-plugin-entry={entry.key} data-plugin-revision={entry.value.revision}>
                <Link
                  to={entry.value.href}
                  className="block rounded-control px-2 py-1.5 text-12 text-secondary hover:bg-inset hover:text-foreground"
                >
                  {translate(entry.value.labelKey)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  )
}
