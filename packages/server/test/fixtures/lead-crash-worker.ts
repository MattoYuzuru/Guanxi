import { dirname } from 'node:path'
import { leadWorld, OWNER, START } from './lead-world.ts'

const [path, stage, crashIndex] = process.argv.slice(2) as [string, string, string]
const points: string[] = []
let armed = false
const fault = (label: string) => {
  if (!armed) return
  points.push(label)
  if (points.length - 1 === Number(crashIndex)) process.kill(process.pid, 'SIGKILL')
}
let now = START
const world = leadWorld({ path, dir: dirname(path), clock: () => now,
  // Transaction boundaries only: R1's own statement-level crash property is covered by durable-run-crash.
  r1Fault: (operation, point) => { if (['before_begin', 'before_commit', 'committed'].includes(point)) fault(`${operation}:${point}`) },
  fault })
if (stage === 'delegate') armed = true
const { runId, first } = world.lead.startLead({ ownerAccountId: OWNER, actorAccountId: OWNER, projectId: 'p', prompt: 'Fix the failing tests' })
await first
await world.lead.idle()
if (stage === 'wake' || stage === 'cancel' || stage === 'signal') {
  const childId = world.runs.promises(runId)[0]!.child_id
  if (stage === 'wake') {
    // The executor keeps its attempt alive through the simulated hour, as the relay executor renews its.
    const attempt = world.children.attempts.get(childId)!
    for (let elapsed = 0; elapsed < 3_600_000; elapsed += 50_000) { now += 50_000; world.runs.renew(attempt, 60_000) }
    armed = true
    world.runs.complete(attempt, 'completed')
    world.lead.pump()
    await world.lead.idle()
  } else if (stage === 'signal') {
    // An escalation wakes the lead without resolving the promise; the lead yields again.
    armed = true
    world.runs.signal(world.children.attempts.get(childId)!, 'judge-flag')
    world.lead.pump()
    await world.lead.idle()
  } else {
    armed = true
    await world.lead.cancel(runId)
  }
}
armed = false
process.stdout.write(JSON.stringify({ points, runId }))
await world.close()
