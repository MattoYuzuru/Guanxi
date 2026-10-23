import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonical, render } from '../../src/relay/handoff.ts'
import { RelayExecutor } from '../../src/relay/executor.ts'
import {
  JUDGE_JOURNAL_MIGRATION_42,
  JudgeJournalStore,
  journalReplayRun,
  readJournalCorpus,
  readJournalReplay,
  type JudgeJournalEntry
} from '../../src/relay/judge-journal.ts'
import { RelayJudgeCascade, type RelayCascadeInput } from '../../src/relay/judge-cascade.ts'
import { evaluateJudgeSignals, type JudgeObservation, type JudgeSignalPolicy } from '../../src/relay/judge-signals.ts'
import { DEFAULT_RELAY_LIMITS } from '../../src/relay/types.ts'
import type { RelayDelegationBrief, JudgeRole } from '../../src/relay/delegation-brief.ts'
import { score } from '../../src/relay/judge-replay.ts'
import { buildWakePacket } from '../../src/leads/packet.ts'
import type { ChildReport } from '../../src/leads/types.ts'
import { signedDispatchGrantSchema } from '@guanxi/contract/federation'
import { sessionExportSchema } from '@guanxi/contract'
import { DEFAULT_REASONING_RETENTION_MS } from '../../src/session-log/log.ts'
import { fixture, plan, reserves, caps } from './fixture.ts'

const CANARY_PATH = '/r3-journal-canary/private/notes-7f3a.md'
const CANARY_SECRET = 'r3-journal-canary-secret-91c7f4e2'

const policy: JudgeSignalPolicy = {
  heartbeatStallMs: 100,
  noProgressCycles: 2,
  repeatedFailureCycles: 2,
  editRevertCycles: 2,
  repeatedDeadEnds: 2,
  tokenBlowupRatio: 2
}

const role: JudgeRole = {
  connectionId: 'installed',
  model: 'fixture-local',
  windowTokens: 16000,
  maxInputTokens: 12000,
  maxOutputTokens: 1000,
  temperature: 0,
  tokenReserve: 13000,
  moneyReserveMicros: 0
}

function brief(): RelayDelegationBrief {
  return {
    version: 1,
    objective: plan.goal,
    definitionOfDone: ['Pass planned acceptance'],
    plan: structuredClone(plan),
    estimatesMs: { one: 60000 },
    identity: { accountId: 'owner-fixture', homeNodeId: 'home', executorNodeId: 'home' },
    constraints: {
      roots: ['/fixture'],
      commands: ['true'],
      network: 'none',
      protectedPaths: plan.protectedPaths,
      localOnly: true
    },
    resources: { windowTokens: 16000, keepAlive: 'fixture-policy', reserves: { turn: 1000 } },
    caps: { ...caps },
    roles: {
      executor: { connectionId: 'fixture', model: 'fixture' },
      j2: { ...role },
      j3: { ...role },
      fallbacks: [],
      onQuotaLow: 'escalate'
    },
    judges: {
      samples: 2,
      checker: null,
      j3: {
        enabled: false,
        maxCallsPerRun: 3,
        maxCallsPerNight: 3,
        override: null,
        tokenCapPerNight: 1000000,
        moneyCapPerNightMicros: 0
      }
    },
    wake: {
      timeZone: 'America/New_York',
      nightStartsHour: 20,
      completionHour: 8,
      completion: 'defer',
      failure: 'immediate'
    },
    report: { format: 'fixture', evidenceRefs: [] }
  }
}

function validResult(): string {
  return canonical({
    taxonomy: 'progress',
    verdict: 'consistent',
    evidenceRefs: ['plan'],
    diagnosisHint: 'Evidence agrees.'
  })
}

function cascadeInput(overrides: Partial<RelayCascadeInput> = {}): RelayCascadeInput {
  return {
    brief: brief(),
    model: { admit: async () => true, sample: async () => validResult() },
    ...overrides
  }
}

function observationAt(observedAt: number, patch: Partial<JudgeObservation> = {}): JudgeObservation {
  return {
    observedAt,
    heartbeatAt: observedAt - 1,
    lease: { expiresAt: observedAt + 60_000, current: true },
    deadlineAt: observedAt + 120_000,
    disk: { availableBytes: 10_000_000, requiredBytes: 1_000_000 },
    cycle: 1,
    noProgressCycles: 0,
    sameFailureStreak: 0,
    editRevertStreak: 0,
    deadEndRepetitions: 0,
    protectedPathEdits: [],
    outOfScopeEdits: [],
    tokensThisItem: 10,
    tokenBudgetForItem: 1000,
    crashed: false,
    ...patch
  }
}

