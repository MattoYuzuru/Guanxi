import { openDb } from '../../src/store/db.ts'
import { SessionLog } from '../../src/session-log/log.ts'
import { SecretScrubber } from '../../src/egress/scrubber.ts'
import { RunStore } from '../../src/runs/store.ts'
import { runStateSnapshot, CRASH_COMPLETE_COST } from './durable-run-state.ts'
import { RUN_TIME, RUN_DEADLINE } from './durable-runs.ts'

const [path, stage, crashIndex] = process.argv.slice(2) as [string, string, string]
const points: string[] = []
let armed = false
const windows: { from: number; to: number; before: unknown; after: unknown }[] = []
let from = 0
let before: unknown
const fault = (label: string) => {
  if (!armed) return
  if (label.endsWith(':before_begin')) { from = points.length; before = runStateSnapshot(db) }
  points.push(label)
  if (points.length - 1 === Number(crashIndex)) process.kill(process.pid, 'SIGKILL')
  if (label.endsWith(':committed')) windows.push({ from, to: points.length - 1, before, after: runStateSnapshot(db) })
}
let now = RUN_TIME
const db = openDb(path)
const scrubber = new SecretScrubber()
const log = new SessionLog({ db, scrubber, clock: () => new Date(now),
  fault: (point) => fault(`log:${point}`) })
const store = new RunStore({ db, log, scrubber, alwaysOn: true, clock: () => now,
  fault: (operation, point) => fault(`${operation}:${point}`) })
if (stage === 'recovery') {
  try { store.heartbeat() } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'writer_busy')) throw error
  }
  now += 100_000
}
store.heartbeat()
if (stage === 'recovery') {
  armed = true
  store.reconcile()
  store.tick()
  const delivery = store.deliver('lead', 1)
  if (delivery) store.modelStarted(delivery)
} else {
const lead = store.create({ id: 'lead' })
const a = store.start(lead.id); store.modelStarted(a)
if (stage === 'hibernate') {
  armed = true
  store.delegate(a, { key: 'child', deadline: RUN_DEADLINE })
} else {
  const promise = store.delegate(a, { key: 'child', deadline: ['deadline', 'report'].includes(stage) ? RUN_TIME : RUN_DEADLINE })
  if (stage === 'deadline') {
    armed = true
    store.tick()
    const delivery = store.deliver('lead', 1)!
    store.modelStarted(delivery)
  } else {
    if (stage === 'child-start') armed = true
    let child = store.start(promise.child_id)
    if (stage === 'child-model') { armed = true; store.modelStarted(child) }
    if (stage === 'report') {
      store.tick()
      armed = true
      store.complete(child, 'completed')
      const delivery = store.deliver('lead', 1)!
      store.modelStarted(delivery)
    } else if (stage === 'cancel') {
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
      store.complete(child, 'completed', undefined, stage === 'resolve' ? CRASH_COMPLETE_COST : undefined)
      if (stage === 'wake') armed = true
      const delivery = store.deliver('lead', 1)!
      if (stage === 'ack') armed = true
      store.modelStarted(delivery)
    }
  }
}
}
armed = false
store.close(); log.close(); db.close()
process.stdout.write(JSON.stringify({ points, windows }))
