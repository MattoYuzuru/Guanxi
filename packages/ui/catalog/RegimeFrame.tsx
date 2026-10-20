import { useState, type ReactNode } from 'react'
import { UiLocaleProvider } from '../src/i18n/context.tsx'
import { PortalContainerProvider } from '../src/lib/portal.tsx'
import { regimeAttributes, type Regime } from './regimes.ts'

/**
 * A themed subtree with its own portal container, so popovers, menus, dialogs and toasts of a
 * story inherit the same tokens and stay inside the frame.
 */
export function RegimeFrame({
  regime,
  className,
  children,
  label,
}: {
  regime: Regime
  className?: string
  children: ReactNode
  label?: string
}) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <div {...regimeAttributes(regime)} className={className} data-gx-regime="" aria-label={label} role={label ? 'group' : undefined}>
      <UiLocaleProvider locale={regime.locale}>
        <PortalContainerProvider container={container}>{children}</PortalContainerProvider>
      </UiLocaleProvider>
      <div ref={setContainer} className="gx-catalog-portal" />
    </div>
  )
}
