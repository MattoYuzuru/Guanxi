/*
 * Adapted from shadcn/ui (base) apps/v4/registry/bases/base/ui/input.tsx
 * @ ba1503c64472b82256d9de95e2e62c5901a38e8b, MIT, Copyright (c) 2023 shadcn.
 * Modified by Guanxi contributors: `invalid` prop, semantic-token CSS.
 */
import { Input as InputPrimitive } from '@base-ui/react/input'
import type { ComponentProps } from 'react'
import { cx } from '../../lib/cx.ts'
import './input.css'

export interface InputProps extends Omit<ComponentProps<typeof InputPrimitive>, 'className'> {
  /** Marks the value as invalid (`aria-invalid`); pair it with a visible message. */
  invalid?: boolean
  className?: string
}

export function Input({ invalid, className, ...props }: InputProps) {
  return (
    <InputPrimitive
      data-slot="input"
      data-invalid={invalid || undefined}
      aria-invalid={invalid || undefined}
      className={cx('gx-input gx-focusable', className)}
      {...props}
    />
  )
}
