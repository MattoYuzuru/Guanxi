import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RelayExecutor } from '../../src/relay/executor.ts'
import { hash } from '../../src/relay/handoff.ts'
import { prepareJudgeSignals, type RelayJudgeInput } from '../../src/relay/judge-host.ts'
import type { JudgeObservation, JudgeSignalPolicy } from '../../src/relay/judge-signals.ts'
import { DEFAULT_RELAY_LIMITS, type Ledger } from '../../src/relay/types.ts'
import { fixture, plan, reserves } from './fixture.ts'

const policy: JudgeSignalPolicy = {
  heartbeatStallMs: 10,
  noProgressCycles: 3,
  repeatedFailureCycles: 4,
  editRevertCycles: 5,
  repeatedDeadEnds: 6,
  tokenBlowupRatio: 2,
}

interface ParsedNote {
  relay?: string
  phase?: 'cycle_start' | 'pre_seal'
  cycle?: number
  signals?: Array<{ layer: 'J0' | 'J1'; code: string }>
  unknownFacts?: string[]
  correct?: boolean
}

function observation(patch: Partial<JudgeObservation> = {}): JudgeObservation {
  return {
    observedAt: 1_000,
    heartbeatAt: null,
    lease: null,
    deadlineAt: null,
    disk: null,
    cycle: 1,
    noProgressCycles: 0,
    sameFailureStreak: 0,
    editRevertStreak: 0,
    deadEndRepetitions: 0,
    protectedPathEdits: [],
    outOfScopeEdits: [],
    tokensThisItem: 0,
    tokenBudgetForItem: null,
    crashed: false,
    ...patch,
  }
}

type Fixture = ReturnType<typeof fixture>

function noteText(event: { type: string; data: unknown }): string {
  const data = event.data as { text?: unknown } | null
  return typeof data?.text === 'string' ? data.text : ''
}

function allNotes(f: Fixture): ParsedNote[] {
  return f.log.readAll(f.run.session_id, 'person')
    .filter(event => event.type === 'agent.note')
    .map(event => JSON.parse(noteText(event)) as ParsedNote)
}

function judgeNotes(f: Fixture): ParsedNote[] {
  return allNotes(f).filter(note => note.relay === 'judge_signals')
}

function withJudge(f: Fixture, judge?: RelayJudgeInput): RelayExecutor {
  return new RelayExecutor(f.relay, f.model, f.workspace, reserves, f.scrubber, DEFAULT_RELAY_LIMITS, undefined, judge)
}

test('absence of judge configuration preserves prior execution and publishes no judge event', async () => {
  const f = fixture()
  try {
    const ledger = await f.executor.run(f.attempt)
    assert.equal(ledger.state, 'finish')
    assert.equal(f.store.get(f.run.id).state, 'completed')
    assert.equal(judgeNotes(f).length, 0)
    assert.equal(allNotes(f).filter(note => String(note.relay).startsWith('judge_')).length, 0)
  } finally { f.close() }
})

test('configured host samples actual cycle_start and pre_seal boundaries with unknown metadata only', async () => {
  const canary = 'synthetic-private-path-7f3a'
  const f = fixture()
  const seen: Array<{ state: string; cycle: number; item: string; prompts: number }> = []
  const judge: RelayJudgeInput = {
    policy,
    collect: async input => {
      seen.push({ state: input.ledger.state, cycle: input.ledger.cycle, item: input.ledger.items.one!, prompts: f.prompts.length })
      assert.equal(input.attempt.runId, f.run.id)
      assert.deepEqual(Object.keys(input.attempt).sort(), ['epoch', 'id', 'runId', 'token'])
      return observation({ cycle: input.ledger.cycle, noProgressCycles: 3, protectedPathEdits: [canary] })
    },
  }
  try {
    const ledger = await withJudge(f, judge).run(f.attempt)
    assert.equal(ledger.state, 'finish')
    assert.deepEqual(seen, [
      { state: 'orient', cycle: 1, item: 'open', prompts: 0 },
      { state: 'handoff_write', cycle: 1, item: 'done', prompts: 2 },
    ])
    const notes = judgeNotes(f)
    assert.equal(notes.length, 2)
    assert.deepEqual(notes.map(note => note.phase), ['cycle_start', 'pre_seal'])
    assert.deepEqual(notes.map(note => note.cycle), [1, 1])
    for (const note of notes) {
      assert.deepEqual(Object.keys(note).sort(), ['cycle', 'phase', 'relay', 'signals', 'unknownFacts'])
      assert.deepEqual(note.unknownFacts, ['heartbeat', 'lease', 'deadline', 'disk', 'tokenBudget'])
      assert.deepEqual(note.signals!.map(signal => signal.code), ['no_progress', 'protected_path_edit'])
      assert.deepEqual(note.signals!.map(signal => signal.layer), ['J1', 'J1'])
    }
    const raw = f.log.readAll(f.run.session_id, 'person')
      .filter(event => event.type === 'agent.note' && noteText(event).includes('judge_signals'))
      .map(event => noteText(event)).join('\n')
    assert.equal(raw.includes(canary), false)
    for (const key of ['heartbeatAt', 'deadlineAt', 'protectedPathEdits', 'outOfScopeEdits', 'tokenBudgetForItem', 'sameFailureStreak', 'crashed']) {
      assert.equal(raw.includes(key), false, key)
    }
    const persisted = JSON.stringify(f.db.prepare('SELECT * FROM relay_runs').all())
      + JSON.stringify(f.db.prepare('SELECT * FROM relay_seals').all())
    assert.equal(persisted.includes(canary), false)
    assert.equal(persisted.includes('protectedPathEdits'), false)
  } finally { f.close() }
})

