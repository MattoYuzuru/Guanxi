/*
 * Guanxi pattern (LAYOUT_AND_SCREENS §1): what failed, the source, the time and the next
 * action, with copyable details.
 */
import { CircleAlert } from 'lucide-react'
import { useState, type ComponentProps, type ReactNode } from 'react'
import { intlLocale, useUiLocale, useUiText } from '../../i18n/context.tsx'
import { cx } from '../../lib/cx.ts'
import { Button } from '../button/button.tsx'
import './error-state.css'

export interface ErrorStateProps extends Omit<ComponentProps<'div'>, 'className' | 'title'> {
  /** What failed, in one line. */
  title: string
  /** Machine name of the failing source (mono face). */
  source: string
  /** ISO time of the failure. */
  occurredAt: string
  /** Whether this is the failure time or the time the client observed it. */
  timeMeaning?: 'occurred' | 'observed'
  /** The next step the user must take (Open settings). Never Retry: transient failures recover by themselves (D-203). */
  action?: ReactNode
  /** Copyable technical details; shown in a disclosure. */
  details?: string
  /** Opens the details disclosure initially. */
  detailsOpen?: boolean
  className?: string
}

export function ErrorState({
  title,
  source,
  occurredAt,
  timeMeaning = 'occurred',
  action,
  details,
  detailsOpen = false,
  className,
  ...props
}: ErrorStateProps) {
  const t = useUiText()
  const locale = intlLocale(useUiLocale())
  const [copyResult, setCopyResult] = useState<{ details: string | undefined; status: 'copied' | 'failed' } | null>(null)
  const copy = copyResult?.details === details ? copyResult?.status : undefined
  const time = new Date(occurredAt)
  const timeLabel = Number.isNaN(time.getTime())
    ? occurredAt
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(time)

  const copyDetails = async () => {
    try {
      await navigator.clipboard.writeText(details ?? '')
      setCopyResult({ details, status: 'copied' })
    } catch {
      setCopyResult({ details, status: 'failed' })
    }
  }

  return (
    <div data-slot="error-state" role="alert" className={cx('gx-error-state', className)} {...props}>
      <div className="gx-error-state-head">
        <CircleAlert className="gx-error-state-icon" aria-hidden="true" />
        <p className="gx-error-state-title">{title}</p>
      </div>
      <p className="gx-error-state-meta">
        <span>{t('ui.error.source', { source: '' })}</span>
        <span className="gx-error-state-source">{source}</span>{' '}
        {timeMeaning === 'observed' ? <span>{t('ui.error.observed')}</span> : null}
        <time dateTime={Number.isNaN(time.getTime()) ? undefined : time.toISOString()}>{timeLabel}</time>
      </p>
      {details ? (
        <details className="gx-error-state-details" open={detailsOpen}>
          <summary className="gx-error-state-summary gx-focusable">{t('ui.error.details')}</summary>
          <pre className="gx-error-state-pre">{details}</pre>
          <Button size="sm" variant="ghost" onClick={copyDetails}>
            {t('ui.error.copy')}
          </Button>
          <span className="gx-error-state-copy" role="status">
            {copy === 'copied' ? t('ui.error.copied') : copy === 'failed' ? t('ui.error.copyFailed') : ''}
          </span>
        </details>
      ) : null}
      {action ? <div className="gx-error-state-action">{action}</div> : null}
    </div>
  )
}