function journalEntry(
  runId: string,
  sessionId: string,
  requestKey: string,
  finishedAt: number
): JudgeJournalEntry {
  return {
    runId,
    sessionId,
    attemptId: 'attempt-fixture',
    cycle: 1,
    phase: 'cycle_start',
    layer: 'J2',
    reason: 'scheduled',
    requestKey,
    packet: { plan: { goal: 'fixture' }, items: { one: 'done' }, gates: [], head: 'h' },
    observation: null,
    policy: null,
    signals: [],
    state: 'completed',
    result: { samples: [] },
    startedAt: finishedAt - 1,
    finishedAt
  }
}

test('cascade without a journal and journal:null executor leave no journal table', async () => {
  const f = fixture()
  try {
    const c = new RelayJudgeCascade(f.relay, cascadeInput())
    c.bind(f.attempt)
    await c.sample(f.attempt, 'cycle_start', new AbortController().signal)
    assert.equal(
      f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='relay_journal_migrations'").get(),
      undefined
    )
  } finally {
    f.close()
  }

  const g = fixture()
  try {
    const executor = new RelayExecutor(
      g.relay,
      g.model,
      g.workspace,
      reserves,
      g.scrubber,
      DEFAULT_RELAY_LIMITS,
      undefined,
      { policy, collect: async () => observationAt(g.relay.clock()) },
      cascadeInput({ journal: null })
    )
    await executor.run(g.attempt)
    assert.equal(
      g.db.prepare("SELECT 1 FROM sqlite_master WHERE name='relay_journal_migrations'").get(),
      undefined
    )
  } finally {
    g.close()
  }
})

test('default executor journal writes one completed row per J2 boundary with the full payload', async () => {
  const f = fixture()
  const observations: JudgeObservation[] = []
  let clock = f.relay.clock()
  try {
    const executor = new RelayExecutor(
      f.relay,
      f.model,
      f.workspace,
      reserves,
      f.scrubber,
      DEFAULT_RELAY_LIMITS,
      undefined,
      {
        policy,
        collect: async () => {
          const observation = observationAt(clock, {
            protectedPathEdits: clock === f.relay.clock() ? [CANARY_PATH] : []
          })
          clock += 1000
          observations.push(observation)
          return observation
        }
      },
      cascadeInput()
    )
    await executor.run(f.attempt)
    const store = new JudgeJournalStore(f.db, { scrubber: f.scrubber, clock: () => clock })
    const rows = store.readRun(f.run.id)
    assert.equal(rows.length, 2)
    assert.deepEqual(new Set(rows.map((row) => row.phase)), new Set(['cycle_start', 'pre_seal']))
    assert.equal(rows.every((row) => row.state === 'completed'), true)
    assert.equal(rows.every((row) => row.layer === 'J2'), true)
    assert.equal(rows.every((row) => row.policy !== null && row.observation !== null), true)
    assert.equal(rows.every((row) => row.started_at <= row.finished_at), true)
    assert.match(rows[0]!.observation!, new RegExp(CANARY_PATH))
    assert.doesNotMatch(rows[1]!.observation!, new RegExp(CANARY_PATH))
    const firstSignals = JSON.parse(rows[0]!.signals) as { code: string }[]
    assert.deepEqual(firstSignals.map((signal) => signal.code), ['protected_path_edit'])
    assert.deepEqual(JSON.parse(rows[1]!.signals), [])
    const firstPayload = JSON.parse(rows[0]!.packet) as { plan: { goal: string }; evidenceRefs: string[] }
    assert.equal(firstPayload.plan.goal, plan.goal)
    assert.equal(firstPayload.evidenceRefs.includes('plan'), true)
    const result = JSON.parse(rows[0]!.result) as { samples: unknown[]; agreement: boolean }
    assert.equal(result.samples.length, 2)
    assert.equal(result.agreement, true)
    assert.equal(observations.length, 2)
    assert.equal(
      f.db.prepare('SELECT version FROM relay_journal_migrations').get()!.version,
      42
    )
    assert.throws(
      () => f.db.prepare("UPDATE relay_judge_journal SET state='invalid'").run(),
      /append only/
    )
    assert.match(JUDGE_JOURNAL_MIGRATION_42, /ON DELETE CASCADE/)
  } finally {
    f.close()
  }
})