test('admission copies and freezes policy, rejects invalid configuration without calling the collector, and detaches the ledger', async () => {
  const canary = 'synthetic-private-path-detached-91bc'
  const mutablePolicy = { ...policy }
  const f = fixture()
  let calls = 0
  const judge: RelayJudgeInput = {
    policy: mutablePolicy,
    collect: async input => {
      calls++
      const copy = input.ledger as Ledger
      copy.plan.goal = canary
      copy.cycle = 999
      copy.items.one = 'done'
      assert.equal(Object.isFrozen(input.attempt), true)
      return observation({ noProgressCycles: 2, heartbeatAt: 999, lease: { expiresAt: 1_001, current: true } })
    },
  }
  assert.throws(() => prepareJudgeSignals({ policy: { ...policy, noProgressCycles: 0 }, collect: async () => observation() }), /judge_config_invalid/)
  assert.throws(() => prepareJudgeSignals({ policy, collect: 1 } as unknown as RelayJudgeInput), /judge_config_invalid/)
  const prepared = prepareJudgeSignals(judge)
  assert.equal(Object.isFrozen(prepared.policy), true)
  const executor = withJudge(f, judge)
  assert.equal(calls, 0)
  mutablePolicy.noProgressCycles = 1
  try {
    const ledger = await executor.run(f.attempt)
    assert.equal(ledger.state, 'finish')
    const authoritative = f.relay.read(f.run.id)
    assert.equal(authoritative.plan.goal, plan.goal)
    assert.equal(authoritative.cycle, 1)
    assert.equal(calls, 2)
    const notes = judgeNotes(f)
    assert.equal(notes.length, 2)
    assert.equal(notes.every(note => note.cycle === 1), true)
    assert.equal(notes.every(note => JSON.stringify(note.unknownFacts) === JSON.stringify(['deadline', 'disk', 'tokenBudget'])), true)
    assert.equal(notes.filter(note => note.signals!.some(signal => signal.code === 'no_progress')).length, 0)
    const persisted = JSON.stringify(f.db.prepare('SELECT * FROM relay_runs').all())
      + JSON.stringify(f.db.prepare('SELECT * FROM relay_seals').all())
    assert.equal(persisted.includes(canary), false)
  } finally { f.close() }
})

test('cancellation across a pending collector yields zero judge events and zero model calls', async () => {
  const f = fixture()
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  let sawAbort = false
  const judge: RelayJudgeInput = {
    policy,
    collect: async input => {
      entered()
      await pending
      sawAbort = input.signal.aborted
      return observation()
    },
  }
  const executor = withJudge(f, judge)
  try {
    const running = executor.run(f.attempt)
    await started
    executor.stop()
    release()
    const ledger = await running
    assert.equal(sawAbort, true)
    assert.equal(judgeNotes(f).length, 0)
    assert.equal(f.prompts.length, 0)
    assert.equal(f.store.get(f.run.id).state, 'input_required')
    assert.equal(ledger.pendingCall, null)
  } finally { f.close() }
})

test('a fence lost while the collector is pending yields zero stale judge events and zero model calls', async () => {
  const f = fixture()
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  const judge: RelayJudgeInput = {
    policy,
    collect: async () => {
      entered()
      await pending
      return observation()
    },
  }
  const executor = withJudge(f, judge)
  try {
    const running = executor.run(f.attempt)
    await started
    f.store.cancel(f.run.id)
    release()
    await running
    assert.equal(judgeNotes(f).length, 0)
    assert.equal(f.prompts.length, 0)
    assert.equal(f.store.get(f.run.id).state, 'canceled')
    assert.equal(f.log.readAll(f.run.session_id, 'person').filter(event => event.type === 'error').length, 0)
  } finally { f.close() }
})

