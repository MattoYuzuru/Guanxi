import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RelayJudgeSummary, RelayJudgeInput } from '../../src/relay/judge-host.ts'
import { RelayExecutor } from '../../src/relay/executor.ts'
import { RelayStore } from '../../src/relay/store.ts'
import { JudgeStore } from '../../src/relay/judge-store.ts'
import { RelayJudgeCascade, type RelayCascadeInput } from '../../src/relay/judge-cascade.ts'
import {
  copyBrief,
  nightKey,
  selectJudgeRole,
  type RelayDelegationBrief,
  type JudgeRole
} from '../../src/relay/delegation-brief.ts'
import { canonical, hash, byteHash } from '../../src/relay/handoff.ts'
import { DEFAULT_RELAY_LIMITS } from '../../src/relay/types.ts'
import { fixture, plan, reserves, caps } from './fixture.ts'

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
const valid = () =>
  canonical({
    taxonomy: 'progress',
    verdict: 'consistent',
    evidenceRefs: ['plan'],
    diagnosisHint: 'Evidence agrees.'
  })
function input(b = brief(), overrides: Partial<RelayCascadeInput> = {}): RelayCascadeInput {
  return { brief: b, model: { admit: async () => true, sample: async () => valid() }, ...overrides }
}
function begin(f: ReturnType<typeof fixture>) {
  f.relay.begin(f.attempt)
}
function deferred<T = void>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
async function bounded(p: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('did not settle')), 1000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('off preserves execution with no independent38 tables or judge calls', async () => {
  const f = fixture()
  try {
    await f.executor.run(f.attempt)
    assert.equal(f.relay.read(f.run.id).state, 'finish')
    assert.equal(
      f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='relay_briefs'").get(),
      undefined
    )
  } finally {
    f.close()
  }
})
test('brief exact plan/caps replay is idempotent, detached and changed admission rolls back', () => {
  const f = fixture()
  try {
    const store = new JudgeStore(f.relay),
      b = brief(),
      version = f.db.prepare('PRAGMA user_version').get()
    const copy = store.bind(f.attempt, b)
    b.objective = 'changed'
    assert.notEqual(copy.objective, b.objective)
    assert.deepEqual(store.bind(f.attempt, copy), copy)
    assert.throws(() => store.bind(f.attempt, b), /brief_conflict/)
    const wrong = brief()
    wrong.plan.revision = 'other'
    assert.throws(() => store.bind(f.attempt, wrong), /brief_plan_conflict/)
    const over = brief()
    over.caps.cycles = 100
    assert.throws(() => store.bind(f.attempt, over), /brief_caps_conflict/)
    assert.deepEqual(f.db.prepare('PRAGMA user_version').get(), version)
    assert.deepEqual(
      f.db
        .prepare('SELECT version FROM relay_judge_migrations')
        .all()
        .map((r) => r.version),
      [38]
    )
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_briefs').get()!.n, 1)
    assert.throws(
      () => f.db.prepare("UPDATE relay_briefs SET digest='changed'").run(),
      /append only/
    )
  } finally {
    f.close()
  }
})
test('selector precedence hard filters and absent/future/stale calibration never invent eligibility', () => {
  const candidate = (model: string) => ({
    role: { ...role, model },
    installedLocal: true,
    unattended: true,
    calibration: null,
    cost: 1
  })
  const session = candidate('session'),
    project = candidate('project'),
    automatic = candidate('auto')
  const base = { session, project, policy: [automatic], threshold: 0.8, now: 100, maxAgeMs: 10 }
  assert.equal(selectJudgeRole(base).model, 'session')
  assert.equal(selectJudgeRole({ ...base, session: undefined }).model, 'project')
  assert.throws(
    () => selectJudgeRole({ ...base, session: { ...session, installedLocal: false } }),
    /selection_unavailable/
  )
  assert.throws(
    () => selectJudgeRole({ ...base, session: undefined, project: undefined }),
    /selection_unavailable/
  )
  for (const observedAt of [89, 101])
    assert.throws(
      () =>
        selectJudgeRole({
          ...base,
          session: undefined,
          project: undefined,
          policy: [
            {
              ...automatic,
              calibration: {
                probability: 0.9,
                confidence: 'validated',
                source: 'actual-labelled-trials',
                observedAt
              }
            }
          ]
        }),
      /selection_unavailable/
    )
  assert.equal(
    selectJudgeRole({
      ...base,
      session: undefined,
      project: undefined,
      policy: [
        {
          ...automatic,
          calibration: {
            probability: 0.9,
            confidence: 'validated',
            source: 'actual-labelled-trials',
            observedAt: 95
          }
        }
      ]
    }).model,
    'auto'
  )
})
test('actual executor boundaries create fresh samples, stable sealed refs and requested wake only', async () => {
  const f = fixture(),
    seen: string[] = []
  try {
    const configured = input(brief(), {
      model: {
        admit: async () => true,
        sample: async (i) => {
          seen.push(i.prompt)
          return valid()
        }
      }
    })
    const executor = new RelayExecutor(
      f.relay,
      f.model,
      f.workspace,
      reserves,
      f.scrubber,
      DEFAULT_RELAY_LIMITS,
      undefined,
      undefined,
      configured
    )
    await executor.run(f.attempt)
    assert.equal(seen.length, 4)
    assert.equal(
      seen.every((p) => !p.includes('assistant:')),
      true
    )
    const rows = f.db
      .prepare('SELECT phase,state FROM relay_judge_requests ORDER BY created_at,key')
      .all()
    assert.equal(rows.length, 2)
    assert.equal(
      rows.every((r) => r.state === 'completed'),
      true
    )
    assert.deepEqual(new Set(rows.map((r) => r.phase)), new Set(['cycle_start', 'pre_seal']))
    const sealed = f.relay.sealed(f.attempt)!
    assert.equal(hash(sealed.ledger), sealed.handoff.ledgerHash)
    assert.equal(sealed.ledger.judge!.briefHash, hash(configured.brief))
    assert.equal(sealed.ledger.judge!.requests.length, 2)
    assert.equal(sealed.ledger.judge!.requestedWake, 'defer_completion_until_08')
    assert.equal(f.store.get(f.run.id).state, 'completed') // existing immediate R1 completion is not changed
  } finally {
    f.close()
  }
})
test('concurrent exact request shares calls, debit once and strict payload replay conflict refuses', async () => {
  const f = fixture()
  try {
    begin(f)
    let calls = 0
    const entered = deferred(),
      release = deferred()
    const cascade = new RelayJudgeCascade(
      f.relay,
      input(brief(), {
        model: {
          admit: async () => true,
          sample: async () => {
            calls++
            entered.resolve()
            await release.promise
            return valid()
          }
        }
      })
    )
    cascade.bind(f.attempt)
    const first = cascade.sample(f.attempt, 'cycle_start', new AbortController().signal)
    await entered.promise
    const second = cascade.sample(f.attempt, 'cycle_start', new AbortController().signal)
    release.resolve()
    await Promise.all([first, second])
    assert.equal(calls, 2)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_judge_requests').get()!.n, 1)
    assert.equal(f.relay.read(f.run.id).tokens, 26000)
    f.relay.propose(f.attempt, 'new claim')
    await assert.rejects(
      cascade.sample(f.attempt, 'cycle_start', new AbortController().signal),
      /judge_request_conflict/
    )
    assert.equal(calls, 2)
  } finally {
    f.close()
  }
})
test('disagreement and strict invalid references/schema are recorded without passing failed gates', async () => {
  const f = fixture()
  try {
    begin(f)
    f.relay.requestVerification(f.attempt, 'one')
    f.relay.observe(f.attempt, {
      head: plan.base,
      files: [],
      diffstat: '',
      evidence: { item: 'one', ok: false, output: 'failed' }
    })
    let calls = 0
    const c = new RelayJudgeCascade(
      f.relay,
      input(brief(), {
        model: {
          admit: async () => true,
          sample: async () =>
            canonical({
              taxonomy: ++calls === 1 ? 'progress' : 'stuck',
              verdict: 'consistent',
              evidenceRefs: ['plan'],
              diagnosisHint: 'diagnosis'
            })
        }
      })
    )
    c.bind(f.attempt)
    await c.sample(f.attempt, 'cycle_start', new AbortController().signal)
    const row = f.db.prepare('SELECT payload FROM relay_judge_requests').get()!
    assert.equal(JSON.parse(String(row.payload)).agreement, false)
    assert.equal(f.relay.read(f.run.id).items.one, 'verification_requested')
    for (const text of [
      canonical({
        taxonomy: 'progress',
        verdict: 'consistent',
        evidenceRefs: ['forged'],
        diagnosisHint: 'x'
      }),
      canonical({
        taxonomy: 'progress',
        verdict: 'consistent',
        evidenceRefs: ['plan'],
        diagnosisHint: 'x',
        action: 'run'
      })
    ]) {
      const g = fixture()
      try {
        begin(g)
        const bad = new RelayJudgeCascade(
          g.relay,
          input(brief(), { model: { admit: async () => true, sample: async () => text } })
        )
        bad.bind(g.attempt)
        await bad.sample(g.attempt, 'cycle_start', new AbortController().signal)
        assert.equal(g.db.prepare('SELECT state FROM relay_judge_requests').get()!.state, 'invalid')
      } finally {
        g.close()
      }
    }
  } finally {
    f.close()
  }
})
test('checker executes verified immutable bytes only, rejects pin changes before actual commands', async () => {
  for (const mismatch of [false, true]) {
    const f = fixture()
    try {
      begin(f)
      const b = brief(),
        bytes = Buffer.from('lead-owned-checker')
      b.judges.checker = {
        base: plan.base,
        path: 'checks/lead',
        digest: byteHash(bytes),
        timeoutMs: 100,
        outputBytes: 4096
      }
      let runs = 0
      const c = new RelayJudgeCascade(
        f.relay,
        input(b, {
          checker: {
            read: async () => ({
              base: plan.base,
              path: 'checks/lead',
              bytes: mismatch ? Buffer.from('executor-modified') : bytes
            }),
            run: async (i) => {
              runs++
              assert.equal(byteHash(i.bytes), b.judges.checker!.digest)
              return valid()
            }
          }
        })
      )
      c.bind(f.attempt)
      await c.sample(f.attempt, 'cycle_start', new AbortController().signal)
      assert.equal(runs, mismatch ? 0 : 1)
      assert.equal(
        f.db.prepare("SELECT state FROM relay_judge_requests WHERE layer='J1.5'").get()!.state,
        mismatch ? 'unavailable' : 'completed'
      )
    } finally {
      f.close()
    }
  }
})
test('checker timeout aborts but retains ownership until actual supervisor settlement acknowledgment', async () => {
  const f = fixture()
  try {
    begin(f)
    const b = brief(),
      bytes = Buffer.from('lead-owned')
    b.judges.checker = {
      base: plan.base,
      path: 'checker',
      digest: byteHash(bytes),
      timeoutMs: 10,
      outputBytes: 4096
    }
    const aborted = deferred(),
      cleanup = deferred()
    let settled = false
    const c = new RelayJudgeCascade(
      f.relay,
      input(b, {
        checker: {
          read: async () => ({ base: plan.base, path: 'checker', bytes }),
          run: async (i) => {
            i.signal.addEventListener('abort', () => aborted.resolve(), { once: true })
            await cleanup.promise
            return valid()
          }
        }
      })
    )
    c.bind(f.attempt)
    const pending = c.sample(f.attempt, 'cycle_start', new AbortController().signal).finally(() => {
      settled = true
    })
    await bounded(aborted.promise)
    assert.equal(settled, false)
    cleanup.resolve()
    await pending
    const row = f.db
      .prepare("SELECT state,payload FROM relay_judge_requests WHERE layer='J1.5'")
      .get()!
    assert.equal(row.state, 'unavailable')
    assert.match(String(row.payload), /judge_checker_timeout/)
  } finally {
    f.close()
  }
})
test('pure pending admission cancellation settles before callback and consumes late rejection', async () => {
  const f = fixture()
  try {
    begin(f)
    const entered = deferred(),
      gate = deferred<boolean>(),
      abort = new AbortController()
    let posts = 0
    const c = new RelayJudgeCascade(
      f.relay,
      input(brief(), {
        model: {
          admit: async () => {
            entered.resolve()
            return gate.promise
          },
          sample: async () => {
            posts++
            return valid()
          }
        }
      })
    )
    c.bind(f.attempt)
    const pending = c.sample(f.attempt, 'cycle_start', abort.signal)
    await entered.promise
    abort.abort()
    await bounded(assert.rejects(pending))
    const before = canonical(f.db.prepare('SELECT * FROM relay_judge_requests').all())
    gate.reject(new Error('late fixture'))
    await new Promise((r) => setImmediate(r))
    assert.equal(posts, 0)
    assert.equal(canonical(f.db.prepare('SELECT * FROM relay_judge_requests').all()), before)
  } finally {
    f.close()
  }
})
test('active inference cancellation waits for actual transport settlement and never writes late outcome', async () => {
  const f = fixture()
  try {
    begin(f)
    const entered = deferred(),
      cleanup = deferred(),
      abort = new AbortController()
    let settled = false
    const c = new RelayJudgeCascade(
      f.relay,
      input(brief(), {
        model: {
          admit: async () => true,
          sample: async () => {
            entered.resolve()
            await cleanup.promise
            return valid()
          }
        }
      })
    )
    c.bind(f.attempt)
    const p = c.sample(f.attempt, 'cycle_start', abort.signal)
    p.catch(() => {}).finally(() => {
      settled = true
    })
    await entered.promise
    abort.abort()
    await new Promise((r) => setImmediate(r))
    assert.equal(settled, false)
    cleanup.resolve()
    await assert.rejects(p)
    assert.equal(f.db.prepare('SELECT state FROM relay_judge_requests').get()!.state, 'abandoned')
  } finally {
    f.close()
  }
})
test('revoked fence during admission refuses dispatch and late outcome cannot update request', async () => {
  const f = fixture()
  try {
    begin(f)
    const entered = deferred(),
      gate = deferred<boolean>()
    let posts = 0
    const c = new RelayJudgeCascade(
      f.relay,
      input(brief(), {
        model: {
          admit: async () => {
            entered.resolve()
            return gate.promise
          },
          sample: async () => {
            posts++
            return valid()
          }
        }
      })
    )
    c.bind(f.attempt)
    const p = c.sample(f.attempt, 'cycle_start', new AbortController().signal)
    await entered.promise
    f.store.cancel(f.run.id)
    gate.resolve(true)
    await assert.rejects(p)
    assert.equal(posts, 0)
    assert.equal(f.db.prepare('SELECT state FROM relay_judge_requests').get()!.state, 'prepared')
  } finally {
    f.close()
  }
})
test('availability counts cycles once, resets on valid result, third unavailable emits one parent escalation', async () => {
  const f = fixture()
  try {
    const promise = f.store.delegate(f.attempt, { key: 'cascade-child', deadline: 1800003600000 })
    const a = f.store.start(promise.child_id)
    f.relay.init(a, plan, caps)
    const c = new RelayJudgeCascade(
      f.relay,
      input(brief(), {
        model: {
          admit: async () => false,
          sample: async () => {
            throw new Error('no dispatch')
          }
        }
      })
    )
    c.bind(a)
    for (let cycle = 1; cycle <= 3; cycle++) {
      if (cycle === 1) f.relay.begin(a)
      else
        f.relay.change(a, 'fixture_next_cycle', (l) => {
          l.cycle = cycle
          l.state = 'orient'
        })
      await c.sample(a, 'cycle_start', new AbortController().signal)
      await c.sample(a, 'pre_seal', new AbortController().signal)
      assert.equal(c.store.unavailableStreak(a, cycle), cycle)
    }
    await c.sample(a, 'pre_seal', new AbortController().signal)
    assert.equal(
      f.db
        .prepare("SELECT count(*) AS n FROM outbox WHERE run_id=? AND kind='escalation'")
        .get(f.run.id)!.n,
      1
    )
    c.store.availability(a, 3, true)
    assert.equal(c.store.unavailableStreak(a, 3), 0)
  } finally {
    f.close()
  }
})
test('J3 consumes across runs/account/night before dispatch, duplicate and error never refund', async () => {
  const f = fixture()
  try {
    const b = brief()
    b.judges.j3.enabled = true
    begin(f)
    let calls = 0
    const c = new RelayJudgeCascade(
      f.relay,
      input(b, {
        model: {
          admit: async () => true,
          sample: async () => {
            calls++
            throw new Error('fixture failure')
          }
        }
      })
    )
    c.bind(f.attempt)
    const signal = new AbortController().signal
    for (const reason of ['flagged', 'final', 'probes'] as const)
      await c.review(f.attempt, reason, signal)
    await c.review(f.attempt, 'final', signal)
    assert.equal(calls, 3)
    const run = f.store.create(),
      a = f.store.start(run.id)
    f.relay.init(a, plan, caps)
    f.relay.begin(a)
    const other = new RelayJudgeCascade(
      f.relay,
      input(b, {
        model: {
          admit: async () => true,
          sample: async () => {
            calls++
            return valid()
          }
        }
      })
    )
    other.bind(a)
    const result = await other.review(a, 'final', signal)
    assert.equal(result!.state, 'unavailable')
    assert.match(canonical(result!.payload), /judge_budget_exhausted/)
    assert.equal(calls, 3)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_judge_debits').get()!.n, 3)
    assert.equal(f.relay.read(run.id).tokens, 0) // failed reservation rolled back atomically
    assert.throws(() => f.db.prepare('DELETE FROM relay_judge_debits').run(), /append only/)
  } finally {
    f.close()
  }
})
test('night identities survive DST and rollover, override and account timezone anchor are explicit', () => {
  const b = brief()
  assert.equal(
    nightKey(b.wake, Date.parse('2026-11-01T05:30:00Z')),
    nightKey(b.wake, Date.parse('2026-11-01T06:30:00Z'))
  )
  assert.notEqual(
    nightKey(b.wake, Date.parse('2026-10-23T00:00:00Z')),
    nightKey(b.wake, Date.parse('2026-10-24T00:00:00Z'))
  )
  b.judges.j3.maxCallsPerNight = 4
  assert.throws(() => copyBrief(b, plan))
  b.judges.j3.override = { id: 'owner-policy', reason: 'explicit fixture override' }
  assert.equal(copyBrief(b, plan).judges.j3.maxCallsPerNight, 4)
  const f = fixture()
  try {
    const s = new JudgeStore(f.relay)
    s.bind(f.attempt, brief())
    const run = f.store.create(),
      a = f.store.start(run.id)
    f.relay.init(a, plan, caps)
    b.wake.timeZone = 'UTC'
    assert.throws(() => s.bind(a, b), /brief_account_night_conflict/)
  } finally {
    f.close()
  }
})
test('prepared/dispatched recovery never replays or refunds and lost attempts are abandoned', async () => {
  const f = fixture()
  try {
    begin(f)
    const s = new JudgeStore(f.relay),
      b = s.bind(f.attempt, brief()),
      id = { cycle: 1, phase: 'cycle_start', layer: 'J2' as const, reason: 'scheduled' }
    const r = s.prepare(f.attempt, b, id, { fixture: 'one' })
    s.dispatch(f.attempt, b, r, id)
    assert.equal(s.prepare(f.attempt, b, id, { fixture: 'one' }).fresh, false)
    f.store.cancel(f.run.id)
    new JudgeStore(f.relay)
    assert.equal(f.db.prepare('SELECT state FROM relay_judge_requests').get()!.state, 'abandoned')
    assert.equal(f.relay.read(f.run.id).tokens, 26000)
  } finally {
    f.close()
  }
})

