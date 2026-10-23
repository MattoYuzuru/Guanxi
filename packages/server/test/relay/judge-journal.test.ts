import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Hono } from 'hono'
import { byteHash, canonical, probes, render } from '../../src/relay/handoff.ts'
import { RelayExecutor } from '../../src/relay/executor.ts'
import {
  JUDGE_JOURNAL_MIGRATION_43,
  JudgeJournalStore,
  journalIfPresent,
  journalReplayRun,
  readJournalCorpus,
  readJournalReplay,
  type JudgeJournalEntry,
  type JudgeJournalRow
} from '../../src/relay/judge-journal.ts'
import { RelayJudgeCascade, type RelayCascadeInput } from '../../src/relay/judge-cascade.ts'
import { evaluateJudgeSignals, type JudgeObservation, type JudgeSignalPolicy } from '../../src/relay/judge-signals.ts'
import { DEFAULT_RELAY_LIMITS } from '../../src/relay/types.ts'
import type { RelayDelegationBrief, JudgeRole } from '../../src/relay/delegation-brief.ts'
import { score } from '../../src/relay/judge-replay.ts'
import { buildWakePacket } from '../../src/leads/packet.ts'
import type { ChildReport } from '../../src/leads/types.ts'
import { signedDispatchGrantSchema } from '@guanxi/contract/federation'
import { sessionLogRoutes } from '../../src/session-log/routes.ts'
import { cascadeWithJournal, relayPlugin, type RelayService } from '../../src/relay/plugin.ts'
import { sessionExportSchema } from '@guanxi/contract'
import { DEFAULT_REASONING_RETENTION_MS } from '../../src/session-log/log.ts'
import { SecretScrubber } from '../../src/egress/scrubber.ts'
import { fixture, plan, reserves, caps } from './fixture.ts'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
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

/** Drive the real plugin's `execute` service with a fixture local runtime, so the default
 * executor journal is exercised through the path a public start uses. */
function pluginService(f: ReturnType<typeof fixture>): RelayService {
  let work = 0
  const connections = {
    snapshot: () => ({ connections: [{ id: 'fixture-connection', kind: 'local_runtime' }] }),
    localChat: async (
      _scope: string,
      _connectionId: string,
      request: { messages: { content: string }[] }
    ) => {
      const prompt = request.messages[0]!.content
      let text: string
      if (prompt.startsWith('Answer these five')) {
        const latest = f.db
          .prepare('SELECT ledger FROM relay_seals WHERE run_id=? ORDER BY cycle DESC LIMIT 1')
          .get(f.run.id) as { ledger: string } | undefined
        text = canonical(probes(latest ? JSON.parse(latest.ledger) : f.relay.read(f.run.id)))
      } else if (prompt.startsWith('Write a fresh')) {
        text = 'fixture narrative'
      } else {
        work++
        text = canonical(
          work === 1 ? { action: 'verify', item: 'one' } : { action: 'handoff' }
        )
      }
      return {
        message: { role: 'assistant', content: text },
        prompt_eval_count: f.model.count(prompt),
        eval_count: 10,
        done_reason: 'stop'
      }
    }
  }
  const provided = new Map<string, unknown>()
  const services: Record<string, unknown> = {
    'runs.durable': { store: f.store },
    'connections.registry': connections,
    'session.log': f.log,
    'egress.scrubber': f.scrubber
  }
  relayPlugin.apply(
    {
      service: (name: string) => services[name],
      provide: (name: string, service: unknown) => provided.set(name, service),
      effect: () => undefined
    } as never,
    { db: f.db }
  )
  return provided.get('agent.relay') as RelayService
}

async function executeThroughPlugin(f: ReturnType<typeof fixture>): Promise<void> {
  const service = pluginService(f)
  await service.execute(f.attempt, {
    connectionId: 'fixture-connection',
    model: 'fixture-model',
    meter: f.model,
    workspace: f.workspace,
    reserves,
    cascade: cascadeInput()
  })
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
    unknownFacts: [],
    unobserved: [],
    state: 'completed',
    result: { samples: [] },
    startedAt: finishedAt - 1,
    finishedAt
  }
}

