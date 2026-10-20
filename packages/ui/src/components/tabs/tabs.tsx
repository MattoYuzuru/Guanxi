/*
 * Adapted from shadcn/ui (base) apps/v4/registry/bases/base/ui/tabs.tsx
 * @ ba1503c64472b82256d9de95e2e62c5901a38e8b, MIT, Copyright (c) 2023 shadcn.
 * Modified by Guanxi contributors: one underline variant, Base UI indicator, semantic-token CSS.
 */
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs'
import type { ComponentProps } from 'react'
import { cx } from '../../lib/cx.ts'
import './tabs.css'

type WithClassName<T> = Omit<T, 'className'> & { className?: string }

export type TabsProps = WithClassName<ComponentProps<typeof TabsPrimitive.Root>>
export type TabsListProps = WithClassName<ComponentProps<typeof TabsPrimitive.List>>
export type TabsTabProps = WithClassName<ComponentProps<typeof TabsPrimitive.Tab>>
export type TabsPanelProps = WithClassName<ComponentProps<typeof TabsPrimitive.Panel>>

export function Tabs({ className, ...props }: TabsProps) {
  return <TabsPrimitive.Root data-slot="tabs" className={cx('gx-tabs', className)} {...props} />
}

export function TabsList({ className, children, activateOnFocus = true, ...props }: TabsListProps) {
  // Automatic activation: arrow keys select the tab they move to (panels here render at once).
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      activateOnFocus={activateOnFocus}
      className={cx('gx-tabs-list', className)}
      {...props}
    >
      {children}
      <TabsPrimitive.Indicator className="gx-tabs-indicator" />
    </TabsPrimitive.List>
  )
}

export function TabsTab({ className, ...props }: TabsTabProps) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-tab"
      className={cx('gx-tabs-tab gx-focusable', className)}
      {...props}
    />
  )
}

export function TabsPanel({ className, ...props }: TabsPanelProps) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-panel"
      className={cx('gx-tabs-panel gx-focusable', className)}
      {...props}
    />
  )
}
