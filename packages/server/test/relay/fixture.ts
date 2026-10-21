import { runFixture } from '../fixtures/durable-runs.ts'
import { RelayStore } from '../../src/relay/store.ts'
import { RelayExecutor } from '../../src/relay/executor.ts'
import { canonical, probes } from '../../src/relay/handoff.ts'
import { thresholds } from '../../src/relay/budget.ts'
import type { RelayModel, Reply } from '../../src/relay/model.ts'
import type { RelayWorkspace } from '../../src/relay/workspace.ts'
import type { Caps, Plan, Reserves, WindowObservation } from '../../src/relay/types.ts'
export const window: WindowObservation = { tokens: 16000, framingTokens: 32, source: 'fixture:loaded-window', observedAt: 1800000000000, confidence: 'high' }
export const reserves = { turn: 1000, safety: 200, handoff: 1500, tool: 1000, stepMedian: 1000, effective: 14000 }
export const caps: Caps = { cycles: 10, tokens: 1000000, wallMs: 3600000, moneyMicros: null, j3: null }
export const plan: Plan = { revision: 'r1', base: 'a'.repeat(40), goal: 'Implement the fixture task.', items: [{ id: 'one', title: 'fixture item', dependsOn: [], acceptance: ['true'], protectedPaths: ['tests'] }], protectedPaths: ['.github'] }
export function fixture(options: { path?: string; fault?: (point: string) => void; runFault?: import('../../src/runs/store.ts').RunStoreOptions['fault']; logFault?: import('../../src/session-log/log.ts').SessionLogOptions['fault']; actions?: (prompt: string, calls: number) => string | Promise<string>; narrativeFails?: boolean; probeFails?: boolean; caps?: Partial<Caps>; exact?: boolean; count?: (text: string) => number; reserves?: Partial<Reserves> } = {}) {
  const f = runFixture(options.path, { fault: options.runFault, logFault: options.logFault })
  const relay = new RelayStore(f.db, f.store, f.scrubber, () => 1800000000000, options.fault)
  const run = f.store.create(), attempt = f.store.start(run.id)
  relay.init(attempt, plan, { ...caps, ...options.caps })
  const prompts: string[] = []
  let workCalls = 0
  const limits = { ...reserves, ...options.reserves }
  const count = options.count ?? ((text: string) => Buffer.byteLength(text) + window.framingTokens)
  const model: RelayModel = {
    observe: async () => window, count, countIsExact: options.exact ?? false, maxCostMicros: () => 10,
    async call(prompt, opts): Promise<Reply> {
      if (model.count(prompt) > thresholds(opts.window, { ...limits, effective: opts.window.tokens }).H) throw new Error('FIXTURE OVERSIZE REQUEST')
      opts.onStarted?.()
      prompts.push(prompt)
      let text: string
      if (prompt.startsWith('Write a fresh')) {
        if (options.narrativeFails) throw new Error('fixture unavailable')
        text = 'Continue the plan using its evidence.'
      } else if (prompt.startsWith('Answer these five')) {
        text = options.probeFails ? '{}' : canonical(probes(relay.sealed(attempt)!.ledger))
      } else text = options.actions ? await options.actions(prompt, ++workCalls) : canonical({ action: workCalls++ === 0 ? 'verify' : 'handoff', ...(workCalls === 1 ? { item: 'one' } : {}) })
      return { text, inputTokens: model.count(prompt), outputTokens: Math.min(200, opts.maxOutput), moneyMicros: 1, inputTruncated: false, outputLimited: false }
    },
  }
  let head = plan.base
  const workspace: RelayWorkspace = {
    observe: async () => ({ head, files: head === plan.base ? [] : ['src/fixture.ts'], diffstat: '', nonemptyCommit: head !== plan.base }),
    validate: async () => {}, bundle: async () => Buffer.from('fixture-git-bundle'),
    checkpoint: async () => { head = 'b'.repeat(40) },
    verify: async (_p, item) => ({ item, head, ok: true, output: 'fixture pass' }),
    tool: async (_name, args) => String(args.output ?? 'fixture tool result'),
  }
  const executor = new RelayExecutor(relay, model, workspace, limits, f.scrubber)
  return { ...f, relay, run, attempt, prompts, model, workspace, executor }
}
