import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { fixture, owner } from '../external-agents/helpers.ts'
import type { AdapterId } from '../../src/external-agents/types.ts'
import { createLeadPlugin, LEAD_SERVICE, type LeadHostService } from '../../src/leads/plugin.ts'
import type { ChildHandle, ChildLaunch, ChildReport, ChildReporter, ChildStarter, LeadNotice } from '../../src/leads/types.ts'
import type { RunStore } from '../../src/runs/store.ts'
import type { Attempt } from '../../src/runs/types.ts'
import { DURABLE_RUNS_SERVICE, type DurableRunsService } from '../../src/runs/plugin.ts'
import { LeadToolServer } from '../../src/leads/tool-server.ts'

export { START, HOUR, brief } from './brief.ts'
import { START, HOUR, brief } from './brief.ts'

/** An executor that finishes only when the test says so. It holds the child's fenced R1 attempt. */
export class FakeChildren implements ChildStarter, ChildReporter {
  readonly launches: ChildLaunch[] = []
  readonly stops: string[] = []
  readonly reports = new Map<string, ChildReport>()
  failStart = false
  private readonly runs: () => RunStore
  private readonly pending = new Map<string, { resolve(): void; reject(error: Error): void }>()
  constructor(runs: () => RunStore) { this.runs = runs }
  start(launch: ChildLaunch): ChildHandle {
    if (this.failStart) throw Object.assign(new Error('boom'), { code: 'executor_unavailable' })
    this.launches.push(launch)
    return { done: new Promise<void>((resolve, reject) => { this.pending.set(launch.childRunId, { resolve, reject }) }) }
  }
  stop(childRunId: string): void { this.stops.push(childRunId) }
  report(childRunId: string): ChildReport | null { return this.reports.get(childRunId) ?? null }
  attempt(index = 0): Attempt { return this.launches[index]!.attempt }
  /** The executor reports a terminal result through R1, as the relay executor does. */
  complete(index = 0, outcome: 'completed' | 'failed' = 'completed'): void {
    const launch = this.launches[index]!
    this.runs().complete(launch.attempt, outcome)
    this.pending.get(launch.childRunId)?.resolve()
  }
  fail(index = 0): void { this.pending.get(this.launches[index]!.childRunId)?.reject(Object.assign(new Error('executor'), { code: 'executor_crashed' })) }
}

export async function leadFixture(t: TestContext, options: { lead?: Record<string, unknown>; fallback?: boolean; alwaysOn?: boolean; plugin?: Partial<Parameters<typeof createLeadPlugin>[0]> } = {}) {
  let now = START
  const adapters: AdapterId[] = options.fallback ? ['claude-code', 'copilot'] : ['claude-code']
  const f = await fixture(t, adapters, { runDeadlineMs: 60_000 }, { runs: { alwaysOn: options.alwaysOn ?? true, clock: () => now, maxAttemptTtlMs: 24 * HOUR, ownerTtlMs: 24 * HOUR } })
  const runs = () => f.kernel.node.service<DurableRunsService>(DURABLE_RUNS_SERVICE)!.store
  const binding = f.bindings[0]!
  const fallback = options.fallback ? f.bindings[1]! : null
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  const children = new FakeChildren(runs)
  const notices: LeadNotice[] = []
  const tools = new LeadToolServer()
  t.after(() => tools.close())
  const leadScenario = { loadSession: true, briefs: [brief()], usagePerTurn: { inputTokens: 1000, outputTokens: 200, amount: 0.5 }, ...options.lead }
  const scenario = async (extra: Record<string, unknown> = {}, adapter: AdapterId = 'claude-code') => f.scenario(adapter, { lead: { ...leadScenario, ...extra } })
  for (const adapter of adapters) await scenario({}, adapter)
  const install = () => f.kernel.node.plugin(createLeadPlugin({ db: f.db, child: children, reporter: children, notify: n => notices.push(n), tools,
    clock: () => now, tickMs: 2_000_000_000, renewMs: 2_000_000_000, cancelGraceMs: 3_000, retryMs: () => 1_000, ...options.plugin }))
  let plugin = await install()
  const lead = () => f.kernel.node.service<LeadHostService>(LEAD_SERVICE)!
  const events = async (adapter: AdapterId = 'claude-code') => {
    try {
      return (await readFile(join(f.dir, adapter, 'lead-events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, any>)
    } catch { return [] }
  }
  return { ...f, runs, lead, children, notices, tools, events, owner, binding, fallback, scenario,
    get now() { return now }, advance(ms: number) { now += ms }, setNow(value: number) { now = value },
    async restartLead() { await plugin.dispose(); plugin = await install() },
    start: (prompt = 'Fix the failing tests') => lead().startLead({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', prompt,
      ...(fallback ? { fallback } : {}) }) }
}
