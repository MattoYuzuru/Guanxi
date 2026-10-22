import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NotificationActionError,
  executeAction,
  type ActionPortContext,
  type ActionPorts,
  type ExecuteActionInput,
} from '../../src/notifications/actions.ts'
import {
  NotificationStore,
  NotificationStoreError,
  type NotificationAction,
  type NotificationFacts,
  type StoredNotification,
} from '../../src/notifications/store.ts'

const T0 = Date.parse('2026-10-21T00:00:00.000Z')
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()
const ALL_ACTIONS: NotificationAction[] = [
  'open',
  'add_prompt',
  'accept_recommendation',
  'choose_action',
  'wake_leads',
  'switch_connection',
  'pause_runs',
  'resume_runs',
  'snooze',
  'raise_budget',
]

async function tempStore(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'nc1b-actions-'))
  const store = new NotificationStore(join(directory, 'notifications.sqlite'), () => T0)
  t.after(() => {
    store.close()
    return rm(directory, { recursive: true, force: true })
  })
  return store
}

function facts(): NotificationFacts {
  return {
    window: 'five_hour',
    threshold: 20,
    instanceKey: 'no-reset',
    remainingPercent: 19,
    resetsAt: null,
    source: 'test',
    observedAt: at(0),
    confidence: 'observed',
  }
}

function seedNotification(
  store: NotificationStore,
  actions: NotificationAction[],
  idempotencyKey = `notification-${randomUUID()}`,
  subject: StoredNotification['subject'] = { type: 'connection', id: 'conn-a' },
): StoredNotification {
  const id = randomUUID()
  store.db.prepare(`
    INSERT INTO notifications(
      id, account_id, kind, severity, subject_type, subject_id, idempotency_key,
      facts, actions, state, snoozed_until, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,'unread',NULL,?,?)
  `).run(
    id,
    'acct-a',
    'threshold',
    'warning',
    subject.type,
    subject.id,
    idempotencyKey,
    JSON.stringify(facts()),
    JSON.stringify(actions),
    T0,
    T0,
  )
  return store.get('acct-a', id)
}

interface FakePorts {
  calls: string[]
  probes: string[]
  recorded: Set<string>
  ports: ActionPorts
}

function fakePorts(options: {
  beforeWakeLeads?: () => Promise<void>
  overrides?: Partial<ActionPorts>
  withoutProbe?: boolean
} = {}): FakePorts {
  const calls: string[] = []
  const probes: string[] = []
  const recorded = new Set<string>()
  const ports: ActionPorts = {
    open: async context => {
      calls.push('open')
      recorded.add(context.idempotencyKey)
      return { ok: 'open' }
    },
    addPrompt: async context => {
      calls.push('add_prompt')
      recorded.add(context.idempotencyKey)
      return { ok: 'add_prompt' }
    },
    acceptRecommendation: async context => {
      calls.push('accept_recommendation')
      recorded.add(context.idempotencyKey)
      return { ok: 'accept_recommendation' }
    },
    chooseAction: async context => {
      calls.push('choose_action')
      recorded.add(context.idempotencyKey)
      return { ok: 'choose_action' }
    },
    wakeLeads: async (connectionId, context) => {
      calls.push(`wake_leads:${connectionId}`)
      await options.beforeWakeLeads?.()
      recorded.add(context.idempotencyKey)
      return { ok: 'wake_leads' }
    },
    switchConnection: async context => {
      calls.push(`switch_connection:${context.args.connectionId}`)
      recorded.add(context.idempotencyKey)
      return { ok: 'switch_connection' }
    },
    pauseRuns: async context => {
      calls.push('pause_runs')
      recorded.add(context.idempotencyKey)
      return { ok: 'pause_runs' }
    },
    resumeRuns: async context => {
      calls.push('resume_runs')
      recorded.add(context.idempotencyKey)
      return { ok: 'resume_runs' }
    },
    snooze: async context => {
      calls.push('snooze')
      recorded.add(context.idempotencyKey)
      return { ok: 'snooze' }
    },
    raiseBudget: async context => {
      calls.push('raise_budget')
      recorded.add(context.idempotencyKey)
      return { ok: 'raise_budget' }
    },
    ...options.overrides,
  }
  if (options.withoutProbe !== true) {
    ports.hasCompleted = async (key: string) => {
      probes.push(key)
      return recorded.has(key)
    }
  }
  return { calls, probes, recorded, ports }
}

