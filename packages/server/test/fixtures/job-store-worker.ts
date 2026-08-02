import { parentPort, workerData } from 'node:worker_threads'
import type { AppendJobEventInput, CreateJobInput } from '../../src/store/jobs.ts'
import { openDb } from '../../src/store/db.ts'
import { JobStore, type TerminalizeJobInput } from '../../src/store/jobs.ts'

type WorkerTask =
  | { operation: 'create'; input: CreateJobInput }
  | { operation: 'append'; input: AppendJobEventInput }
  | { operation: 'terminalize'; input: TerminalizeJobInput }

interface WorkerFixtureData {
  dbPath: string
  gate: SharedArrayBuffer
  participants: number
  task: WorkerTask
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
  const jobs = new JobStore(db)
  let result
  if (fixture.task.operation === 'create') result = jobs.create(fixture.task.input)
  else if (fixture.task.operation === 'append') result = jobs.appendEvent(fixture.task.input)
  else result = jobs.terminalize(fixture.task.input)
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
