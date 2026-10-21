import { Badge, type BadgeTone } from '../src/index.ts'
import { useUiText } from '../src/i18n/context.tsx'
import type { UiMessageKey } from '../src/i18n/messages.ts'
import type { EffectiveReviewStatus } from './approval/record.ts'
import type { CatalogEntry } from './entries.ts'

const STATUS_TONE: Record<EffectiveReviewStatus, BadgeTone> = {
  draft: 'neutral',
  review: 'info',
  approved: 'success',
  stale: 'warning',
  deprecated: 'danger',
  invalid: 'danger',
}

export function entryStatus(entry: CatalogEntry): EffectiveReviewStatus {
  return entry.manifest?.status ?? entry.review?.status ?? 'draft'
}

export function StatusBadge({ status }: { status: EffectiveReviewStatus }) {
  const t = useUiText()
  return (
    <Badge tone={STATUS_TONE[status]} data-status={status}>
      {t(`catalog.status.${status}` as UiMessageKey)}
    </Badge>
  )
}
