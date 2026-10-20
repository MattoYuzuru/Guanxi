/*
 * Adapted from shadcn/ui (base) apps/v4/registry/bases/base/ui/select.tsx
 * @ ba1503c64472b82256d9de95e2e62c5901a38e8b, MIT, Copyright (c) 2023 shadcn.
 * Modified by Guanxi contributors: portal container, glass material, `invalid` prop, Lucide
 * icons, semantic-token CSS; scroll arrows dropped (the list scrolls natively).
 */
import { Select as SelectPrimitive } from '@base-ui/react/select'
import { Check, ChevronsUpDown } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cx } from '../../lib/cx.ts'
import { usePortalContainer } from '../../lib/portal.tsx'
import './select.css'

type WithClassName<T> = Omit<T, 'className'> & { className?: string }

export type SelectProps = ComponentProps<typeof SelectPrimitive.Root>
export type SelectValueProps = WithClassName<ComponentProps<typeof SelectPrimitive.Value>>
export type SelectItemProps = WithClassName<ComponentProps<typeof SelectPrimitive.Item>>
export type SelectGroupProps = ComponentProps<typeof SelectPrimitive.Group>
export type SelectGroupLabelProps = WithClassName<ComponentProps<typeof SelectPrimitive.GroupLabel>>

export interface SelectTriggerProps extends WithClassName<ComponentProps<typeof SelectPrimitive.Trigger>> {
  invalid?: boolean
}

export interface SelectContentProps extends WithClassName<ComponentProps<typeof SelectPrimitive.Popup>> {
  sideOffset?: number
}

export function Select(props: SelectProps) {
  return <SelectPrimitive.Root data-slot="select" {...props} />
}

export function SelectTrigger({ invalid, className, children, ...props }: SelectTriggerProps) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-invalid={invalid || undefined}
      aria-invalid={invalid || undefined}
      className={cx('gx-select-trigger gx-focusable', className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="gx-select-icon">
        <ChevronsUpDown aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

export function SelectValue({ className, ...props }: SelectValueProps) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cx('gx-select-value', className)}
      {...props}
    />
  )
}

export function SelectContent({ sideOffset = 6, className, children, ...props }: SelectContentProps) {
  const container = usePortalContainer()
  return (
    <SelectPrimitive.Portal container={container}>
      <SelectPrimitive.Positioner
        sideOffset={sideOffset}
        alignItemWithTrigger={false}
        className="gx-select-positioner"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cx('gx-select-content gx-glass gx-pop', className)}
          {...props}
        >
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

export function SelectItem({ className, children, ...props }: SelectItemProps) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cx('gx-select-item', className)}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="gx-select-item-indicator">
        <Check aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

export function SelectGroup(props: SelectGroupProps) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />
}

export function SelectGroupLabel({ className, ...props }: SelectGroupLabelProps) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-group-label"
      className={cx('gx-select-group-label', className)}
      {...props}
    />
  )
}