function input(notification: StoredNotification, action: NotificationAction, args: Record<string, unknown>, key: string): ExecuteActionInput {
  return {
    accountId: 'acct-a',
    notificationId: notification.id,
    action,
    args,
    idempotencyKey: key,
  }
}

function wakeContext(notification: StoredNotification, key: string): ActionPortContext<'wake_leads'> {
  return {
    accountId: 'acct-a',
    notificationId: notification.id,
    subject: notification.subject,
    action: 'wake_leads',
    args: {},
    idempotencyKey: key,
  }
}

test('each typed action routes to its matching port exactly once', async (t) => {
  const store = await tempStore(t)
  const fake = fakePorts()
  const cases: Array<{ action: NotificationAction; args: Record<string, unknown>; call: string }> = [
    { action: 'open', args: { target: 'connection' }, call: 'open' },
    { action: 'add_prompt', args: { prompt: 'continue this run' }, call: 'add_prompt' },
    { action: 'accept_recommendation', args: { recommendation: 'switch_connection' }, call: 'accept_recommendation' },
    { action: 'choose_action', args: { choice: 'snooze' }, call: 'choose_action' },
    { action: 'wake_leads', args: {}, call: 'wake_leads:conn-a' },
    { action: 'switch_connection', args: { connectionId: 'conn-fallback' }, call: 'switch_connection:conn-fallback' },
    { action: 'pause_runs', args: { runIds: ['run-1'] }, call: 'pause_runs' },
    { action: 'resume_runs', args: { runIds: ['run-1'] }, call: 'resume_runs' },
    { action: 'snooze', args: { untilMs: T0 + 60_000 }, call: 'snooze' },
    { action: 'raise_budget', args: { capMicros: 5_000_000 }, call: 'raise_budget' },
  ]

  for (const [index, item] of cases.entries()) {
    const notification = seedNotification(store, ALL_ACTIONS, `notification-${index}`)
    const key = `action-key-${index}`
    const result = await executeAction(store, fake.ports, input(notification, item.action, item.args, key))
    assert.equal(result.status, 'done')
    assert.equal(result.duplicate, false)
    const updated = store.get('acct-a', notification.id)
    if (item.action === 'snooze') {
      assert.equal(updated.state, 'snoozed')
      assert.equal(updated.snoozedUntil, T0 + 60_000)
    } else if (item.action === 'open' || item.action === 'accept_recommendation') {
      assert.equal(updated.state, 'read')
    } else {
      assert.equal(updated.state, 'acted')
    }
    assert.equal(store.actionRecord('acct-a', key)?.status, 'done')
  }

  assert.deepEqual(fake.calls, cases.map(item => item.call))
})

test('a duplicate idempotency key returns the stored result without a second port call', async (t) => {
  const store = await tempStore(t)
  const fake = fakePorts()
  const notification = seedNotification(store, ['open'])
  const request = input(notification, 'open', {}, 'duplicate-open')

  const first = await executeAction(store, fake.ports, request)
  const second = await executeAction(store, fake.ports, request)
  assert.deepEqual(first.result, { ok: 'open' })
  assert.deepEqual(second.result, first.result)
  assert.equal(second.duplicate, true)
  assert.deepEqual(fake.calls, ['open'])

  const late = store.finishAction('duplicate-open', 'failed', { code: 'late_rewrite' }, 'acct-a')
  assert.equal(late.status, 'done')
  assert.deepEqual(late.result, { ok: 'open' }, 'terminal action rows are immutable')
})

