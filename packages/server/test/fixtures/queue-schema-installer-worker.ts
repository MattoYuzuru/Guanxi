import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { SecretScrubber } from '../../src/egress/scrubber.ts'
import { SessionLog } from '../../src/session-log/log.ts'
import { installSessionQueueSchema } from '../../src/session-log/queue-schema.ts'

interface InstallerWorkerData {
  role: 'holder' | 'competitor'
  dbPath: string
  gate: SharedArrayBuffer
}

interface WorkerFailure {
  code: string | null
  errcode: number | null
  busy: boolean
  message: string
}

const { role, dbPath, gate } = workerData as InstallerWorkerData
const state = new Int32Array(gate)
const db = new DatabaseSync(dbPath)
db.exec('PRAGMA foreign_keys = ON')

function post(message: Record<string, unknown>): void {
  parentPort?.postMessage(message)
}

function waitFor(index: number): void {
  const deadline = Date.now() + 30_000
  while (Atomics.load(state, index) === 0) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`timed out waiting for installer gate ${index}`)
    Atomics.wait(state, index, 0, remaining)
  }
}

function failureOf(error: unknown): WorkerFailure {
  const value = error as { code?: unknown; errcode?: unknown; message?: unknown }
  const code = typeof value?.code === 'string' ? value.code : null
  const errcode = typeof value?.errcode === 'number' ? value.errcode : null
  const message = error instanceof Error ? error.message : String(error)
  return {
    code,
    errcode,
    // SQLITE_BUSY (5) and SQLITE_BUSY_SNAPSHOT (517) are the serialization signal.
    busy: errcode === 5 || errcode === 517 || /database is locked|SQLITE_BUSY/iu.test(message),
    message,
  }
}

try {
  if (role === 'holder') {
    db.exec('PRAGMA busy_timeout = 5000')
    installSessionQueueSchema(db, {
      fault: (point) => {
        if (point !== 'after_trigger') return
        post({ state: 'holding' })
        waitFor(1)
      },
    })
    Atomics.store(state, 2, 1)
    Atomics.notify(state, 2)
    post({ state: 'committed' })
  } else {
    db.exec('PRAGMA busy_timeout = 0')
    try {
      const log = new SessionLog({ db, scrubber: new SecretScrubber() })
      log.close()
      post({ state: 'unexpected-success' })
    } catch (error) {
      const failure = failureOf(error)
      post({ state: 'blocked', ...failure })
      if (!failure.busy) throw error
      Atomics.store(state, 1, 1)
      Atomics.notify(state, 1)
      waitFor(2)
      db.exec('PRAGMA busy_timeout = 5000')
      const log = new SessionLog({ db, scrubber: new SecretScrubber() })
      log.close()
      post({ state: 'constructed' })
    }
  }
  db.close()
} catch (error) {
  post({ state: 'error', ...failureOf(error) })
  db.close()
  process.exitCode = 1
}
