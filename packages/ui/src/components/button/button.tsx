/*
 * Adapted from shadcn/ui (base) apps/v4/registry/bases/base/ui/button.tsx
 * @ ba1503c64472b82256d9de95e2e62c5901a38e8b, MIT, Copyright (c) 2023 shadcn.
 * Modified by Guanxi contributors: Guanxi variants, loading state, semantic-token CSS instead
 * of Tailwind classes.
 */
import { Button as ButtonPrimitive } from '@base-ui/react/button'
import type { ComponentProps } from 'react'
import { useUiText } from '../../i18n/context.tsx'
import { cx } from '../../lib/cx.ts'
import './button.css'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends Omit<ComponentProps<typeof ButtonPrimitive>, 'className'> {
  /** Visual weight. `primary` is the one main action of a surface; `danger` is destructive. */
  variant?: ButtonVariant
  /** `md` follows the density control height; `sm` keeps the 24 px minimum target. */
  size?: ButtonSize
  /** Keeps the button focusable, marks it busy and shows a static-under-reduced-motion spinner. */
  loading?: boolean
  /** Text shown while loading; defaults to the button text. */
  loadingLabel?: string
  className?: string
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  loadingLabel,
  disabled,
  className,
  children,
  ...props
}: ButtonProps) {
  const t = useUiText()
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      focusableWhenDisabled={loading}
      className={cx('gx-button gx-focusable', className)}
      {...props}
    >
      {loading ? (
        <>
          <span className="gx-spinner" aria-hidden="true" />
          <span>{loadingLabel ?? children ?? t('ui.button.loading')}</span>
        </>
      ) : (
        children
      )}
    </ButtonPrimitive>
  )
}
