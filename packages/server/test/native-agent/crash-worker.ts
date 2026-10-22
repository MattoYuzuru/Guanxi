import { writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from './fixture.ts'
const [directory, killAtRaw] = process.argv.slice(2)
const killAt = Number(killAtRaw)
const points: string[] = []
let enabled = false
const point = (name: string) => {
  if (!enabled) return
  points.push(name)
  if (points.length - 1 === killAt) process.kill(process.pid, 'SIGKILL')
}
const f = await fixture({ after() {} }, async call => {
  point('model:dispatch')
  appendFileSync(join(directory!, 'calls'), 'call\n')
  return call === 1 ? [{ type: 'thinking', thinking: 'fixture private reasoning' },
    { type: 'toolCall', id: 'note', name: 'note_add', arguments: { text: 'fixture note' } }]
    : [{ type: 'text', text: 'fixture completion' }]
}, undefined, undefined, undefined, { directory, fault: (op, p) => point(`run:${op}:${p}`), logFault: p => point(`log:${p}`) })
enabled = true
const { sessionId } = await f.agents().create(f.input)
await f.agents().wait(sessionId)
enabled = false
await f.agents().close(); f.runs.close(); f.log.close(); f.db.close()
writeFileSync(join(directory!, 'points.json'), JSON.stringify(points))

process.exit(0)
