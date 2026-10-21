import { createContext, useContext, type ReactNode } from 'react'

/**
 * Where floating layers (popover, menu, tooltip, select, dialog, toast) mount. The app shell
 * and each catalog regime frame provide an element inside their themed subtree, so portalled
 * content inherits the same theme, density, glass and motion tokens. Without a provider,
 * Base UI falls back to document.body.
 */
const PortalContainerContext = createContext<HTMLElement | null>(null)

export function PortalContainerProvider({
  container,
  children,
}: {
  container: HTMLElement | null
  children: ReactNode
}) {
  return (
    <PortalContainerContext.Provider value={container}>{children}</PortalContainerContext.Provider>
  )
}

export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext) ?? undefined
}
