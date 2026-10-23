/*
 * Guanxi pattern over the shadcn/ui (base) Button and Tooltip adaptations in this package.
 * Every icon-only control has an accessible name and a tooltip (FOUNDATIONS §6).
 */
import { Button as ButtonPrimitive } from '@base-ui/react/button'
import type { ComponentProps, ReactNode } from 'react'
import { cx } from '../../lib/cx.ts'
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip/tooltip.tsx'
import '../button/button.css'
import './icon-button.css'

export interface IconButtonProps
  extends Omit<ComponentProps<typeof ButtonPrimitive>, 'className' | 'children' | 'aria-label'> {
  /** Accessible name and tooltip text. Required: an icon alone has no name. */
  label: string
  /** A Lucide icon element; it is hidden from assistive technology. */
  icon: ReactNode
  variant?: 'ghost' | 'secondary'
  size?: 'sm' | 'md'
  /** Renders a toggle with `aria-pressed`. */
  pressed?: boolean
  /** Controls the tooltip; the catalog uses it to show the open state. */
  tooltipOpen?: boolean
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right'
  /** A count (capped at 99+) or `true` for a quiet dot; hidden from assistive technology, so put the fact in `label`. */
  badge?: number | boolean
  badgeTone?: 'accent' | 'warning' | 'danger'
  className?: string
}

export function IconButton({
  label,
  icon,
  variant = 'ghost',
  size = 'md',
  pressed,
  tooltipOpen,
  tooltipSide = 'top',
  badge,
  badgeTone = 'accent',
  className,
  ...props
}: IconButtonProps) {
  const showBadge = badge === true || (typeof badge === 'number' && badge > 0)
  return (
    <Tooltip open={tooltipOpen}>
      <TooltipTrigger
        render={
          <ButtonPrimitive
            data-slot="icon-button"
            data-variant={variant}
            data-size={size}
            aria-label={label}
            aria-pressed={pressed}
            className={cx('gx-button gx-icon-button gx-focusable', className)}
            {...props}
          />
        }
      >
        <span className="gx-icon-button-glyph" aria-hidden="true">
          {icon}
        </span>
        {showBadge ? (
          <span className="gx-icon-button-badge" data-tone={badgeTone === 'accent' ? undefined : badgeTone} aria-hidden="true">
            {typeof badge === 'number' ? (badge > 99 ? '99+' : String(badge)) : ''}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{label}</TooltipContent>
    </Tooltip>
  )
}
