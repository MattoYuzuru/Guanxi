/*
 * Adapted from shadcn/ui (base) apps/v4/registry/bases/base/ui/dropdown-menu.tsx
 * @ ba1503c64472b82256d9de95e2e62c5901a38e8b, MIT, Copyright (c) 2023 shadcn.
 * Modified by Guanxi contributors: renamed to Menu, portal container, glass material, danger
 * item variant, semantic-token CSS; submenus and checkbox items are left for later.
 */
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import type { ComponentProps } from 'react'
import { cx } from '../../lib/cx.ts'
import { usePortalContainer } from '../../lib/portal.tsx'
import './menu.css'

type WithClassName<T> = Omit<T, 'className'> & { className?: string }

export type MenuProps = ComponentProps<typeof MenuPrimitive.Root>
export type MenuTriggerProps = ComponentProps<typeof MenuPrimitive.Trigger>
export type MenuGroupProps = ComponentProps<typeof MenuPrimitive.Group>
export type MenuGroupLabelProps = WithClassName<ComponentProps<typeof MenuPrimitive.GroupLabel>>
export type MenuSeparatorProps = WithClassName<ComponentProps<typeof MenuPrimitive.Separator>>

export interface MenuContentProps extends WithClassName<ComponentProps<typeof MenuPrimitive.Popup>> {
  side?: ComponentProps<typeof MenuPrimitive.Positioner>['side']
  align?: ComponentProps<typeof MenuPrimitive.Positioner>['align']
  sideOffset?: number
}

export interface MenuItemProps extends WithClassName<ComponentProps<typeof MenuPrimitive.Item>> {
  /** `danger` for a destructive item; it still needs a confirmation that states the effect. */
  variant?: 'default' | 'danger'
}

export function Menu(props: MenuProps) {
  return <MenuPrimitive.Root data-slot="menu" {...props} />
}

export function MenuTrigger(props: MenuTriggerProps) {
  return <MenuPrimitive.Trigger data-slot="menu-trigger" {...props} />
}

export function MenuContent({
  side = 'bottom',
  align = 'start',
  sideOffset = 6,
  className,
  ...props
}: MenuContentProps) {
  const container = usePortalContainer()
  return (
    <MenuPrimitive.Portal container={container}>
      <MenuPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="gx-menu-positioner"
      >
        <MenuPrimitive.Popup
          data-slot="menu-content"
          className={cx('gx-menu gx-glass gx-pop', className)}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

export function MenuItem({ variant = 'default', className, ...props }: MenuItemProps) {
  return (
    <MenuPrimitive.Item
      data-slot="menu-item"
      data-variant={variant}
      className={cx('gx-menu-item', className)}
      {...props}
    />
  )
}

export function MenuGroup(props: MenuGroupProps) {
  return <MenuPrimitive.Group data-slot="menu-group" {...props} />
}

export function MenuGroupLabel({ className, ...props }: MenuGroupLabelProps) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="menu-group-label"
      className={cx('gx-menu-group-label', className)}
      {...props}
    />
  )
}

export function MenuSeparator({ className, ...props }: MenuSeparatorProps) {
  return (
    <MenuPrimitive.Separator
      data-slot="menu-separator"
      className={cx('gx-menu-separator', className)}
      {...props}
    />
  )
}
