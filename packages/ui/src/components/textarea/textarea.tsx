/*
 * Adapted from shadcn/ui (base) apps/v4/registry/bases/base/ui/textarea.tsx
 * @ ba1503c64472b82256d9de95e2e62c5901a38e8b, MIT, Copyright (c) 2023 shadcn.
 * Modified by Guanxi contributors: `invalid` prop, semantic-token CSS shared with Input.
 */
import type { ComponentProps } from 'react'
import { cx } from '../../lib/cx.ts'
import '../input/input.css'
import './textarea.css'

export interface TextareaProps extends Omit<ComponentProps<'textarea'>, 'className'> {
  /** Marks the value as invalid (`aria-invalid`); pair it with a visible message. */
  invalid?: boolean
  className?: string
}

export function Textarea({ invalid, className, rows = 3, ...props }: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      data-invalid={invalid || undefined}
      aria-invalid={invalid || undefined}
      rows={rows}
      className={cx('gx-textarea gx-focusable', className)}
      {...props}
    />
  )
}