function replayRow(cycle: number, packet: unknown): JudgeJournalRow {
  const observedAt = 1_000_000 + cycle * 1_000
  const observation = observationAt(observedAt, { cycle })
  return {
    id: cycle,
    run_id: 'run',
    session_id: 'session',
    attempt_id: 'attempt',
    cycle,
    phase: 'cycle_start',
    layer: 'J2',
    reason: 'scheduled',
    request_key: `row-${cycle}`,
    packet: canonical(packet),
    observation: canonical(observation),
    policy: canonical(policy),
    signals: canonical(evaluateJudgeSignals(observation, policy)),
    unknown_facts: '[]',
    unobserved: '[]',
    state: 'completed',
    result: '{}',
    started_at: observedAt,
    finished_at: observedAt,
    expires_at: observedAt + 1_000_000
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
      43
    )
    assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, 33)
    assert.equal(f.db.prepare('SELECT version FROM relay_migrations').get()!.version, 35)
    assert.equal(f.db.prepare('SELECT version FROM relay_judge_migrations').get()!.version, 38)
    assert.throws(
      () => f.db.prepare("UPDATE relay_judge_journal SET state='invalid'").run(),
      /append only/
    )
    assert.match(JUDGE_JOURNAL_MIGRATION_43, /ON DELETE CASCADE/)
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

    // A parent Thread TTL shortens, never extends, the 7-day diagnostic window.
    const created = new Date(now - 7 * 24 * 60 * 60 * 1_000).toISOString()
    const activity = new Date(now - 6 * 24 * 60 * 60 * 1_000).toISOString()
    f.db
      .prepare(
        `INSERT INTO threads(
           id, title, mode, model, num_ctx, temperature, think, created_at, updated_at,
           retention_policy, retention_policy_source, retention_policy_updated_at,
           last_user_activity_at, last_user_activity_source
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run('thread-ttl', 'ttl', 'agent', 'fixture', 4096, 0.7, 'auto', created, created,
        'ttl', 'default', created, activity, 'chat_created')
    f.db
      .prepare('INSERT INTO sessions(id,kind,thread_id,created_at,last_seq) VALUES(?,?,?,?,0)')
      .run('session-ttl', 'agent', 'thread-ttl', created)
    const ttlRun = f.store.create({ id: 'run-ttl', sessionId: 'session-ttl' })
    store.record(journalEntry(ttlRun.id, ttlRun.session_id, 'request-ttl', now))
    const ttlExpiry = Date.parse(activity) + DEFAULT_REASONING_RETENTION_MS
    assert.equal(
      f.db.prepare("SELECT expires_at FROM relay_judge_journal WHERE request_key='request-ttl'").get()!.expires_at,
      ttlExpiry
    )
    assert.equal(store.purgeExpired(ttlExpiry - 1), 0)
    assert.equal(store.purgeExpired(ttlExpiry), 1)

    // A custom base retention still uses the fixed 7-day parent cap and a recent TTL parent.
    const recent = new Date(now - 1 * 24 * 60 * 60 * 1_000).toISOString()
    f.db
      .prepare(
        `INSERT INTO threads(
           id, title, mode, model, num_ctx, temperature, think, created_at, updated_at,
           retention_policy, retention_policy_source, retention_policy_updated_at,
           last_user_activity_at, last_user_activity_source
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run('thread-ttl2', 'ttl', 'agent', 'fixture', 4096, 0.7, 'auto', created, created,
        'ttl', 'default', created, recent, 'chat_created')
    f.db
      .prepare('INSERT INTO sessions(id,kind,thread_id,created_at,last_seq) VALUES(?,?,?,?,0)')
      .run('session-ttl2', 'agent', 'thread-ttl2', created)
    const short = new JudgeJournalStore(f.db, {
      scrubber: f.scrubber,
      clock: f.relay.clock,
      retentionMs: 2 * 24 * 60 * 60 * 1_000
    })
    const shortRun = f.store.create({ id: 'run-ttl2', sessionId: 'session-ttl2' })
    short.record(journalEntry(shortRun.id, shortRun.session_id, 'request-ttl2', now))
    const shortExpiry = now + 2 * 24 * 60 * 60 * 1_000
    assert.equal(
      f.db.prepare("SELECT expires_at FROM relay_judge_journal WHERE request_key='request-ttl2'").get()!.expires_at,
      shortExpiry
    )
    assert.equal(short.purgeExpired(shortExpiry), 1)

    const long = new JudgeJournalStore(f.db, {
      scrubber: f.scrubber,
      clock: f.relay.clock,
      retentionMs: 30 * 24 * 60 * 60 * 1_000
    })
    const longRun = f.store.create({ id: 'run-ttl3', sessionId: 'session-ttl' })
    long.record(journalEntry(longRun.id, longRun.session_id, 'request-ttl3', now))
    const parentCap = Date.parse(activity) + DEFAULT_REASONING_RETENTION_MS
    assert.equal(
      f.db.prepare("SELECT expires_at FROM relay_judge_journal WHERE request_key='request-ttl3'").get()!.expires_at,
      parentCap
    )

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

test('journal canaries stay local: no wake, handoff, F2, session export or captured log contains them', async (t) => {
  const f = fixture()
  const writes: string[] = []
  let clock = f.relay.clock()
  try {
    f.scrubber.register('secret://fixture/r3-journal', CANARY_SECRET)
    const capture = (...args: unknown[]) => {
      writes.push(args.map(String).join(' '))
    }
    for (const method of ['log', 'info', 'debug', 'trace', 'error', 'warn'] as const) {
      t.mock.method(console, method, capture)
    }
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

    // Exercise the real export route rather than rebuilding its body by hand.
    const app = new Hono().route('/api/sessions', sessionLogRoutes(() => f.log))
    const exported = await app.request(
      `/api/sessions/${f.run.session_id}/export?exportVersion=3`,
      {},
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never
    )
    assert.equal(exported.status, 200)
    const exportText = canonical(sessionExportSchema.parse(await exported.json()))
    assert.doesNotMatch(exportText, new RegExp(CANARY_PATH))
    assert.doesNotMatch(exportText, new RegExp(CANARY_SECRET))

    // Structural guard: none of the real egress producers may start reading the journal.
    for (const file of [
      'packages/server/src/leads/packet.ts',
      'packages/server/src/leads/service.ts',
      'packages/server/src/leads/children.ts',
      'packages/server/src/relay/handoff.ts',
      'packages/server/src/relay/start.ts',
      'packages/server/src/relay/routes.ts',
      'packages/server/src/relay/operational.ts',
      'packages/server/src/remote-attempts/dispatch.ts',
      'packages/server/src/federation/channel.ts',
      'packages/server/src/federation/service.ts',
      'packages/server/src/federation/replicas.ts',
      'packages/server/src/session-log/log.ts',
      'packages/server/src/session-log/routes.ts',
      'packages/bench/src/corpus.ts',
      'packages/bench/src/report.ts'
    ]) {
      const source = await readFile(join(REPO_ROOT, file), 'utf8')
      assert.doesNotMatch(source, /relay_judge_journal|judge-journal|JudgeJournal/, file)
    }

    const captured = writes.join('\n')
    assert.doesNotMatch(captured, new RegExp(CANARY_PATH))
    assert.doesNotMatch(captured, new RegExp(CANARY_SECRET))
    for (const file of [
      'packages/server/src/relay/judge-journal.ts',
      'packages/server/src/relay/judge-cascade.ts',
      'packages/server/src/relay/executor.ts',
      'packages/server/src/relay/plugin.ts'
    ]) {
      const source = await readFile(join(REPO_ROOT, file), 'utf8')
      assert.doesNotMatch(source, /console\.|process\.stdout|process\.stderr/, file)
    }
  } finally {
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

test('checker, J2 and J3 evaluations are journaled once and a duplicate request is not', async () => {
  const f = fixture()
  try {
    const configured = brief()
    const bytes = Buffer.from('lead-owned-checker')
    configured.judges.checker = {
      base: plan.base,
      path: 'checks/lead',
      digest: byteHash(bytes),
      timeoutMs: 100,
      outputBytes: 4096
    }
    configured.judges.j3.enabled = true
    const store = new JudgeJournalStore(f.db, { scrubber: f.scrubber, clock: f.relay.clock })
    const cascade = new RelayJudgeCascade(
      f.relay,
      cascadeInput({
        brief: configured,
        journal: store,
        checker: {
          read: async () => ({ base: plan.base, path: 'checks/lead', bytes }),
          run: async () => validResult()
        }
      })
    )
    f.relay.begin(f.attempt)
    cascade.bind(f.attempt)
    const signal = new AbortController().signal
    await cascade.sample(f.attempt, 'cycle_start', signal)
    await cascade.review(f.attempt, 'final', signal)
    const rows = () =>
      f.db
        .prepare('SELECT layer,state,result FROM relay_judge_journal WHERE run_id=? ORDER BY id')
        .all(f.run.id) as unknown as { layer: string; state: string; result: string }[]
    assert.deepEqual(
      rows().map((row) => row.layer),
      ['J1.5', 'J2', 'J3']
    )
    assert.equal(rows().every((row) => row.state === 'completed'), true)
    assert.equal((JSON.parse(rows()[0]!.result) as { verdict: string }).verdict, 'consistent')
    assert.equal((JSON.parse(rows()[1]!.result) as { samples: unknown[] }).samples.length, 2)
    assert.equal((JSON.parse(rows()[2]!.result) as { samples: unknown[] }).samples.length, 1)

    await cascade.sample(f.attempt, 'cycle_start', signal)
    assert.equal(rows().length, 3)
  } finally {
    f.close()
  }
})

test('expired rows are unreadable, late secrets are re-scrubbed, and an unready source refuses writes', () => {
  const f = fixture()
  try {
    const now = f.relay.clock()
    const store = new JudgeJournalStore(f.db, {
      scrubber: f.scrubber,
      clock: () => now,
      retentionMs: 1_000
    })
    const expired = f.store.create()
    store.record(journalEntry(expired.id, expired.session_id, 'expired', now))
    f.db.prepare("UPDATE durable_runs SET state='completed' WHERE id=?").run(expired.id)
    assert.equal(store.readRun(expired.id, now + 999).length, 1)
    assert.equal(store.readRun(expired.id, now + 1_000).length, 0)
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM relay_judge_journal WHERE request_key='expired'").get()!.n,
      1,
      'the read filters expiry without depending on the purge timer'
    )
    assert.equal(store.purgeExpired(now + 1_000), 1)

    const late = 'r3-late-secret-68d2c0f1'
    const lateRun = f.store.create()
    const lateEntry = journalEntry(lateRun.id, lateRun.session_id, 'late', now + 2_000)
    lateEntry.packet = { note: late }
    lateEntry.observation = observationAt(now + 2_000, { protectedPathEdits: [late] })
    lateEntry.policy = { ...policy }
    store.record(lateEntry)
    f.db.prepare("UPDATE durable_runs SET state='completed' WHERE id=?").run(lateRun.id)
    f.scrubber.register('secret://fixture/r3-late', late)
    const reread = canonical(store.readRun(lateRun.id, now + 2_000))
    assert.doesNotMatch(reread, new RegExp(late))
    assert.match(reread, /secret:\/\/fixture\/r3-late/)

    const pending = new SecretScrubber({ expectedSources: ['vault'] })
    try {
      const pendingStore = new JudgeJournalStore(f.db, {
        scrubber: pending,
        clock: () => now
      })
      const pendingRun = f.store.create()
      assert.throws(
        () => pendingStore.record(journalEntry(pendingRun.id, pendingRun.session_id, 'pending', now)),
        /egress not ready/
      )
      assert.equal(
        f.db.prepare("SELECT count(*) AS n FROM relay_judge_journal WHERE request_key='pending'").get()!.n,
        0
      )
    } finally {
      pending.close()
    }
  } finally {
    f.close()
  }
})

test('reader derives done claims and current-head acceptance conservatively', () => {
  const run = journalReplayRun([
    replayRow(1, {
      items: { one: 'done' },
      gates: [{ item: 'one', ok: true, head: 'h' }],
      head: 'h'
    }),
    replayRow(2, {
      // A real store leaves a failed verification request at verification_requested; it only
      // becomes done after a passing gate.
      items: { one: 'verification_requested' },
      gates: [{ item: 'one', ok: false, head: 'h' }],
      head: 'h'
    }),
    replayRow(3, { items: { one: 'verification_requested' }, gates: [], head: 'h' }),
    replayRow(4, { items: { one: 'open' }, gates: [], head: 'h' })
  ])
  assert.deepEqual(
    run.steps.map((step) => step.claimsDone),
    [true, true, true, undefined]
  )
  assert.deepEqual(
    run.steps.map((step) => step.acceptancePassed),
    [true, false, null, undefined]
  )
})

test('a real RelayStore verification_requested claim replays as premature_done', async () => {
  const f = fixture()
  try {
    const store = new JudgeJournalStore(f.db, { scrubber: f.scrubber, clock: f.relay.clock })
    const cascade = new RelayJudgeCascade(f.relay, cascadeInput({ journal: store }))
    f.relay.begin(f.attempt)
    f.relay.requestVerification(f.attempt, 'one')
    f.relay.observe(f.attempt, {
      head: 'b'.repeat(40),
      files: [],
      diffstat: '',
      evidence: { item: 'one', ok: false, output: 'fixture gate failed' }
    })
    cascade.bind(f.attempt)
    const observation = observationAt(1_000_000, { cycle: 1 })
    await cascade.sample(f.attempt, 'cycle_start', new AbortController().signal, undefined, {
      observation,
      policy,
      signals: evaluateJudgeSignals(observation, policy)
    })
    f.db.prepare("UPDATE durable_runs SET state='completed' WHERE id=?").run(f.run.id)

    const rows = store.readRun(f.run.id)
    assert.equal(rows.length, 1)
    const packet = JSON.parse(rows[0]!.packet) as {
      items: Record<string, string>
      gates: { item: string; ok: boolean; head: string }[]
      head: string
    }
    assert.equal(packet.items.one, 'verification_requested')
    assert.equal(packet.gates.at(-1)!.ok, false)
    assert.equal(packet.gates.at(-1)!.head, packet.head)

    const run = readJournalReplay(store, f.run.id)
    assert.equal(run.steps.length, 1)
    assert.equal(run.steps[0]!.claimsDone, true)
    assert.equal(run.steps[0]!.acceptancePassed, false)
    const scored = score({
      version: 1,
      runs: [{ ...run, labels: [{ fault: 'premature_done', firstStep: 0 }] }]
    })
    assert.equal(scored.classes.premature_done.tp, 1)
    assert.equal(scored.classes.premature_done.fn, 0)
  } finally {
    f.close()
  }
})

test('journal replay accepts equal observedAt values from a same-millisecond collector', () => {
  const first = replayRow(1, { items: { one: 'open' }, gates: [], head: 'h' })
  const second = replayRow(2, { items: { one: 'open' }, gates: [], head: 'h' })
  const same = {
    ...second,
    observation: first.observation,
    signals: first.signals,
    started_at: first.started_at,
    finished_at: first.finished_at
  }
  const run = journalReplayRun([first, same])
  assert.equal(run.steps.length, 2)
  assert.deepEqual(
    run.steps.map((step) => step.observation.observedAt),
    [1_001_000, 1_001_000]
  )
})

test('a recovery attempt keeps its own replay steps and is not stitched into attempt 1', () => {
  const row = (
    id: number,
    attemptId: string,
    attemptOrdinal: number,
    phase: 'cycle_start' | 'pre_seal',
    observedAt: number,
    items: Record<string, string>
  ): JudgeJournalRow => {
    const observation = observationAt(observedAt)
    return {
      ...replayRow(1, { items, gates: [], head: 'h' }),
      id,
      attempt_id: attemptId,
      attempt_ordinal: attemptOrdinal,
      phase,
      request_key: `${attemptId}-${phase}`,
      observation: canonical(observation),
      signals: canonical(evaluateJudgeSignals(observation, policy)),
      started_at: observedAt,
      finished_at: observedAt,
      expires_at: observedAt + 1_000_000
    }
  }
  const rows = [
    row(4, 'attempt-2', 2, 'pre_seal', 4_000, { one: 'verification_requested' }),
    row(2, 'attempt-1', 1, 'pre_seal', 2_000, { one: 'open' }),
    row(3, 'attempt-2', 2, 'cycle_start', 3_000, { one: 'verification_requested' }),
    row(1, 'attempt-1', 1, 'cycle_start', 1_000, { one: 'open' })
  ]
  const run = journalReplayRun(rows)
  assert.equal(run.steps.length, 4, 'both attempts and both boundaries survive')
  assert.deepEqual(
    run.steps.map((step) => step.observation.observedAt),
    [1_000, 2_000, 3_000, 4_000],
    'attempt 1 completes before attempt 2 begins; no cross-attempt boundary is stitched'
  )
  assert.deepEqual(
    run.steps.map((step) => step.claimsDone),
    [undefined, undefined, true, true],
    'claims stay with the attempt that produced them'
  )
})

test('readRun orders journal rows by attempt ordinal before cycle and phase', () => {
  const f = fixture()
  try {
    const store = new JudgeJournalStore(f.db, { scrubber: f.scrubber, clock: f.relay.clock })
    f.db
      .prepare(
        "INSERT INTO run_attempts(id,run_id,ordinal,state,epoch,token) VALUES('attempt-2',?,2,'completed',1,1)"
      )
      .run(f.run.id)
    const now = f.relay.clock()
    const first = {
      ...journalEntry(f.run.id, f.run.session_id, 'attempt-1-start', now + 100),
      attemptId: f.attempt.id,
      startedAt: now + 100,
      finishedAt: now + 100
    }
    const second = {
      ...journalEntry(f.run.id, f.run.session_id, 'attempt-2-start', now + 50),
      attemptId: 'attempt-2',
      startedAt: now + 50,
      finishedAt: now + 50
    }
    store.record(second)
    store.record(first)
    f.db.prepare("UPDATE durable_runs SET state='completed' WHERE id=?").run(f.run.id)
    const rows = store.readRun(f.run.id)
    assert.deepEqual(
      rows.map((item) => item.attempt_id),
      [f.attempt.id, 'attempt-2'],
      'attempt ordinal wins over the attempt-2 row having an earlier timestamp'
    )
    assert.deepEqual(
      rows.map((item) => item.attempt_ordinal),
      [1, 2]
    )
  } finally {
    f.close()
  }
})

test('the plugin executor default journals a public-start execution', async () => {
  const f = fixture()
  try {
    await executeThroughPlugin(f)
    assert.equal(
      f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='relay_judge_journal'").get() !==
        undefined,
      true
    )
    const rows = f.db
      .prepare('SELECT state, phase FROM relay_judge_journal WHERE run_id=? ORDER BY id')
      .all(f.run.id) as { state: string; phase: string }[]
    assert.equal(rows.length >= 2, true, 'the executor default created a journal without injection')
    assert.equal(rows.every((row) => row.state === 'completed'), true)
    assert.deepEqual(new Set(rows.map((row) => row.phase)), new Set(['cycle_start', 'pre_seal']))
    assert.equal(
      f.db.prepare("SELECT state FROM durable_runs WHERE id=?").get(f.run.id)!.state,
      'completed'
    )
  } finally {
    f.close()
  }
})

test('a foreign journal migration value disables the sidecar without failing the judged relay', async () => {
  const f = fixture()
  try {
    f.db.exec(
      'CREATE TABLE relay_journal_migrations(version INTEGER PRIMARY KEY); INSERT INTO relay_journal_migrations VALUES(99)'
    )
    await executeThroughPlugin(f)
    assert.equal(
      f.db.prepare("SELECT state FROM durable_runs WHERE id=?").get(f.run.id)!.state,
      'completed'
    )
    assert.equal(
      f.db.prepare("SELECT state FROM relay_judge_requests WHERE run_id=? AND layer='J2'").get(f.run.id)!
        .state,
      'completed',
      'the fenced verdict is unchanged'
    )
    assert.equal(
      f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='relay_judge_journal'").get(),
      undefined,
      'construction never reached the table DDL'
    )
    assert.equal(
      f.db.prepare('SELECT version FROM relay_journal_migrations').get()!.version,
      99,
      'the foreign ledger is left untouched'
    )
  } finally {
    f.close()
  }
})

test('unobserved judge facts are stored in the row and carried as unknown replay evidence', async () => {
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
        unobserved: ['failureStreak'],
        collect: async () => {
          const observation = observationAt(clock)
          clock += 1_000
          return observation
        }
      },
      cascadeInput()
    )
    await executor.run(f.attempt)
    const store = new JudgeJournalStore(f.db, { scrubber: f.scrubber, clock: () => clock })
    const rows = store.readRun(f.run.id)
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((row) => JSON.parse(row.unknown_facts)), [
      ['failureStreak'],
      ['failureStreak']
    ])
    assert.deepEqual(rows.map((row) => JSON.parse(row.unobserved)), [
      ['failureStreak'],
      ['failureStreak']
    ])
    const replay = readJournalReplay(store, f.run.id)
    assert.equal(
      replay.steps.every((step) => step.unknownFacts?.includes('failureStreak') === true),
      true,
      'the reader carries the marker instead of replaying the zero streak as healthy'
    )
    const scored = score({ version: 1, runs: [replay] })
    assert.equal(scored.classes.loop.unknown >= 1, true)
  } finally {
    f.close()
  }
})