test('session, run and expiry purges delete rows; run deletion cascades; duplicate record is a no-op', () => {
  const f = fixture()
  try {
    const store = new JudgeJournalStore(f.db, { scrubber: f.scrubber, clock: f.relay.clock })
    const run = f.store.create()
    const now = f.relay.clock()
    store.record(journalEntry(run.id, run.session_id, 'request-a', now))
    store.record(journalEntry(run.id, run.session_id, 'request-b', now + 1))
    store.record(journalEntry(run.id, run.session_id, 'request-a', now + 2))
    assert.equal(
      f.db.prepare('SELECT count(*) AS n FROM relay_judge_journal').get()!.n,
      2
    )
    assert.equal(store.purgeSession(run.session_id), 2)
    assert.equal(
      f.db.prepare('SELECT count(*) AS n FROM relay_judge_journal').get()!.n,
      0
    )

    store.record(journalEntry(run.id, run.session_id, 'request-c', now))
    assert.equal(store.purgeRun(run.id), 1)
    store.record(journalEntry(run.id, run.session_id, 'request-d', now))
    assert.equal(store.purgeExpired(now + DEFAULT_REASONING_RETENTION_MS), 1)
    store.record(journalEntry(run.id, run.session_id, 'request-e', now))
    assert.equal(store.purgeExpired(now + DEFAULT_REASONING_RETENTION_MS - 1), 0)

    const cascaded = f.store.create()
    store.record(journalEntry(cascaded.id, cascaded.session_id, 'request-f', now))
    f.db.prepare('DELETE FROM durable_runs WHERE id=?').run(cascaded.id)
    assert.equal(
      f.db.prepare('SELECT count(*) AS n FROM relay_judge_journal WHERE run_id=?').get(cascaded.id)!.n,
      0
    )
  } finally {
    f.close()
  }
})

test('reader round-trips a finished run through the strict R3-b replay scorer', async () => {
  const f = fixture()
  let clock = f.relay.clock()
  try {
    const executor = new RelayExecutor(
      f.relay,
      f.model,
      f.workspace,
      reserves,
      f.scrubber,
      DEFAULT_RELAY_LIMITS,
      undefined,
      {
        policy,
        collect: async () => {
          const observation = observationAt(clock, {
            protectedPathEdits: clock === f.relay.clock() ? [CANARY_PATH] : []
          })
          clock += 1000
          return observation
        }
      },
      cascadeInput()
    )
    await executor.run(f.attempt)
    const store = new JudgeJournalStore(f.db, { scrubber: f.scrubber, clock: () => clock })
    const corpus = readJournalCorpus(store, [f.run.id])
    assert.equal(corpus.runs.length, 1)
    const run = corpus.runs[0]!
    assert.equal(run.origin, 'recorded')
    assert.equal(run.id, f.run.id)
    assert.deepEqual(run.labels, [])
    assert.equal(run.steps.length, 2)
    const rows = store.readRun(f.run.id)
    for (let index = 0; index < run.steps.length; index++) {
      assert.deepEqual(
        evaluateJudgeSignals(run.steps[index]!.observation, run.policy),
        JSON.parse(rows[index]!.signals)
      )
    }
    const scored = score(corpus)
    assert.equal(scored.runs, 1)
    assert.equal(scored.origins.recorded.runs, 1)
    assert.equal(scored.classes.protected_path_edit.fp, 1)
    assert.equal(scored.classes.loop.tn, 1)
    assert.equal(scored.gate.evaluated, false)

    const labelled = readJournalReplay(store, f.run.id, {
      labels: [{ fault: 'protected_path_edit', firstStep: 0 }]
    })
    assert.equal(labelled.labels.length, 1)
    assert.equal(score({ version: 1, runs: [labelled] }).classes.protected_path_edit.tp, 1)

    const tampered = store.readRun(f.run.id).map((row, index) =>
      index === 0 ? { ...row, signals: '[]' } : row
    )
    assert.throws(() => journalReplayRun(tampered), /recorded signals disagree/)

    const unfinished = f.store.create()
    assert.throws(() => store.readRun(unfinished.id), /not finished/)
  } finally {
    f.close()
  }
})

