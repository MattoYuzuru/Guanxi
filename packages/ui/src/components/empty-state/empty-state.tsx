/*
 * Guanxi pattern (LAYOUT_AND_SCREENS §1): one sentence and one primary action; never a blank
 * panel.
 */
import type { ComponentProps, ReactNode } from 'react'
import { cx } from '../../lib/cx.ts'
import './empty-state.css'

export interface EmptyStateProps extends Omit<ComponentProps<'div'>, 'className' | 'title'> {
  /** One sentence that says what is missing. */
  title: string
  /** The one primary action, usually a Button. */
  action?: ReactNode
  /** Optional Lucide icon; decorative. */
  icon?: ReactNode
  className?: string
}

export function EmptyState({ title, action, icon, className, ...props }: EmptyStateProps) {
  return (
    <div data-slot="empty-state" className={cx('gx-empty-state', className)} {...props}>
      {icon ? (
        <span className="gx-empty-state-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <p className="gx-empty-state-title">{title}</p>
      {action ? <div>{action}</div> : null}
    </div>
  )
}
