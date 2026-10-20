/*
 * Adapted from shadcn/ui (base) apps/v4/registry/bases/base/ui/checkbox.tsx
 * @ ba1503c64472b82256d9de95e2e62c5901a38e8b, MIT, Copyright (c) 2023 shadcn.
 * Modified by Guanxi contributors: optional visible label, indeterminate glyph, Lucide icons,
 * semantic-token CSS.
 */
import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox'
import { Check, Minus } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cx } from '../../lib/cx.ts'
import './checkbox.css'

export interface CheckboxProps extends Omit<ComponentProps<typeof CheckboxPrimitive.Root>, 'className'> {
  /** Visible label; the whole row becomes the target. Without it, pass `aria-label`. */
  label?: ReactNode
  className?: string
}

export function Checkbox({ label, className, indeterminate, ...props }: CheckboxProps) {
  const box = (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      indeterminate={indeterminate}
      className={cx('gx-checkbox gx-focusable', className)}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="gx-checkbox-indicator" keepMounted={false}>
        {indeterminate ? <Minus aria-hidden="true" /> : <Check aria-hidden="true" />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
  if (label === undefined) return box
  return (
    <label className="gx-choice" data-disabled={props.disabled || undefined}>
      {box}
      <span className="gx-choice-label">{label}</span>
    </label>
  )
}