test('three-sample configuration uses fresh independent prompts and no caller mutation changes its admitted brief', async () => {
  const f = fixture()
  try {
    begin(f)
    const b = brief()
    b.judges.samples = 3
    let calls = 0
    const mutable = input(b, {
      model: {
        admit: async (i) => {
          assert.equal(Object.isFrozen(i.role), true)
          assert.throws(() => {
            i.role.model = 'mutated'
          })
          return true
        },
        sample: async () => {
          calls++
          return valid()
        }
      }
    })
    const c = new RelayJudgeCascade(f.relay, mutable)
    b.objective = 'caller changed'
    mutable.model.sample = async () => {
      throw new Error('replaced function')
    }
    c.bind(f.attempt)
    await c.sample(f.attempt, 'cycle_start', new AbortController().signal)
    assert.equal(calls, 3)
    assert.equal(f.relay.read(f.run.id).tokens, 39000)
    assert.equal(
      JSON.parse(String(f.db.prepare('SELECT payload FROM relay_briefs').get()!.payload)).objective,
      plan.goal
    )
  } finally {
    f.close()
  }
})
test('wall expiry while pure admission is pending makes zero model calls and abandons the request', async () => {
  const f = fixture({ caps: { wallMs: 10 } })
  try {
    let now = 1800000000000
    const relay = new RelayStore(f.db, f.store, f.scrubber, () => now)
    const b = brief()
    b.caps.wallMs = 10
    const entered = deferred(),
      late = deferred<boolean>()
    let calls = 0
    const c = input(b, {
      model: {
        admit: async () => {
          entered.resolve()
          return late.promise
        },
        sample: async () => {
          calls++
          return valid()
        }
      }
    })
    const executor = new RelayExecutor(
      relay,
      f.model,
      f.workspace,
      reserves,
      f.scrubber,
      DEFAULT_RELAY_LIMITS,
      undefined,
      undefined,
      c
    )
    const pending = executor.run(f.attempt)
    await entered.promise
    now = 1800000000020
    f.setTime(now)
    // Existing wall timer rechecks the host clock. It may need its next bounded tick.
    await bounded(pending)
    late.resolve(true)
    await new Promise((r) => setImmediate(r))
    assert.equal(calls, 0)
    assert.equal(f.store.get(f.run.id).state, 'wrapping_up')
    assert.equal(f.db.prepare('SELECT state FROM relay_judge_requests').get()!.state, 'abandoned')
  } finally {
    f.close()
  }
})
test('a newer cycle or revoked home refuses a late verdict without updating snapshot or waking parent', async () => {
  for (const revoke of ['cycle', 'home'] as const) {
    const f = fixture()
    try {
      begin(f)
      const entered = deferred(),
        late = deferred<string>()
      const c = new RelayJudgeCascade(
        f.relay,
        input(brief(), {
          model: {
            admit: async () => true,
            sample: async () => {
              entered.resolve()
              return late.promise
            }
          }
        })
      )
      c.bind(f.attempt)
      const p = c.sample(f.attempt, 'cycle_start', new AbortController().signal)
      await entered.promise
      if (revoke === 'cycle')
        f.relay.change(f.attempt, 'fixture_new_cycle', (l) => {
          l.cycle = 2
        })
      else f.db.prepare("UPDATE leases SET token=token+1 WHERE key='durable-runs/home'").run()
      const snapshot = canonical(f.db.prepare('SELECT snapshot FROM relay_runs').all()),
        wakes = f.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n
      late.resolve(valid())
      await assert.rejects(p)
      assert.equal(canonical(f.db.prepare('SELECT snapshot FROM relay_runs').all()), snapshot)
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n, wakes)
      assert.equal(
        f.db.prepare('SELECT state FROM relay_judge_requests').get()!.state,
        'dispatched'
      )
    } finally {
      f.close()
    }
  }
})

