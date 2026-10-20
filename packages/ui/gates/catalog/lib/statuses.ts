import {
  componentSnapshotHashes,
  componentSourceHash,
  effectiveStatus,
  loadTrustedKeys,
  parseReviewRecord,
  uiPaths,
  verifyRecordApproval,
  type EffectiveReviewStatus,
} from '../../../catalog/approval/index.ts'
import type { UiInventory } from '../../../catalog/tooling/inventory.ts'

/** Effective status per component id, computed from the records, keys and current hashes. */
export function componentStatuses(inventory: UiInventory): Map<string, EffectiveReviewStatus> {
  const paths = uiPaths(inventory.uiRoot)
  const keys = loadTrustedKeys(paths.trustedKeys)
  const trusted = keys.ok ? keys.file.keys : []
  const statuses = new Map<string, EffectiveReviewStatus>()
  for (const folder of inventory.folders) {
    const parsed = folder.reviewJson === null ? null : parseReviewRecord(folder.reviewJson, folder.id)
    if (!parsed?.ok) {
      statuses.set(folder.id, 'invalid')
      continue
    }
    const verdict = verifyRecordApproval(parsed.record, trusted)
    const signature = verdict.state === 'invalid' ? 'invalid' : verdict.state === 'valid' ? 'valid' : 'absent'
    let sourceHash: string
    try {
      sourceHash = componentSourceHash(folder.dir)
    } catch {
      statuses.set(folder.id, 'invalid')
      continue
    }
    statuses.set(
      folder.id,
      effectiveStatus(parsed.record, signature, {
        sourceHash,
        snapshotHashes: componentSnapshotHashes(paths.snapshots, folder.id),
      }),
    )
  }
  return statuses
}
