import type { EffectiveReviewStatus, ReviewRecord } from './record.ts'

export interface CurrentHashes {
  sourceHash: string
  snapshotHashes: Record<string, string>
}

export type SignatureState = 'absent' | 'valid' | 'invalid'

function sameMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a).sort()
  const other = Object.keys(b).sort()
  return keys.length === other.length && keys.every((key, index) => key === other[index] && a[key] === b[key])
}

/**
 * The status the catalog shows and G11 enforces. `approved` needs a valid signature and the
 * current hashes; a valid approval of older hashes is `stale`; a broken one is `invalid`.
 */
export function effectiveStatus(
  record: ReviewRecord,
  signature: SignatureState,
  current: CurrentHashes,
): EffectiveReviewStatus {
  if (record.status !== 'approved') return signature === 'invalid' ? 'invalid' : record.status
  if (signature !== 'valid' || !record.approval) return 'invalid'
  const fresh =
    record.approval.sourceHash === current.sourceHash &&
    sameMap(record.approval.snapshotHashes, current.snapshotHashes)
  return fresh ? 'approved' : 'stale'
}
