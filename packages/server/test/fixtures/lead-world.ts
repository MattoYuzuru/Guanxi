import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../../src/store/db.ts'
import { SessionLog } from '../../src/session-log/log.ts'
import { SecretScrubber } from '../../src/egress/scrubber.ts'
import { RunStore } from '../../src/runs/store.ts'
import { LeadService } from '../../src/leads/service.ts'
import { LeadToolServer } from '../../src/leads/tool-server.ts'
import type { RolePrompt } from '../../src/external-agents/service.ts'
import type { Attempt } from '../../src/runs/types.ts'
import type { ChildHandle, ChildLaunch, ChildStarter } from '../../src/leads/types.ts'
import { brief } from '../leads/brief.ts'
import { START } from '../leads/brief.ts'

export { START }
export const OWNER = 'crash-owner'
/** Append-only evidence shared by the killed worker and the recovering process. */
export const readLog = (dir: string, name: string): Record<string, any>[] => {
  const path = join(dir, name)
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}

/** A scripted ACP lead: calls the real loopback MCP endpoint over HTTP, honours the hibernate
 * signal like K5's cooperative cancel, and records each turn it starts and completes. */
class ScriptedAgents {
  private readonly dir: string
  private readonly onTurn: () => void
  private readonly silent: boolean
  constructor(dir: string, onTurn: () => void, silent: boolean) { this.dir = dir; this.onTurn = onTurn; this.silent = silent }
  private log(event: string, extra: Record<string, unknown> = {}) {
    appendFileSync(join(this.dir, 'turns.jsonl'), JSON.stringify({ pid: process.pid, event, ...extra }) + '\n')
  }
  resolve() { return { binding: { connectionId: 'crash-connection', backend: 'claude-code' as const, model: 'm', params: {} }, source: 'project' as const } }
  async run(input: RolePrompt) {
    const lead = input.lead!
    const wake = input.prompt.includes('guanxi.wake/v1')
    const delegate = !wake && !input.prompt.startsWith('continue')
    const wakeSeq = wake ? Number(/wake=(\d+)/.exec(input.prompt)![1]) : null
    lead.onSession({ acpSessionId: 'crash-session', mode: lead.resume ? 'load' : 'new', loadSession: true })
    const kind = wake ? 'wake' : delegate ? 'delegate' : 'continue'
    this.log('prompt', { kind, wakeSeq })
    this.onTurn()
    // A silent delegating lead calls the tool before emitting any update: the call itself is the acknowledgement.
    if (!(this.silent && delegate)) lead.onActivity()
    // Cumulative for the one ACP session, counting every turn that ever started, even a killed one.
    const n = readLog(this.dir, 'turns.jsonl').filter(e => e.event === 'prompt').length
    const usage = { inputTokens: n * 1000, outputTokens: n * 200, cost: { amount: n * 0.5, currency: 'USD' } }
    lead.onUsage(usage)
    if (!delegate) {
      this.log('turn_end', { kind, wakeSeq })
      return { sessionId: 's', text: 'resumed', stopReason: 'end_turn', usage }
    }
    const server = lead.mcpServers[0]!
    const call = (body: unknown) => fetch(server.url, { method: 'POST', body: JSON.stringify(body), signal: input.signal,
      headers: { 'content-type': 'application/json', ...Object.fromEntries(server.headers.map(h => [h.name, h.value])) } })
    const answered = call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'guanxi_delegate', arguments: brief() } })
      .then(response => response.json(), () => null)
    const outcome = await Promise.race([answered.then(() => 'answered'),
      new Promise<string>(resolve => { if (lead.hibernateSignal.aborted) resolve('hibernate'); else lead.hibernateSignal.addEventListener('abort', () => resolve('hibernate'), { once: true }) })])
    this.log('turn_end', { kind, hibernated: outcome === 'hibernate' })
    return { sessionId: 's', text: 'planning delegation', stopReason: outcome === 'hibernate' ? 'hibernated' : 'end_turn', usage }
  }
}

/** The child executor: records launches durably and keeps the fenced attempt for the test to finish. */
class ScriptedChildren implements ChildStarter {
  readonly attempts = new Map<string, Attempt>()
  private readonly dir: string
  constructor(dir: string) { this.dir = dir }
  start(launch: ChildLaunch): ChildHandle {
    appendFileSync(join(this.dir, 'children.jsonl'), JSON.stringify({ pid: process.pid, event: 'launch', child: launch.childRunId, previousAttempts: launch.previousAttempts }) + '\n')
    this.attempts.set(launch.childRunId, launch.attempt)
    return { done: new Promise<void>(() => undefined) }
  }
  stop(childRunId: string) { appendFileSync(join(this.dir, 'children.jsonl'), JSON.stringify({ pid: process.pid, event: 'stop', child: childRunId }) + '\n') }
}

export interface WorldOptions {
  path: string
  dir: string
  clock: () => number
  deferClaim?: boolean
  r1Fault?: (operation: string, point: string) => void
  fault?: (point: string) => void
  silent?: boolean
}
export function leadWorld(options: WorldOptions) {
  const db = openDb(options.path)
  const scrubber = new SecretScrubber()
  const log = new SessionLog({ db, scrubber, clock: () => new Date(options.clock()), isProcessAlive: () => false })
  const runs = new RunStore({ db, log, scrubber, alwaysOn: true, clock: options.clock, maxAttemptTtlMs: 60_000,
    ...(options.r1Fault ? { fault: options.r1Fault } : {}) })
  if (!options.deferClaim) runs.heartbeat()
  const children = new ScriptedChildren(options.dir)
  const tools = new LeadToolServer()
  const turns = { started: 0 }
  const agents = new ScriptedAgents(options.dir, () => { turns.started++ }, options.silent === true)
  const lead = new LeadService({ db, runs, agents: agents as never, scrubber, child: children, tools, clock: options.clock,
    renewMs: 2_000_000_000, cancelGraceMs: 500, retryMs: () => 0, ...(options.fault ? { fault: options.fault } : {}) })
  return { db, log, runs, lead, children, scrubber, tools, turns,
    async close() { await lead.close(); await tools.close(); runs.close(); log.close(); db.close(); scrubber.close() } }
}
