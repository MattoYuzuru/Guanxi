/** Unknown identity is never evidence that a process exited. Dependencies make failure paths testable. */
export function inspectService(pid, { probe, command, uid, executable, entry, dataDir }) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return 'unknown'
  try { probe(pid) } catch (error) { return error?.code === 'ESRCH' ? 'gone' : 'unknown' }
  try {
    const identity = command(pid).trim().match(/^(\d+)\s+(.+)$/)
    if (!identity) return 'unknown'
    return Number(identity[1]) === uid && identity[2].startsWith(`${executable} ${entry} `) &&
      `${identity[2]} `.includes(` --data-dir ${dataDir} `) ? 'owned' : 'other'
  } catch { return 'unknown' }
}
