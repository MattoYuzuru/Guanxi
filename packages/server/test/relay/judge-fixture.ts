import type { RelayStartInput } from '@guanxi/contract'
import type { JudgeRole, RelayDelegationBrief } from '../../src/relay/delegation-brief.ts'
import type { JudgeSignalPolicy } from '../../src/relay/judge-signals.ts'
import { reply } from '../fixtures/fake-llama-server.ts'

/** The first words of every J2/J3 prompt (the cascade's rubric). A fake model recognises a judge call by them. */
export const JUDGE_PROMPT = 'Assess harness evidence only'
export const signalPolicy: JudgeSignalPolicy = { heartbeatStallMs: 60_000, noProgressCycles: 3, repeatedFailureCycles: 3, editRevertCycles: 3, repeatedDeadEnds: 3, tokenBlowupRatio: 2 }
export const judgeVerdict = JSON.stringify({ taxonomy: 'progress', verdict: 'consistent', evidenceRefs: ['plan'], diagnosisHint: 'Evidence agrees.' })

export function judgeRole(connectionId: string, model: string, overrides: Partial<JudgeRole> = {}): JudgeRole {
  return { connectionId, model, windowTokens: 16000, maxInputTokens: 12000, maxOutputTokens: 1000, temperature: 0, tokenReserve: 13000, moneyReserveMicros: 0, ...overrides }
}
/** A delegation brief for exactly the plan and caps of one public start, with J2 on the relay's own model. J3 is off. */
export function startBrief(input: Pick<RelayStartInput, 'plan' | 'caps' | 'connectionId' | 'model'>, options: { accountId?: string; executorNodeId?: string; j2?: JudgeRole | null; samples?: 2 | 3 } = {}): RelayDelegationBrief {
  return {
    version: 1, objective: input.plan.goal, definitionOfDone: ['every item passes its acceptance'], plan: structuredClone(input.plan),
    estimatesMs: Object.fromEntries(input.plan.items.map(item => [item.id, 60_000])),
    identity: { accountId: options.accountId ?? 'local', homeNodeId: 'home', executorNodeId: options.executorNodeId ?? 'home' },
    constraints: { roots: ['/fixture'], commands: ['true'], network: 'none', protectedPaths: [], localOnly: true },
    resources: { windowTokens: 16000, keepAlive: 'fixture-policy', reserves: { turn: 1000 } },
    caps: { ...input.caps },
    roles: { executor: { connectionId: input.connectionId, model: input.model },
      j2: options.j2 === undefined ? judgeRole(input.connectionId, input.model) : options.j2, j3: null, fallbacks: [], onQuotaLow: 'escalate' },
    judges: { samples: options.samples ?? 2, checker: null, j3: { enabled: false, maxCallsPerRun: 0, maxCallsPerNight: 0, override: null, tokenCapPerNight: 0, moneyCapPerNightMicros: 0 } },
    wake: { timeZone: 'America/New_York', nightStartsHour: 20, completionHour: 8, completion: 'defer', failure: 'immediate' },
    report: { format: 'fixture', evidenceRefs: [] },
  }
}

/** The fake llama-server model of the unit fixtures: the relay script of `remote-fixture.ts`, plus a valid verdict for a judge prompt. */
export const relayAndJudgeScript = reply((prompt: string) => {
  const state = globalThis as unknown as { work?: number }
  if (prompt.startsWith('<|user|>\nAssess harness evidence only')) return '{"taxonomy":"progress","verdict":"consistent","evidenceRefs":["plan"],"diagnosisHint":"Evidence agrees."}'
  if (prompt.startsWith('<|user|>\nWrite a fresh')) return 'Completed fixture acceptance.'
  state.work = (state.work ?? 0) + 1
  return JSON.stringify(state.work === 1 ? { action: 'tool', name: 'file_read', args: { path: 'src/item.txt' } }
    : state.work === 2 ? { action: 'verify', item: 'one' } : { action: 'handoff' })
})
/** The same relay, with a judge that answers in prose instead of the strict verdict. */
export const relayAndGarbledJudgeScript = reply((prompt: string) => {
  const state = globalThis as unknown as { work?: number }
  if (prompt.startsWith('<|user|>\nAssess harness evidence only')) return 'The work looks fine to me.'
  if (prompt.startsWith('<|user|>\nWrite a fresh')) return 'Completed fixture acceptance.'
  state.work = (state.work ?? 0) + 1
  return JSON.stringify(state.work === 1 ? { action: 'tool', name: 'file_read', args: { path: 'src/item.txt' } }
    : state.work === 2 ? { action: 'verify', item: 'one' } : { action: 'handoff' })
})
