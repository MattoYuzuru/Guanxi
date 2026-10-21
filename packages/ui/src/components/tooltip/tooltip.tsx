/*
 * Adapted from shadcn/ui (base) apps/v4/registry/bases/base/ui/tooltip.tsx
 * @ ba1503c64472b82256d9de95e2e62c5901a38e8b, MIT, Copyright (c) 2023 shadcn.
 * Modified by Guanxi contributors: portal container, semantic-token CSS, no arrow.
 */
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import type { ComponentProps } from 'react'
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

export function TooltipProvider(props: TooltipProviderProps) {
  return <TooltipPrimitive.Provider {...props} />
}

export function Tooltip(props: TooltipProps) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

export function TooltipTrigger(props: TooltipTriggerProps) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

export function TooltipContent({
  side = 'top',
  align = 'center',
  sideOffset = 6,
  className,
  ...props
}: TooltipContentProps) {
  const container = usePortalContainer()
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
          className={cx('gx-tooltip gx-pop', className)}
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}
