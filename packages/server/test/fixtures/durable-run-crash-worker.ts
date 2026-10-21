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
  const promise = store.delegate(a, { key: 'child', deadline: stage === 'deadline' ? RUN_TIME : RUN_DEADLINE })
  if (stage === 'deadline') {
    armed = true
    store.tick()
    const delivery = store.deliver('lead', 1)!
    store.modelStarted(delivery)
  } else {
    let child = store.start(promise.child_id)
    if (stage === 'cancel') {
      store.delegate(child, { key: 'grandchild', deadline: RUN_DEADLINE })
      armed = true
      store.cancel('lead')
    } else if (['signal', 'input', 'yield', 'resleep'].includes(stage)) {
      if (stage === 'signal' || stage === 'input') armed = true
      if (stage === 'input') {
        store.inputRequired(child)
        child = store.decide(promise.child_id)
      } else store.signal(child, 'crash-signal')
      if (stage !== 'resleep') store.complete(child, 'completed')
      const first = store.deliver('lead', 1)!
      store.modelStarted(first)
      if (stage === 'yield' || stage === 'resleep') armed = true
      store.hibernate(first)
      if (stage === 'resleep') store.complete(child, 'completed')
      const second = store.deliver('lead', 2)!
      store.modelStarted(second)
    } else {
      if (stage === 'resolve') armed = true
      store.complete(child, 'completed')
      if (stage === 'wake') armed = true
      const delivery = store.deliver('lead', 1)!
      if (stage === 'ack') armed = true
      store.modelStarted(delivery)
    }
  }
}
armed = false
store.close(); log.close(); db.close()
process.stdout.write(JSON.stringify(points))
