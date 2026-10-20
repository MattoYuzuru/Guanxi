import { useEffect, useId, useState } from 'react'
import { Button, Textarea } from '../src/index.ts'
import { intlLocale, useUiLocale, useUiText } from '../src/i18n/context.tsx'
import type { UiMessageKey } from '../src/i18n/messages.ts'
import type { CatalogEntry } from './entries.ts'
import {
  ReviewApiError,
  type ReviewApi,
  type ReviewCapability,
  type ReviewFailure,
  type ReviewState,
} from './review-api.ts'
import { StatusBadge, entryStatus } from './status-badge.tsx'

type Outcome = 'approved' | 'requested' | 'commentRequired' | ReviewFailure

const OUTCOME_KEYS: Record<Outcome, UiMessageKey> = {
  approved: 'catalog.review.approved',
  requested: 'catalog.review.requested',
  commentRequired: 'catalog.review.commentRequired',
  conflict: 'catalog.review.conflict',
  signer_unavailable: 'catalog.review.signerUnavailable',
  read_only: 'catalog.review.readOnly',
  failed: 'catalog.review.failed',
}

/**
 * Approve / Request changes for one component. The node decides whether writes are possible;
 * without a node (or in a release build) the panel shows the bundled record read-only.
 */
export function ReviewPanel({ entry, api }: { entry: CatalogEntry; api: ReviewApi | null }) {
  const t = useUiText()
  const locale = intlLocale(useUiLocale())
  const commentId = useId()
  const hintId = useId()
  const [capability, setCapability] = useState<ReviewCapability | 'loading' | 'unavailable'>(
    api ? 'loading' : 'unavailable',
  )
  const [live, setLive] = useState<ReviewState | null>(null)
  const [comment, setComment] = useState('')
  const [pending, setPending] = useState<'approve' | 'request_changes' | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  useEffect(() => {
    if (!api) return
    const controller = new AbortController()
    api.capability(controller.signal).then(setCapability, () => {
      if (!controller.signal.aborted) setCapability('unavailable')
    })
    api.get(entry.id, controller.signal).then(setLive, () => undefined)
    return () => controller.abort()
  }, [api, entry.id])

  const record = live?.record ?? entry.review
  const status = live?.status ?? entryStatus(entry)
  const writable = typeof capability === 'object' && capability.writable && live !== null

  const submit = async (decision: 'approve' | 'request_changes') => {
    if (!api || !live || pending) return
    if (decision === 'request_changes' && comment.trim() === '') {
      setOutcome('commentRequired')
      return
    }
    setPending(decision)
    setOutcome(null)
    try {
      const next = await api.submit(entry.id, {
        decision,
        comment: comment.trim(),
        expectedSourceHash: live.current.sourceHash,
        expectedSnapshotHashes: live.current.snapshotHashes,
      })
      setLive(next)
      setComment('')
      setOutcome(decision === 'approve' ? 'approved' : 'requested')
    } catch (error) {
      setOutcome(error instanceof ReviewApiError ? error.kind : 'failed')
    } finally {
      setPending(null)
    }
  }

  const readOnlyReason =
    capability === 'unavailable'
      ? t('catalog.review.reason.unavailable')
      : capability !== 'loading' && !capability.writable && capability.reason
        ? t(`catalog.review.reason.${capability.reason}` as UiMessageKey)
        : null

  return (
    <section className="gx-catalog-review" aria-labelledby={`${commentId}-title`}>
      <h3 id={`${commentId}-title`}>{t('catalog.review.title')}</h3>
      <p className="gx-catalog-review-status">
        {t('catalog.review.current', { status: '' })}
        <StatusBadge status={status} />
      </p>
      {record?.approval ? (
        <p className="gx-catalog-muted">
          {t('catalog.review.approvedBy', {
            keyId: record.approval.keyId,
            date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
              new Date(record.approval.at),
            ),
          })}
        </p>
      ) : null}

      <h4>{t('catalog.review.requests')}</h4>
      {record && record.requests.length > 0 ? (
        <ul className="gx-catalog-requests">
          {record.requests.map((request) => (
            <li key={request.id}>
              <span>{request.text}</span>{' '}
              <span className="gx-catalog-muted">
                ({request.state === 'open' ? t('catalog.review.requestOpen') : t('catalog.review.requestResolved')})
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="gx-catalog-muted">{t('catalog.review.noRequests')}</p>
      )}

      {readOnlyReason ? (
        <div className="gx-catalog-readonly" data-review-readonly="">
          <p>{t('catalog.review.readOnly')}</p>
          <p className="gx-catalog-muted">{readOnlyReason}</p>
        </div>
      ) : null}

      {writable ? (
        <form
          className="gx-catalog-review-form"
          onSubmit={(event) => {
            event.preventDefault()
            void submit('approve')
          }}
        >
          <label htmlFor={commentId} className="gx-catalog-control-label">
            {t('catalog.review.comment')}
          </label>
          <Textarea
            id={commentId}
            aria-describedby={hintId}
            value={comment}
            invalid={outcome === 'commentRequired'}
            onChange={(event) => setComment(event.target.value)}
          />
          <p id={hintId} className="gx-catalog-muted">
            {t('catalog.review.commentHint')}
          </p>
          <p className="gx-catalog-muted">{t('catalog.review.keychainPrompt')}</p>
          <div className="gx-catalog-review-actions">
            <Button
              type="submit"
              variant="primary"
              loading={pending === 'approve'}
              loadingLabel={t('catalog.review.submitting')}
              disabled={pending !== null && pending !== 'approve'}
            >
              {t('catalog.review.approve')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              loading={pending === 'request_changes'}
              loadingLabel={t('catalog.review.submitting')}
              disabled={pending !== null && pending !== 'request_changes'}
              onClick={() => void submit('request_changes')}
            >
              {t('catalog.review.requestChanges')}
            </Button>
          </div>
        </form>
      ) : null}

      <p role="status" className="gx-catalog-review-outcome" data-review-outcome={outcome ?? ''}>
        {outcome ? t(OUTCOME_KEYS[outcome]) : ''}
      </p>
    </section>
  )
}
