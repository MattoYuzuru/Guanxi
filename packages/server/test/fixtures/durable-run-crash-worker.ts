import { openDb } from '../../src/store/db.ts'
import { SessionLog } from '../../src/session-log/log.ts'
import { SecretScrubber } from '../../src/egress/scrubber.ts'
import { RunStore } from '../../src/runs/store.ts'
import { RUN_TIME, RUN_DEADLINE } from './durable-runs.ts'

const [path, stage, crashIndex] = process.argv.slice(2) as [string, string, string]
const points: string[] = []
let armed = false
const fault = (label: string) => {
  if (!armed) return
  points.push(label)
  if (points.length - 1 === Number(crashIndex)) process.kill(process.pid, 'SIGKILL')
}
const db = openDb(path)
const scrubber = new SecretScrubber()
const log = new SessionLog({ db, scrubber, clock: () => new Date(RUN_TIME),
  fault: (point) => fault(`log:${point}`) })
const store = new RunStore({ db, log, scrubber, alwaysOn: true, clock: () => RUN_TIME,
  fault: (operation, point) => fault(`${operation}:${point}`) })
const lead = store.create({ id: 'lead' })
const a = store.start(lead.id); store.modelStarted(a)
if (stage === 'hibernate') {
  armed = true
  store.delegate(a, { key: 'child', deadline: RUN_DEADLINE })
} else {
  const promise = store.delegate(a, { key: 'child', deadline: RUN_DEADLINE })
  const child = store.start(promise.child_id)
  if (stage === 'resolve') armed = true
  store.complete(child, 'completed')
  if (stage === 'wake') armed = true
  const delivery = store.deliver('lead', 1)!
  if (stage === 'ack') armed = true
  store.modelStarted(delivery)
}
armed = false
store.close(); log.close(); db.close()
process.stdout.write(JSON.stringify(points))