test('concurrent identical executeAction calls share one port invocation', async (t) => {
  const store = await tempStore(t)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const fake = fakePorts({
    beforeWakeLeads: async () => {
      entered()
      await gate
    },
  })
  const notification = seedNotification(store, ['wake_leads'], 'concurrent-notification')
  const request = input(notification, 'wake_leads', {}, 'concurrent-key')

  const first = executeAction(store, fake.ports, request)
  await started
  const second = executeAction(store, fake.ports, request)
  release()
  const [firstResult, secondResult] = await Promise.all([first, second])

  assert.deepEqual(fake.calls, ['wake_leads:conn-a'])
  assert.deepEqual(firstResult, secondResult)
  assert.equal(store.actionRecord('acct-a', 'concurrent-key')?.status, 'done')
})

test('a second key cannot repeat an action on an acted notification', async (t) => {
  const store = await tempStore(t)
  const fake = fakePorts()
  const notification = seedNotification(store, ['wake_leads'], 'acted-notification')

  await executeAction(store, fake.ports, input(notification, 'wake_leads', {}, 'first-key'))
  await assert.rejects(
    () => executeAction(store, fake.ports, input(notification, 'wake_leads', {}, 'second-key')),
    (error: unknown) => error instanceof NotificationActionError && error.code === 'notification_acted',
  )
  assert.deepEqual(fake.calls, ['wake_leads:conn-a'])
  assert.equal(store.actionRecord('acct-a', 'second-key'), null)
  assert.equal(store.get('acct-a', notification.id).state, 'acted')
})

test('open marks the notification read and leaves a state-changing action available', async (t) => {
  const store = await tempStore(t)
  const fake = fakePorts()
  const notification = seedNotification(store, ['open', 'wake_leads'], 'open-then-wake-notification')

  const opened = await executeAction(store, fake.ports, input(notification, 'open', { target: 'connection' }, 'open-key'))
  assert.deepEqual(opened.result, { ok: 'open' })
  assert.equal(store.get('acct-a', notification.id).state, 'read')

  const woke = await executeAction(store, fake.ports, input(notification, 'wake_leads', {}, 'wake-after-open'))
  assert.deepEqual(woke.result, { ok: 'wake_leads' })
  assert.equal(store.get('acct-a', notification.id).state, 'acted')
  assert.deepEqual(fake.calls, ['open', 'wake_leads:conn-a'])
})

test('snooze and markRead cannot revive an acted notification for a second action', async (t) => {
  const store = await tempStore(t)
  const fake = fakePorts()
  const notification = seedNotification(store, ['wake_leads', 'snooze'], 'acted-snooze-notification')

  await executeAction(store, fake.ports, input(notification, 'wake_leads', {}, 'first-wake'))
  assert.equal(store.get('acct-a', notification.id).state, 'acted')

  for (const attempt of [
    () => store.snooze('acct-a', notification.id, T0 + 60_000),
    () => store.markRead('acct-a', notification.id),
  ]) {
    assert.throws(
      attempt,
      (error: unknown) => error instanceof NotificationStoreError && error.code === 'notification_acted',
    )
  }
  assert.equal(store.expireSnoozed(T0 + 120_000), 0, 'an acted row must not become unread')
  assert.equal(store.get('acct-a', notification.id).state, 'acted')

  await assert.rejects(
    () => executeAction(store, fake.ports, input(notification, 'wake_leads', {}, 'second-wake')),
    (error: unknown) => error instanceof NotificationActionError && error.code === 'notification_acted',
  )
  assert.deepEqual(fake.calls, ['wake_leads:conn-a'], 'the second wake must not call the port')
})

