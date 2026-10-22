/*
 * Adapted from shadcn/ui (base) apps/v4/registry/bases/base/ui/tooltip.tsx
 * @ ba1503c64472b82256d9de95e2e62c5901a38e8b, MIT, Copyright (c) 2023 shadcn.
 * Modified by Guanxi contributors: portal container, semantic-token CSS, no arrow.
 */
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import { createContext, useContext, useId, useLayoutEffect, useState, type ComponentProps } from 'react'
import { cx } from '../../lib/cx.ts'
import { usePortalContainer } from '../../lib/portal.tsx'
import './tooltip.css'

export type TooltipProviderProps = ComponentProps<typeof TooltipPrimitive.Provider>
export type TooltipProps = ComponentProps<typeof TooltipPrimitive.Root>
export type TooltipTriggerProps = ComponentProps<typeof TooltipPrimitive.Trigger>

export interface TooltipContentProps
  extends Omit<ComponentProps<typeof TooltipPrimitive.Popup>, 'className'> {
  side?: ComponentProps<typeof TooltipPrimitive.Positioner>['side']
  align?: ComponentProps<typeof TooltipPrimitive.Positioner>['align']
  sideOffset?: number
  className?: string
}

// Base UI owns interaction/dismissal; this wrapper supplies the tooltip semantics.
const TooltipDescriptionContext = createContext<{
  open: boolean
  contentId: string
  setContentId(id: string): void
} | null>(null)

export function TooltipProvider(props: TooltipProviderProps) {
  return <TooltipPrimitive.Provider {...props} />
}

export function Tooltip({ open, defaultOpen = false, disabled, onOpenChange, ...props }: TooltipProps) {
  const generatedId = useId()
  const [contentId, setContentId] = useState(generatedId)
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  return (
    <TooltipDescriptionContext.Provider value={{ open: !disabled && (open ?? uncontrolledOpen), contentId, setContentId }}>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} open={open} defaultOpen={defaultOpen}
        disabled={disabled} onOpenChange={(next, details) => {
          onOpenChange?.(next, details)
          if (!details.isCanceled) setUncontrolledOpen(next)
        }} />
    </TooltipDescriptionContext.Provider>
  )
}

export function TooltipTrigger({ 'aria-describedby': describedBy, ...props }: TooltipTriggerProps) {
  const description = useContext(TooltipDescriptionContext)
  const ids = [...new Set([describedBy, description?.open ? description.contentId : undefined]
    .filter(Boolean).join(' ').split(/\s+/).filter(Boolean))].join(' ')
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} aria-describedby={ids || undefined} />
}

export function TooltipContent({
  side = 'top',
  align = 'center',
  sideOffset = 6,
  className,
  id,
  ...props
}: TooltipContentProps) {
  const container = usePortalContainer()
  const description = useContext(TooltipDescriptionContext)
  const fallbackId = useId()
  const contentId = id ?? fallbackId
  const setContentId = description?.setContentId
  useLayoutEffect(() => { setContentId?.(contentId) }, [contentId, setContentId])
  return (
    <TooltipPrimitive.Portal container={container}>
      <TooltipPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="gx-tooltip-positioner"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          role="tooltip"
          id={contentId}
          className={cx('gx-tooltip gx-pop', className)}
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}