test('plugin injection defaults to the journal, preserves explicit/null and is lazy without a cascade', () => {
  const injected = { record() {} }
  assert.equal(
    cascadeWithJournal(undefined, () => {
      throw new Error('must not construct a journal without a cascade')
    }),
    undefined
  )
  assert.equal(cascadeWithJournal(cascadeInput(), () => injected)!.journal, injected)
  assert.equal(
    cascadeWithJournal({ ...cascadeInput(), journal: null }, () => {
      throw new Error('must not replace an explicit null')
    })!.journal,
    null
  )
  assert.equal(
    cascadeWithJournal({ ...cascadeInput(), journal: injected }, () => {
      throw new Error('must not replace an explicit journal')
    })!.journal,
    injected
  )
})

test('unavailable, invalid and abandoned evaluations are journaled with fixed result codes', async () => {
  const row = (f: ReturnType<typeof fixture>) =>
    f.db
      .prepare("SELECT state,result FROM relay_judge_journal WHERE layer='J2'")
      .get()! as { state: string; result: string }

  const unavailable = fixture()
  try {
    const store = new JudgeJournalStore(unavailable.db, {
      scrubber: unavailable.scrubber,
      clock: unavailable.relay.clock
    })
    const cascade = new RelayJudgeCascade(
      unavailable.relay,
      cascadeInput({
        journal: store,
        model: { admit: async () => false, sample: async () => validResult() }
      })
    )
    unavailable.relay.begin(unavailable.attempt)
    cascade.bind(unavailable.attempt)
    await cascade.sample(unavailable.attempt, 'cycle_start', new AbortController().signal)
    assert.equal(row(unavailable).state, 'unavailable')
    assert.match(row(unavailable).result, /judge_model_unavailable/)
  } finally {
    unavailable.close()
  }

  const invalid = fixture()
  try {
    const store = new JudgeJournalStore(invalid.db, {
      scrubber: invalid.scrubber,
      clock: invalid.relay.clock
    })
    const cascade = new RelayJudgeCascade(
      invalid.relay,
      cascadeInput({
        journal: store,
        model: { admit: async () => true, sample: async () => '{}' }
      })
    )
    invalid.relay.begin(invalid.attempt)
    cascade.bind(invalid.attempt)
    await cascade.sample(invalid.attempt, 'cycle_start', new AbortController().signal)
    assert.equal(row(invalid).state, 'invalid')
    assert.match(row(invalid).result, /judge_invalid_output/)
  } finally {
    invalid.close()
  }

  const abandoned = fixture()
  try {
    const store = new JudgeJournalStore(abandoned.db, {
      scrubber: abandoned.scrubber,
      clock: abandoned.relay.clock
    })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const abort = new AbortController()
    const cascade = new RelayJudgeCascade(
      abandoned.relay,
      cascadeInput({
        journal: store,
        model: {
          admit: async () => true,
          sample: async () => {
            entered()
            await blocked
            return validResult()
          }
        }
      })
    )
    abandoned.relay.begin(abandoned.attempt)
    cascade.bind(abandoned.attempt)
    const pending = cascade.sample(abandoned.attempt, 'cycle_start', abort.signal)
    await started
    abort.abort()
    release()
    await assert.rejects(pending)
    assert.equal(row(abandoned).state, 'abandoned')
    assert.match(row(abandoned).result, /canceled/)
  } finally {
    abandoned.close()
  }
})