test('an action already in progress refuses a different key', async (t) => {
  const store = await tempStore(t)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const fake = fakePorts({
    beforeWakeLeads: async () => {
      entered()
      await gate
    },
  })
  const notification = seedNotification(store, ['wake_leads'], 'in-progress-notification')
  const first = executeAction(store, fake.ports, input(notification, 'wake_leads', {}, 'live-key'))
  await started

  await assert.rejects(
    () => executeAction(store, fake.ports, input(notification, 'wake_leads', {}, 'other-key')),
    (error: unknown) => error instanceof NotificationActionError && error.code === 'action_in_progress',
  )
  release()
  await first
  assert.deepEqual(fake.calls, ['wake_leads:conn-a'])
  assert.equal(store.actionRecord('acct-a', 'other-key'), null)
})

test('wake_leads outside a connection subject requires a non-empty connection id', async (t) => {
  const store = await tempStore(t)
  const fake = fakePorts()
  const notification = seedNotification(store, ['wake_leads'], 'run-subject-notification', { type: 'run', id: 'run-1' })

  for (const args of [{}, { connectionId: '' }]) {
    await assert.rejects(
      () => executeAction(store, fake.ports, input(notification, 'wake_leads', args, `invalid-wake-${JSON.stringify(args)}`)),
      (error: unknown) => error instanceof NotificationActionError && error.code === 'invalid_args',
    )
  }
  assert.deepEqual(fake.calls, [])
  assert.equal(store.get('acct-a', notification.id).state, 'unread')
})

test('an action that the notification does not offer is refused before reservation', async (t) => {
  const store = await tempStore(t)
  const fake = fakePorts()
  const notification = seedNotification(store, ['open'])

  await assert.rejects(
    () => executeAction(store, fake.ports, input(notification, 'switch_connection', { connectionId: 'conn-b' }, 'not-offered')),
    (error: unknown) => error instanceof NotificationActionError && error.code === 'action_not_offered',
  )
  assert.deepEqual(fake.calls, [])
  assert.equal(store.actionRecord('acct-a', 'not-offered'), null)
  assert.equal(store.get('acct-a', notification.id).state, 'unread')
})

test('an unknown action is rejected as invalid before any reservation', async (t) => {
  const store = await tempStore(t)
  const fake = fakePorts()
  const notification = seedNotification(store, ALL_ACTIONS)

  await assert.rejects(
    () => executeAction(store, fake.ports, input(notification, 'delete_everything' as NotificationAction, {}, 'unknown-action')),
    (error: unknown) => error instanceof NotificationActionError && error.code === 'invalid_action',
  )
  assert.deepEqual(fake.calls, [])
  assert.equal(store.actionRecord('acct-a', 'unknown-action'), null)
})

test('a throwing port records a content-free failed result and rethrows a typed error', async (t) => {
  const store = await tempStore(t)
  const fake = fakePorts({
    overrides: {
      pauseRuns: async () => {
        throw new Error('secret run content must not be stored')
      },
    },
  })
  const notification = seedNotification(store, ['pause_runs'])

  await assert.rejects(
    () => executeAction(store, fake.ports, input(notification, 'pause_runs', {}, 'failing-key')),
    (error: unknown) => error instanceof NotificationActionError &&
      error.code === 'port_failed' &&
      !String(error.message).includes('secret') &&
      JSON.stringify(error.result) === '{"code":"port_failed"}',
  )
  const record = store.actionRecord('acct-a', 'failing-key')
  assert.equal(record?.status, 'failed')
  assert.deepEqual(record?.result, { code: 'port_failed' })
  assert.equal(JSON.stringify(record).includes('secret'), false)
  assert.equal(store.get('acct-a', notification.id).state, 'unread')

  const retry = await executeAction(store, fake.ports, input(notification, 'pause_runs', {}, 'failing-key'))
  assert.equal(retry.status, 'failed')
  assert.equal(retry.duplicate, true)
  assert.deepEqual(fake.calls, [])
})

