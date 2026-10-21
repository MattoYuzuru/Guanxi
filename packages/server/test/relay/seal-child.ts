import { fixture } from './fixture.ts'
import { hash, strip, byteHash } from '../../src/relay/handoff.ts'
const path = process.argv[2]!, point = process.argv[3]!
let armed=false
const kill=(p:string)=>{if(armed && p===point)process.kill(process.pid,'SIGKILL')}
const f = fixture({ path, fault:kill,runFault:(_op,p)=>kill('run:'+p),logFault:p=>kill('k2:'+p) })
f.relay.begin(f.attempt); f.relay.transition(f.attempt, 'work'); f.relay.transition(f.attempt, 'handoff_write'); f.relay.transition(f.attempt, 'handoff_validate')
armed=true
const l = f.relay.read(f.run.id); l.state = 'sealed'
f.relay.seal(f.attempt, { format: 'guanxi.handoff/v1', runId: f.run.id, cycle: l.cycle, attemptId: f.attempt.id, epoch: f.attempt.epoch, token: f.attempt.token,
  ledgerHash: hash(l), ledger: { ref: `run:${f.run.id}/cycles/${l.cycle}/ledger`, strip: strip(l), head: l.head, revision: l.plan.revision }, notes: [], narrative: '', degraded: false,
  bundleHash: byteHash(Buffer.from('fixture-git-bundle')) }, Buffer.from('fixture-git-bundle'), 2400)
throw new Error('crash point not reached')
