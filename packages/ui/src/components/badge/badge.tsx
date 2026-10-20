/*
 * Adapted from shadcn/ui (base) apps/v4/registry/bases/base/ui/badge.tsx
 * @ ba1503c64472b82256d9de95e2e62c5901a38e8b, MIT, Copyright (c) 2023 shadcn.
 * Modified by Guanxi contributors: Guanxi tones, plain span, semantic-token CSS.
 */
import type { ComponentProps } from 'react'
import { cx } from '../../lib/cx.ts'
import './badge.css'

export type BadgeTone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger'

export interface BadgeProps extends Omit<ComponentProps<'span'>, 'className'> {
  /** Colour role; the text itself must carry the meaning. */
  tone?: BadgeTone
  className?: string
}

export function Badge({ tone = 'neutral', className, ...props }: BadgeProps) {
  return <span data-slot="badge" data-tone={tone} className={cx('gx-badge', className)} {...props} />
}