test('a collector rejection before sealing fails closed with one fixed code and no follow-up model call', async () => {
  const canary = 'synthetic-collector-failure-2c7d'
  const f = fixture()
  let calls = 0
  const judge: RelayJudgeInput = {
    policy,
    collect: async () => {
      if (++calls === 1) return observation()
      throw new Error(canary)
    },
  }
  try {
    const ledger = await withJudge(f, judge).run(f.attempt)
    assert.equal(calls, 2)
    const notes = judgeNotes(f)
    assert.equal(notes.length, 1)
    assert.equal(notes[0]!.phase, 'cycle_start')
    assert.equal(f.prompts.filter(prompt => prompt.startsWith('Write a fresh')).length, 0)
    assert.equal(f.prompts.length, 2)
    const errors = f.log.readAll(f.run.session_id, 'person').filter(event => event.type === 'error')
    assert.equal(errors.length, 1)
    assert.equal((errors[0]!.data as { code?: string }).code, 'judge_observation_unavailable')
    assert.equal(JSON.stringify(errors).includes(canary), false)
    assert.equal(String(f.db.prepare('SELECT snapshot FROM relay_runs WHERE run_id=?').get(f.run.id)!.snapshot).includes(canary), false)
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM relay_seals').get()!.n, 0)
    assert.equal(f.store.get(f.run.id).state, 'input_required')
    assert.equal(ledger.state, 'handoff_write')
    assert.equal(ledger.pendingCall, null)
  } finally { f.close() }
})

test('an invalid observation fails closed with one fixed code and no path payload', async () => {
  const canary = 'synthetic-private-path-invalid-5e1f'
  const f = fixture()
  const judge: RelayJudgeInput = {
    policy,
    collect: async () => observation({ cycle: -1, protectedPathEdits: [canary] }),
  }
  try {
    const ledger = await withJudge(f, judge).run(f.attempt)
    assert.equal(judgeNotes(f).length, 0)
    assert.equal(f.prompts.length, 0)
    const errors = f.log.readAll(f.run.session_id, 'person').filter(event => event.type === 'error')
    assert.equal(errors.length, 1)
    assert.equal((errors[0]!.data as { code?: string }).code, 'judge_observation_invalid')
    assert.equal(JSON.stringify(errors).includes(canary), false)
    const persisted = JSON.stringify(f.db.prepare('SELECT * FROM relay_runs').all())
      + JSON.stringify(f.db.prepare('SELECT * FROM relay_seals').all())
    assert.equal(persisted.includes(canary), false)
    assert.equal(f.store.get(f.run.id).state, 'input_required')
    assert.equal(ledger.pendingCall, null)
  } finally { f.close() }
})

test('multi-cycle judge sampling preserves every sealed hash, probe and one note per phase', async () => {
  const f = fixture({
    actions: (_prompt, call) => JSON.stringify(
      call === 1 || call === 3 ? { action: 'checkpoint' }
        : call === 5 ? { action: 'verify', item: 'one' } : { action: 'handoff' }),
  })
  let collected = 0
  const judge: RelayJudgeInput = {
    policy,
    collect: async input => { collected++; return observation({ cycle: input.ledger.cycle, noProgressCycles: 3 }) },
  }
  try {
    const ledger = await withJudge(f, judge).run(f.attempt)
    assert.equal(ledger.state, 'finish')
    assert.equal(ledger.cycle, 3)
    assert.equal(collected, 6)
    const notes = judgeNotes(f)
    assert.equal(notes.length, 6)
    for (const cycle of [1, 2, 3]) {
      assert.equal(notes.filter(note => note.cycle === cycle && note.phase === 'cycle_start').length, 1)
      assert.equal(notes.filter(note => note.cycle === cycle && note.phase === 'pre_seal').length, 1)
    }
    assert.equal(notes.filter(note => note.signals!.some(signal => signal.code === 'no_progress')).length, 6)
    const seals = f.db.prepare('SELECT ledger,handoff FROM relay_seals ORDER BY cycle').all() as Array<{ ledger: string; handoff: string }>
    assert.equal(seals.length, 3)
    for (const row of seals) {
      const snapshot = JSON.parse(row.ledger) as Record<string, unknown>
      const handoff = JSON.parse(row.handoff) as { ledgerHash: string }
      assert.equal(handoff.ledgerHash, hash(snapshot))
      assert.equal('judgeSignals' in snapshot, false)
      assert.equal('judgeObservation' in snapshot, false)
    }
    const probes = allNotes(f).filter(note => note.relay === 'probe')
    assert.equal(probes.length, 2)
    assert.equal(probes.every(note => note.correct === true), true)
    assert.equal(f.prompts.filter(prompt => prompt.startsWith('Answer these five')).length, 2)
  } finally { f.close() }
})