test('a started action replays only when the port reports no record of the key', async (t) => {
  for (const completed of [true, false]) {
    const store = await tempStore(t)
    const notification = seedNotification(store, ['wake_leads'], `crash-notification-${completed}`)
    const key = `crash-key-${completed}`
    assert.equal(store.beginAction('acct-a', notification.id, 'wake_leads', key), 'started')

    const fake = fakePorts()
    if (completed) {
      // The process died after the port took effect but before finishAction committed.
      await fake.ports.wakeLeads('conn-a', wakeContext(notification, key))
    }
    const callsBeforeRetry = fake.calls.length
    const result = await executeAction(store, fake.ports, input(notification, 'wake_leads', {}, key))
    assert.deepEqual(fake.probes, [key])

    if (completed) {
      assert.equal(fake.calls.length, callsBeforeRetry, 'a recorded port effect must not run twice')
      assert.deepEqual(result.result, { recovered: true })
    } else {
      assert.equal(fake.calls.length, callsBeforeRetry + 1, 'a port without a record replays once')
      assert.deepEqual(result.result, { ok: 'wake_leads' })
    }
    assert.equal(store.actionRecord('acct-a', key)?.status, 'done')
    assert.equal(store.get('acct-a', notification.id).state, 'acted')
    store.close()
  }
})

test('a crash after the port returned is recovered from the key the port recorded', async (t) => {
  const store = await tempStore(t)
  const fake = fakePorts()
  const notification = seedNotification(store, ['wake_leads'], 'port-returned-notification')
  const key = 'port-returned-key'

  const finish = store.finishAction.bind(store)
  let crash = true
  t.mock.method(store, 'finishAction', (...args: Parameters<NotificationStore['finishAction']>) => {
    if (crash) {
      crash = false
      throw new Error('simulated crash before commit')
    }
    return finish(...args)
  })

  // The port performs the wake and records the key, then the process dies before finishAction
  // commits the terminal row.
  await assert.rejects(() => executeAction(store, fake.ports, input(notification, 'wake_leads', {}, key)))
  assert.deepEqual(fake.calls, ['wake_leads:conn-a'])
  assert.deepEqual([...fake.recorded], [key], 'wake_leads must receive its idempotency context')
  assert.equal(store.actionRecord('acct-a', key)?.status, 'started')

  const retried = await executeAction(store, fake.ports, input(notification, 'wake_leads', {}, key))
  assert.deepEqual(fake.probes, [key])
  assert.deepEqual(retried.result, { recovered: true })
  assert.deepEqual(fake.calls, ['wake_leads:conn-a'], 'the fake saw the key, so the port must not run twice')
  assert.equal(store.actionRecord('acct-a', key)?.status, 'done')
  assert.equal(store.get('acct-a', notification.id).state, 'acted')
})

test('wake_leads calls its port exactly once per notification across retries', async (t) => {
  const store = await tempStore(t)
  const fake = fakePorts()
  const notification = seedNotification(store, ['wake_leads'], 'wake-once-notification')
  const key = 'wake-once-key'
  assert.equal(store.beginAction('acct-a', notification.id, 'wake_leads', key), 'started')

  const first = await executeAction(store, fake.ports, input(notification, 'wake_leads', {}, key))
  const second = await executeAction(store, fake.ports, input(notification, 'wake_leads', {}, key))
  assert.deepEqual(fake.calls, ['wake_leads:conn-a'])
  assert.deepEqual(first.result, { ok: 'wake_leads' })
  assert.deepEqual(second.result, first.result)
  assert.equal(second.duplicate, true)
})

test('a started action without an idempotency probe refuses to guess', async (t) => {
  const store = await tempStore(t)
  const fake = fakePorts({ withoutProbe: true })
  const notification = seedNotification(store, ['open'], 'unknown-outcome-notification')
  const key = 'unknown-outcome-key'
  assert.equal(store.beginAction('acct-a', notification.id, 'open', key), 'started')

  await assert.rejects(
    () => executeAction(store, fake.ports, input(notification, 'open', {}, key)),
    (error: unknown) => error instanceof NotificationActionError && error.code === 'action_outcome_unknown',
  )
  assert.deepEqual(fake.calls, [])
  assert.equal(store.actionRecord('acct-a', key)?.status, 'started')
})