test('real durable account/night debit rollover and explicit override admit only the named additional review', async () => {
  const f = fixture()
  try {
    begin(f)
    const b = brief()
    b.judges.j3.enabled = true
    let calls = 0
    const model = {
      admit: async () => true,
      sample: async () => {
        calls++
        return valid()
      }
    }
    const c = new RelayJudgeCascade(f.relay, input(b, { model }))
    c.bind(f.attempt)
    const signal = new AbortController().signal
    for (const reason of ['flagged', 'final', 'probes'] as const)
      await c.review(f.attempt, reason, signal)
    const run = f.store.create(),
      a = f.store.start(run.id)
    f.relay.init(a, plan, caps)
    f.relay.begin(a)
    const override = brief()
    override.judges.j3 = {
      ...b.judges.j3,
      maxCallsPerNight: 4,
      override: { id: 'explicit-fourth', reason: 'fixture owner policy' }
    }
    const extra = new RelayJudgeCascade(f.relay, input(override, { model }))
    extra.bind(a)
    assert.equal((await extra.review(a, 'final', signal))!.state, 'completed')
    assert.equal(calls, 4)
    assert.equal(
      f.db
        .prepare('SELECT override_id FROM relay_judge_debits WHERE override_id IS NOT NULL')
        .get()!.override_id,
      'explicit-fourth'
    )
    const next = 1800000000000 + 86400000
    f.setTime(next)
    f.store.heartbeat()
    const relay = new RelayStore(f.db, f.store, f.scrubber, () => next),
      newRun = f.store.create(),
      newAttempt = f.store.start(newRun.id)
    relay.init(newAttempt, plan, caps)
    relay.begin(newAttempt)
    const nextNight = new RelayJudgeCascade(relay, input(b, { model }))
    nextNight.bind(newAttempt)
    assert.equal((await nextNight.review(newAttempt, 'final', signal))!.state, 'completed')
    assert.equal(calls, 5)
    assert.deepEqual(
      f.db
        .prepare('SELECT count(*) AS n FROM relay_judge_debits GROUP BY night ORDER BY night')
        .all()
        .map((r) => r.n),
      [4, 1]
    )
  } finally {
    f.close()
  }
})
test('J3 worst-case money/token limits refuse atomically before a single model dispatch', async () => {
  for (const budget of ['tokens', 'money'] as const) {
    const f = fixture()
    try {
      begin(f)
      const b = brief()
      b.judges.j3.enabled = true
      if (budget === 'tokens') b.judges.j3.tokenCapPerNight = role.tokenReserve - 1
      else {
        b.roles.j3!.moneyReserveMicros = 1
        b.judges.j3.moneyCapPerNightMicros = 0
      }
      let calls = 0
      const c = new RelayJudgeCascade(
        f.relay,
        input(b, {
          model: {
            admit: async () => true,
            sample: async () => {
              calls++
              return valid()
            }
          }
        })
      )
      c.bind(f.attempt)
      const r = await c.review(f.attempt, 'final', new AbortController().signal)
      assert.equal(r!.state, 'unavailable')
      assert.match(canonical(r!.payload), /judge_budget_exhausted/)
      assert.equal(calls, 0)
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_judge_debits').get()!.n, 0)
      assert.equal(f.relay.read(f.run.id).tokens, 0)
    } finally {
      f.close()
    }
  }
})

