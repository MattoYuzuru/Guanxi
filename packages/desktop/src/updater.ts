/**
 * Auto-update is a design note, not a feature, in this slice (docs/plans/lanes/U2-macos.plan.md,
 * Decision 6). This stub has no network code and exposes no menu item; it exists so the call sites and the
 * state vocabulary are fixed before electron-updater (MIT) is added.
 */
export type UpdateStatus = { state: 'disabled'; reason: 'not_implemented' }

export function updateStatus(): UpdateStatus {
  return { state: 'disabled', reason: 'not_implemented' }
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  return updateStatus()
}
