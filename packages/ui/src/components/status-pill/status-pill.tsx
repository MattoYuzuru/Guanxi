/*
 * Guanxi pattern. Run and session status with a label and a shape, never colour alone
 * (FOUNDATIONS §1.2: run-status dots use fill, ring and dash).
 */
import type { ComponentProps } from 'react'
import type { UiMessageKey } from '../../i18n/messages.ts'
import { useUiText } from '../../i18n/context.tsx'
import { cx } from '../../lib/cx.ts'
import './status-pill.css'

export type RunStatus = 'running' | 'waiting' | 'hibernating' | 'finished' | 'error' | 'unknown'

export interface StatusPillProps extends Omit<ComponentProps<'span'>, 'className' | 'children'> {
  status: RunStatus
  /** Overrides the default label, for example "Waiting for review". */
  label?: string
  className?: string
}

const LABELS: Record<RunStatus, UiMessageKey> = {
  running: 'ui.status.running',
  waiting: 'ui.status.waiting',
  hibernating: 'ui.status.hibernating',
  finished: 'ui.status.finished',
  error: 'ui.status.error',
  unknown: 'ui.status.unknown',
}

export function StatusPill({ status, label, className, ...props }: StatusPillProps) {
  const t = useUiText()
  return (
    <span
      data-slot="status-pill"
      data-status={status}
      className={cx('gx-status-pill', className)}
      {...props}
    >
      <span className="gx-status-dot" aria-hidden="true" />
      <span>{label ?? t(LABELS[status])}</span>
    </span>
  )
}