test('a refused durable dispatch trace rolls back request transition, run reserve and night debit together', () => {
  const f = fixture()
  try {
    begin(f)
    const b = brief()
    b.judges.j3.enabled = true
    const s = new JudgeStore(f.relay),
      bound = s.bind(f.attempt, b)
    const id = { cycle: 1, phase: 'review', layer: 'J3' as const, reason: 'final' },
      r = s.prepare(f.attempt, bound, id, { fixture: true })
    f.db.exec(
      `CREATE TRIGGER refuse_fixture_judge_trace BEFORE INSERT ON session_events WHEN NEW.type='agent.note' AND instr(NEW.payload,'judge_dispatched')>0 BEGIN SELECT RAISE(ABORT,'fixture_trace_refused'); END;`
    )
    try {
      assert.throws(() => s.dispatch(f.attempt, bound, r, id), /fixture_trace_refused/)
    } finally {
      f.db.exec('DROP TRIGGER refuse_fixture_judge_trace')
    }
    assert.equal(f.db.prepare('SELECT state FROM relay_judge_requests').get()!.state, 'prepared')
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_judge_debits').get()!.n, 0)
    assert.equal(f.relay.read(f.run.id).tokens, 0)
  } finally {
    f.close()
  }
})

test('actual J2 prompts contain fenced J0/J1 summaries and the preceding same-phase checker receipt', async () => {
  const f = fixture()
  try {
    const rawPath = 'synthetic-observation-path-never-in-context',
      claim = 'untrusted executor claim',
      bytes = Buffer.from('lead script')
    const b = brief()
    b.judges.checker = {
      base: plan.base,
      path: 'checks/lead',
      digest: byteHash(bytes),
      timeoutMs: 1000,
      outputBytes: 4096
    }
    f.relay.propose(f.attempt, claim)
    const packets: Array<Record<string, any>> = []
    const signals: RelayJudgeInput = {
      policy: {
        heartbeatStallMs: 10,
        noProgressCycles: 3,
        repeatedFailureCycles: 3,
        editRevertCycles: 3,
        repeatedDeadEnds: 3,
        tokenBlowupRatio: 2
      },
      collect: async (i) => ({
        observedAt: 1000,
        heartbeatAt: null,
        lease: null,
        deadlineAt: null,
        disk: null,
        cycle: i.ledger.cycle,
        noProgressCycles: 0,
        sameFailureStreak: 0,
        editRevertStreak: 0,
        deadEndRepetitions: 0,
        protectedPathEdits: [rawPath],
        outOfScopeEdits: [],
        tokensThisItem: 0,
        tokenBudgetForItem: null,
        crashed: true
      })
    }
    const configured = input(b, {
      checker: {
        read: async () => ({ base: plan.base, path: 'checks/lead', bytes }),
        run: async () =>
          canonical({
            taxonomy: 'scope',
            verdict: 'flagged',
            evidenceRefs: ['plan'],
            diagnosisHint: 'Distinctive pinned checker diagnosis'
          })
      },
      model: {
        admit: async () => true,
        sample: async (i) => {
          const packet = JSON.parse(i.prompt.slice(i.prompt.indexOf('\n') + 1))
          packets.push(packet)
          assert.equal(i.prompt.includes(rawPath), false)
          assert.deepEqual(
            packet.watchdog.summary.signals.map((s: any) => [s.layer, s.code]),
            [
              ['J0', 'crash'],
              ['J1', 'protected_path_edit']
            ]
          )
          assert.deepEqual(packet.watchdog.summary.unknownFacts, [
            'heartbeat',
            'lease',
            'deadline',
            'disk',
            'tokenBudget'
          ])
          assert.equal(packet.watchdog.summary.attempt.id, f.attempt.id)
          assert.equal(packet.watchdog.summary.attempt.runId, f.run.id)
          assert.equal(packet.watchdog.summary.attempt.epoch, f.attempt.epoch)
          assert.equal(packet.watchdog.summary.attempt.token, f.attempt.token)
          assert.equal(packet.checker.state, 'completed')
          assert.equal(packet.checker.payload.diagnosisHint, 'Distinctive pinned checker diagnosis')
          assert.equal(packet.evidenceRefs.includes(packet.checker.ref), true)
          assert.equal(packet.evidenceRefs.includes(packet.watchdog.ref), true)
          assert.equal(packet.evidenceRefs.includes(claim), false)
      assert.deepEqual(packet.executorClaims, {
            trust: 'untrusted quoted data',
            quoted: [claim]
          })
          const record = f.db
            .prepare(
              "SELECT key FROM relay_judge_requests WHERE attempt_id=? AND cycle=1 AND phase=? AND layer='J1.5' AND state='completed'"
            )
            .get(f.attempt.id, packet.watchdog.summary.phase)!
          assert.equal(packet.checker.ref, `checker:${record.key}`)
          return canonical({
            taxonomy: 'progress',
            verdict: 'consistent',
            evidenceRefs: ['plan', packet.checker.ref, packet.watchdog.ref],
            diagnosisHint: 'Harness facts reviewed.'
          })
        }
      }
    })
    const executor = new RelayExecutor(
      f.relay,
      f.model,
      f.workspace,
      reserves,
      f.scrubber,
      DEFAULT_RELAY_LIMITS,
      undefined,
      signals,
      configured
    )
    await executor.run(f.attempt)
    assert.equal(packets.length, 4)
    assert.deepEqual(
      packets.map((p) => p.watchdog.summary.phase),
      ['cycle_start', 'cycle_start', 'pre_seal', 'pre_seal']
    )
    assert.notEqual(packets[0]!.checker.ref, packets[2]!.checker.ref)
    const sealed = f.relay.sealed(f.attempt)!
    assert.equal(sealed.handoff.ledgerHash, hash(sealed.ledger))
    assert.equal(sealed.ledger.judge!.requests.length, 4)
  } finally {
    f.close()
  }
})
test('checker refusal is explicit J2 evidence and prior-phase checker refs cannot be reused', async () => {
  for (const mode of ['refusal', 'prior_phase'] as const) {
    const f = fixture()
    try {
      begin(f)
      const bytes = Buffer.from('lead script'),
        b = brief()
      b.judges.checker = {
        base: plan.base,
        path: 'checker',
        digest: byteHash(bytes),
        timeoutMs: 1000,
        outputBytes: 4096
      }
      let firstRef = '',
        phaseCount = 0
      const c = new RelayJudgeCascade(
        f.relay,
        input(b, {
          checker: {
            read: async () => ({
              base: plan.base,
              path: 'checker',
              bytes: mode === 'refusal' ? Buffer.from('modified') : bytes
            }),
            run: async () => valid()
          },
          model: {
            admit: async () => true,
            sample: async (i) => {
              const p = JSON.parse(i.prompt.slice(i.prompt.indexOf('\n') + 1))
              assert.equal(p.watchdog.state, 'unavailable')
              if (mode === 'refusal') {
                assert.equal(p.checker.state, 'unavailable')
                assert.equal(p.checker.payload.code, 'judge_checker_pin_mismatch')
                return valid()
              }
              if (phaseCount < 2) {
                firstRef = p.checker.ref
                phaseCount++
                return valid()
              }
              assert.notEqual(p.checker.ref, firstRef)
              return canonical({
                taxonomy: 'scope',
                verdict: 'flagged',
                evidenceRefs: [firstRef],
                diagnosisHint: 'Invalid prior-phase citation'
              })
            }
          }
        })
      )
      c.bind(f.attempt)
      await c.sample(f.attempt, 'cycle_start', new AbortController().signal)
      if (mode === 'prior_phase') {
        await c.sample(f.attempt, 'pre_seal', new AbortController().signal)
        assert.equal(
          f.db
            .prepare("SELECT state FROM relay_judge_requests WHERE phase='pre_seal' AND layer='J2'")
            .get()!.state,
          'invalid'
        )
      }
    } finally {
      f.close()
    }
  }
})
test('foreign cycle phase run and attempt summaries refuse before any checker/model request', async () => {
  const f = fixture()
  try {
    begin(f)
    let calls = 0
    const c = new RelayJudgeCascade(
      f.relay,
      input(brief(), {
        model: {
          admit: async () => {
            calls++
            return true
          },
          sample: async () => valid()
        }
      })
    )
    c.bind(f.attempt)
    const summary: RelayJudgeSummary = {
      attempt: {
        id: f.attempt.id,
        runId: f.run.id,
        epoch: f.attempt.epoch,
        token: f.attempt.token
      },
      cycle: 1,
      phase: 'cycle_start',
      signals: [],
      unknownFacts: ['heartbeat']
    }
    const patches = [
      { cycle: 2 },
      { phase: 'pre_seal' as const },
      { attempt: { ...summary.attempt, id: 'foreign' } },
      { attempt: { ...summary.attempt, runId: 'foreign' } },
      { attempt: { ...summary.attempt, epoch: summary.attempt.epoch + 1 } },
      { attempt: { ...summary.attempt, token: summary.attempt.token + 1 } }
    ]
    for (const patch of patches)
      await assert.rejects(
        c.sample(f.attempt, 'cycle_start', new AbortController().signal, { ...summary, ...patch }),
        /judge_summary_invalid/
      )
    assert.equal(calls, 0)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_judge_requests').get()!.n, 0)
  } finally {
    f.close()
  }
})
