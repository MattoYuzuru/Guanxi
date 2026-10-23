/*
 * Guanxi pattern (D-202): a status fact as an icon with an optional emphasised value, a tooltip
 * on hover and a short popover anchored to it on click. Replaces labelled status prose such as
 * "Keep awake: No current data". Unknown is a designed state: a muted icon with a dashed
 * marker and "Unknown" in the popover, never 0.
 */
import { Button as ButtonPrimitive } from '@base-ui/react/button'
import type { ComponentProps, ReactNode } from 'react'
import { useUiText } from '../../i18n/context.tsx'
import { cx } from '../../lib/cx.ts'
import { Icon, type IconName } from '../icon/icon.tsx'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '../popover/popover.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip/tooltip.tsx'
import '../button/button.css'
import '../icon-button/icon-button.css'
import './status-item.css'

export type StatusItemTone = 'neutral' | 'unknown' | 'accent' | 'success' | 'warning' | 'danger'

export interface StatusItemProps extends Omit<ComponentProps<'div'>, 'className' | 'title'> {
  icon: IconName
  /** Accessible name and tooltip ("Memory", "Keep awake"). */
  label: string
  /** A short value shown next to the icon ("16.8 GB"); the value carries the weight. */
  value?: ReactNode
  tone?: StatusItemTone
  /** A count (inbox) or `true` for a quiet dot. */
  badge?: number | boolean
  /** Popover heading; defaults to the label. */
  title?: string
  /** Popover body: facts, provenance and, when needed, one next step. */
  children?: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Where the popover opens; the status strip uses `bottom` and `end` at its right edge. */
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  className?: string
}

export function StatusItem({
  icon,
  label,
  value,
  tone = 'neutral',
  badge,
  title,
  children,
  open,
  onOpenChange,
  side = 'bottom',
  align = 'center',
  className,
  ...props
}: StatusItemProps) {
  const t = useUiText()
  const badgeText = typeof badge === 'number' ? (badge > 99 ? '99+' : String(badge)) : ''
  const showBadge = badge === true || (typeof badge === 'number' && badge > 0)
  const name = value !== undefined && typeof value === 'string' ? `${label}: ${value}` : tone === 'unknown' ? `${label}: ${t('ui.status.unknownValue')}` : label
  return (
    <div data-slot="status-item" data-tone={tone} className={cx('gx-status-item', className)} {...props}>
      <Popover open={open} onOpenChange={onOpenChange}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <ButtonPrimitive
                    data-variant="ghost"
                    data-size="md"
                    aria-label={name}
                    className={cx('gx-button gx-status-item-trigger gx-focusable', value === undefined && 'gx-icon-button')}
                  />
                }
              />
            }
          >
            <span className="gx-status-item-glyph" aria-hidden="true">
              <Icon name={icon} size={16} />
              {tone === 'unknown' ? <span className="gx-status-item-unknown" /> : null}
            </span>
            {value !== undefined ? <span className="gx-status-item-value">{value}</span> : null}
            {showBadge ? (
              <span className="gx-icon-button-badge" data-tone={tone === 'danger' || tone === 'warning' ? tone : undefined} aria-hidden="true">
                {badgeText}
              </span>
            ) : null}
          </TooltipTrigger>
          <TooltipContent side={side}>{label}</TooltipContent>
        </Tooltip>
        <PopoverContent side={side} align={align} className="gx-status-item-popover">
          <PopoverTitle>{title ?? label}</PopoverTitle>
          {tone === 'unknown' && children === undefined ? (
            <p className="gx-status-item-empty">{t('ui.status.unknownValue')}</p>
          ) : (
            children
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
