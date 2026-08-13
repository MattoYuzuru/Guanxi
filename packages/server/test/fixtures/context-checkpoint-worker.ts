import { parentPort, workerData } from 'node:worker_threads'
import { openDb } from '../../src/store/db.ts'
import { ThreadStore } from '../../src/store/threads.ts'

interface WorkerFixtureData {
  dbPath: string
  gate: SharedArrayBuffer
  participants: number
  input: Parameters<ThreadStore['createContextCheckpoint']>[0]
}

const fixture = workerData as WorkerFixtureData
const db = openDb(fixture.dbPath)
const gate = new Int32Array(fixture.gate)
const arrived = Atomics.add(gate, 0, 1) + 1
if (arrived === fixture.participants) Atomics.notify(gate, 0, fixture.participants)
while (Atomics.load(gate, 0) < fixture.participants) {
  Atomics.wait(gate, 0, arrived, 5_000)
}

try {
  const result = new ThreadStore(db).createContextCheckpoint(fixture.input)
  db.close()
  parentPort?.postMessage({ ok: true, result })
} catch (error) {
  db.close()
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    code:
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : null,
  })
}