test('an asynchronous journal rejection is contained like a synchronous failure', async () => {
  const f = fixture()
  try {
    const cascade = new RelayJudgeCascade(
      f.relay,
      cascadeInput({
        journal: {
          record: async () => {
            throw new Error('local journal unavailable')
          }
        }
      })
    )
    cascade.bind(f.attempt)
    await cascade.sample(f.attempt, 'cycle_start', new AbortController().signal)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(
      f.db.prepare("SELECT state FROM relay_judge_requests WHERE layer='J2'").get()!.state,
      'completed'
    )
  } finally {
    f.close()
  }
})

test('an existing journal table is found and purged without a cascade; identity secrets are refused', () => {
  const f = fixture()
  try {
    assert.equal(journalIfPresent(f.db, f.scrubber), null)
    const now = f.relay.clock()
    const store = new JudgeJournalStore(f.db, {
      scrubber: f.scrubber,
      clock: () => now,
      retentionMs: 1
    })
    const run = f.store.create()
    store.record(journalEntry(run.id, run.session_id, 'existing', now))
    const found = journalIfPresent(f.db, f.scrubber)
    assert.ok(found)
    assert.equal(found!.purgeExpired(now + 2), 1)

    const secret = 'r3-identity-secret-0b8f2a'
    f.scrubber.register('secret://fixture/r3-identity', secret)
    const identity = journalEntry(run.id, run.session_id, 'identity', now)
    identity.attemptId = `attempt-${secret}`
    assert.throws(() => store.record(identity), /identity contains a registered secret/)
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM relay_judge_journal WHERE request_key='identity'").get()!.n,
      0
    )

    const lateRun = f.store.create()
    const lateId = 'late-identity-77ab10'
    const late = journalEntry(lateRun.id, lateRun.session_id, 'late-identity', now)
    late.attemptId = lateId
    store.record(late)
    f.db.prepare("UPDATE durable_runs SET state='completed' WHERE id=?").run(lateRun.id)
    f.scrubber.register('secret://fixture/r3-late-identity', lateId)
    assert.throws(() => store.readRun(lateRun.id, now), /stored identity contains a registered secret/)
  } finally {
    f.close()
  }
})
