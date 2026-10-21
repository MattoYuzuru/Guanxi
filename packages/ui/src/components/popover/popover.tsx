/*
 * Adapted from shadcn/ui (base) apps/v4/registry/bases/base/ui/popover.tsx
 * @ ba1503c64472b82256d9de95e2e62c5901a38e8b, MIT, Copyright (c) 2023 shadcn.
 * Modified by Guanxi contributors: portal container, glass material, semantic-token CSS.
 */
import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import type { ComponentProps } from 'react'
import { cx } from '../../lib/cx.ts'
import { usePortalContainer } from '../../lib/portal.tsx'
import './popover.css'

type WithClassName<T> = Omit<T, 'className'> & { className?: string }

export type PopoverProps = ComponentProps<typeof PopoverPrimitive.Root>
export type PopoverTriggerProps = ComponentProps<typeof PopoverPrimitive.Trigger>
export type PopoverCloseProps = ComponentProps<typeof PopoverPrimitive.Close>
export type PopoverTitleProps = WithClassName<ComponentProps<typeof PopoverPrimitive.Title>>
export type PopoverDescriptionProps = WithClassName<
  ComponentProps<typeof PopoverPrimitive.Description>
>

export interface PopoverContentProps
  extends WithClassName<ComponentProps<typeof PopoverPrimitive.Popup>> {
  side?: ComponentProps<typeof PopoverPrimitive.Positioner>['side']
  align?: ComponentProps<typeof PopoverPrimitive.Positioner>['align']
  sideOffset?: number
}

export function Popover(props: PopoverProps) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

export function PopoverTrigger(props: PopoverTriggerProps) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

export function PopoverClose(props: PopoverCloseProps) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />
}

export function PopoverContent({
  side = 'bottom',
  align = 'start',
  sideOffset = 6,
  className,
  ...props
}: PopoverContentProps) {
  const container = usePortalContainer()
  return (
    <PopoverPrimitive.Portal container={container}>
      <PopoverPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="gx-popover-positioner"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cx('gx-popover gx-glass gx-pop', className)}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export function PopoverTitle({ className, ...props }: PopoverTitleProps) {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      className={cx('gx-popover-title', className)}
      {...props}
    />
  )
}

export function PopoverDescription({ className, ...props }: PopoverDescriptionProps) {
  return (
    <PopoverPrimitive.Description
      data-slot="popover-description"
      className={cx('gx-popover-description', className)}
      {...props}
    />
  )
}
