import { openDb } from '../../src/store/db.ts'
import { SessionLog, type SessionLogOptions } from '../../src/session-log/log.ts'
import { SecretScrubber } from '../../src/egress/scrubber.ts'
import { RunStore, type RunStoreOptions } from '../../src/runs/store.ts'

export const RUN_TIME = 1_800_000_000_000
export const RUN_DEADLINE = RUN_TIME + 3_600_000
export function runFixture(path = ':memory:', options: Partial<RunStoreOptions> & { logFault?: SessionLogOptions['fault'] } = {}) {
  let now = RUN_TIME
  const db = openDb(path)
  const scrubber = new SecretScrubber()
  const log = new SessionLog({ db, scrubber, clock: () => new Date(now),
    fault: options.logFault, isProcessAlive: () => false })
  const store = new RunStore({ db, log, scrubber, alwaysOn: true, clock: () => now, ...options })
  store.heartbeat()
  return { db, log, store, scrubber, setTime: (time: number) => { now = time },
    close: () => { store.close(); log.close(); db.close(); scrubber.close() } }
}
