/*
 * Adapted from shadcn/ui (base) apps/v4/registry/bases/base/ui/switch.tsx
 * @ ba1503c64472b82256d9de95e2e62c5901a38e8b, MIT, Copyright (c) 2023 shadcn.
 * Modified by Guanxi contributors: optional visible label, semantic-token CSS, motion tokens.
 */
import { Switch as SwitchPrimitive } from '@base-ui/react/switch'
import type { ComponentProps, ReactNode } from 'react'
import { cx } from '../../lib/cx.ts'
import '../checkbox/checkbox.css'
import './switch.css'

export interface SwitchProps extends Omit<ComponentProps<typeof SwitchPrimitive.Root>, 'className'> {
  /** Visible label; the whole row becomes the target. Without it, pass `aria-label`. */
  label?: ReactNode
  className?: string
}

export function Switch({ label, className, ...props }: SwitchProps) {
  const control = (
    <SwitchPrimitive.Root data-slot="switch" className={cx('gx-switch gx-focusable', className)} {...props}>
      <SwitchPrimitive.Thumb className="gx-switch-thumb" />
    </SwitchPrimitive.Root>
  )
  if (label === undefined) return control
  return (
    <label className="gx-choice" data-disabled={props.disabled || undefined}>
      {control}
      <span>{label}</span>
    </label>
  )
}