test('journal canaries stay local: no wake, handoff, F2, session export or captured log contains them', async () => {
  const f = fixture()
  const writes: string[] = []
  const originalStdout = process.stdout.write
  const originalStderr = process.stderr.write
  const originalLog = console.log
  const originalError = console.error
  const originalWarn = console.warn
  let clock = f.relay.clock()
  try {
    f.scrubber.register('secret://fixture/r3-journal', CANARY_SECRET)
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    console.log = (...args: unknown[]) => writes.push(args.map(String).join(' '))
    console.error = (...args: unknown[]) => writes.push(args.map(String).join(' '))
    console.warn = (...args: unknown[]) => writes.push(args.map(String).join(' '))
    const executor = new RelayExecutor(
      f.relay,
      f.model,
      f.workspace,
      reserves,
      f.scrubber,
      DEFAULT_RELAY_LIMITS,
      undefined,
      {
        policy,
        collect: async () =>
          observationAt(clock, {
            protectedPathEdits: [CANARY_PATH, CANARY_SECRET]
          })
      },
      cascadeInput()
    )
    await executor.run(f.attempt)

    const store = new JudgeJournalStore(f.db, { scrubber: f.scrubber, clock: () => clock })
    const journal = canonical(store.readRun(f.run.id))
    assert.match(journal, new RegExp(CANARY_PATH))
    assert.doesNotMatch(journal, new RegExp(CANARY_SECRET))

    const report: ChildReport = {
      items: [{ id: 'one', title: 'fixture item', status: 'done' }],
      gates: [{ item: 'one', ok: true, head: plan.base, output: 'fixture pass' }],
      head: plan.base,
      diffstat: '',
      handoff: { ref: 'run:fixture/cycles/1/handoff', cycle: 1 },
      narrative: 'ordinary narrative',
      openQuestions: [],
      metrics: { cycles: 1, tokens: 10, moneyMicros: 1 }
    }
    const wake = buildWakePacket(
      {
        runId: f.run.id,
        wakeSeq: 1,
        kind: 'resolution',
        outcome: 'completed',
        child: { runId: f.run.id, state: 'completed', attempts: 1, costs: [] },
        report,
        pendingChildren: []
      },
      f.scrubber
    )
    assert.doesNotMatch(wake.text, new RegExp(CANARY_PATH))
    assert.doesNotMatch(wake.text, new RegExp(CANARY_SECRET))

    const sealed = f.relay.sealed(f.attempt)
    assert.ok(sealed)
    const handoff = render(sealed!.handoff)
    assert.doesNotMatch(handoff, new RegExp(CANARY_PATH))
    assert.doesNotMatch(handoff, new RegExp(CANARY_SECRET))

    const signed = signedDispatchGrantSchema.parse({
      grant: {
        id: 'grant-fixture',
        offer: {
          id: 'offer-fixture',
          runId: f.run.id,
          sessionId: f.run.session_id,
          homeNodeId: 'home',
          executorNodeId: 'executor',
          fence: { attemptId: f.attempt.id, epoch: f.attempt.epoch, token: f.attempt.token },
          expiresAt: clock + 1000,
          mode: 'strict',
          resource: { kind: 'local_inference', model: 'fixture', requestedContext: 4096 }
        },
        reservationId: 'reservation-fixture',
        job: {
          kind: 'local_inference',
          model: 'fixture',
          context: 4096,
          outputTokens: 10,
          deadline: clock + 1000,
          messages: [{ role: 'user', content: 'ordinary request' }]
        },
        jobHash: 'a'.repeat(64),
        dispatchAuthorized: true
      },
      signature: 'fixture-signature'
    })
    const f2 = canonical(signed)
    assert.doesNotMatch(f2, new RegExp(CANARY_PATH))
    assert.doesNotMatch(f2, new RegExp(CANARY_SECRET))

    const events = f.log.readAll(f.run.session_id, 'person')
    const exported = sessionExportSchema.parse({
      exportVersion: 1,
      sessionId: f.run.session_id,
      exportedAt: new Date(clock).toISOString(),
      lastSeq: events.at(-1)?.seq ?? 0,
      excluded: { reasoning: 0 },
      events
    })
    const exportText = canonical(exported)
    assert.doesNotMatch(exportText, new RegExp(CANARY_PATH))
    assert.doesNotMatch(exportText, new RegExp(CANARY_SECRET))

    const captured = writes.join('\n')
    assert.doesNotMatch(captured, new RegExp(CANARY_PATH))
    assert.doesNotMatch(captured, new RegExp(CANARY_SECRET))
  } finally {
    process.stdout.write = originalStdout
    process.stderr.write = originalStderr
    console.log = originalLog
    console.error = originalError
    console.warn = originalWarn
    f.close()
  }
})

test('a failing local journal never changes the completed judge verdict', async () => {
  const f = fixture()
  try {
    const cascade = new RelayJudgeCascade(
      f.relay,
      cascadeInput({
        journal: {
          record() {
            throw new Error('local journal unavailable')
          }
        }
      })
    )
    cascade.bind(f.attempt)
    await cascade.sample(f.attempt, 'cycle_start', new AbortController().signal)
    const row = f.db
      .prepare("SELECT state FROM relay_judge_requests WHERE layer='J2'")
      .get()!
    assert.equal(row.state, 'completed')
  } finally {
    f.close()
  }
})
