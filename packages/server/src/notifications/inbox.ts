/**
 * The inbox facade the REST routes and kernel callers share: account-scoped reads, lazy snooze
 * expiry, the content-free action boundary and an honest action port table.
 *
 * Nothing here starts a timer. Snoozed rows return to `unread` when they are next read.
 */
import {
  executeAction,
  type ActionExecution,
  type ActionPortContext,
  type ActionPorts,
} from './actions.ts'
import type { NotificationService } from './service.ts'
import {
  NOTIFICATION_ACTIONS,
  type NotificationAction,
  type NotificationState,
  type NotificationStore,
  type StoredNotification,
} from './store.ts'

/** Actions the REST boundary may execute; the others carry prompts, free text or money intent. */
export const WIRE_ACTIONS: readonly NotificationAction[] = [
  'open', 'accept_recommendation', 'wake_leads', 'switch_connection', 'pause_runs', 'resume_runs', 'snooze',
]

export type InboxErrorCode =
  | 'not_configured'
  | 'action_not_offered'
  | 'invalid_snooze_time'
  | 'validation_failed'

/** A refusal decided by the inbox itself, before any store row or port is touched. */
export class InboxError extends Error {
  readonly code: InboxErrorCode
  constructor(code: InboxErrorCode) {
    super(code)
    this.name = 'InboxError'
    this.code = code
  }
}

export type ActionAvailability = 'available' | 'not_configured' | 'not_exposed'

export interface InboxOptions {
  /** Caller clock in milliseconds. */
  now(): number
  /**
   * Host-supplied effect ports. Anything not supplied is refused as `not_configured`, except
   * `open` and `snooze`, whose only effect is the inbox state the store already commits.
   */
  ports?: Partial<ActionPorts>
}

export interface ListInboxOptions {
  states?: readonly NotificationState[]
  limit: number
  before?: string
}

export interface InboxPage {
  items: StoredNotification[]
  nextCursor: string | null
}

const BUILT_IN: ReadonlySet<NotificationAction> = new Set<NotificationAction>(['open', 'snooze'])

function refused(): never {
  throw new InboxError('not_configured')
}

type PortMethod = Exclude<keyof ActionPorts, 'hasCompleted' | 'wakeLeads'>
const METHOD_FOR: Record<Exclude<NotificationAction, 'wake_leads'>, PortMethod> = {
  open: 'open',
  add_prompt: 'addPrompt',
  accept_recommendation: 'acceptRecommendation',
  choose_action: 'chooseAction',
  switch_connection: 'switchConnection',
  pause_runs: 'pauseRuns',
  resume_runs: 'resumeRuns',
  snooze: 'snooze',
  raise_budget: 'raiseBudget',
}

function hostSupplies(host: Partial<ActionPorts>, action: NotificationAction): boolean {
  return action === 'wake_leads' ? typeof host.wakeLeads === 'function' : typeof host[METHOD_FOR[action]] === 'function'
}

function configuredActions(host: Partial<ActionPorts>): Set<NotificationAction> {
  const configured = new Set<NotificationAction>(BUILT_IN)
  for (const action of NOTIFICATION_ACTIONS) if (hostSupplies(host, action)) configured.add(action)
  return configured
}

function buildPorts(host: Partial<ActionPorts>, store: NotificationStore): ActionPorts {
  const probe = host.hasCompleted
  // Built-in ports have no effect outside the store, so replaying them after a crash is safe.
  // Any other action needs a host probe to say whether its key already took effect; without
  // one the answer is "unknown" and nothing is replayed.
  const hasCompleted = (key: string): boolean | Promise<boolean> => {
    const row = store.db.prepare('SELECT action FROM notification_actions WHERE idempotency_key=?').get(key) as
      { action: string } | undefined
    const action = row?.action as NotificationAction | undefined
    if (action !== undefined && BUILT_IN.has(action) && !hostSupplies(host, action)) return false
    if (probe === undefined) throw new InboxError('not_configured')
    return probe.call(host, key)
  }
  return {
    open: host.open ?? (async () => ({ acknowledged: true })),
    addPrompt: host.addPrompt ?? (async () => refused()),
    acceptRecommendation: host.acceptRecommendation ?? (async () => refused()),
    chooseAction: host.chooseAction ?? (async () => refused()),
    wakeLeads: host.wakeLeads ?? (async () => refused()),
    switchConnection: host.switchConnection ?? (async () => refused()),
    pauseRuns: host.pauseRuns ?? (async () => refused()),
    resumeRuns: host.resumeRuns ?? (async () => refused()),
    snooze: host.snooze ?? (async (context: ActionPortContext<'snooze'>) => ({ untilMs: context.args.untilMs })),
    raiseBudget: host.raiseBudget ?? (async () => refused()),
    hasCompleted,
  }
}

export class NotificationInbox {
  readonly store: NotificationStore
  /** Kernel callers feed quota facts through this. */
  readonly ingest: NotificationService
  private readonly options: InboxOptions
  private readonly ports: ActionPorts
  private readonly configured: Set<NotificationAction>

  constructor(store: NotificationStore, ingest: NotificationService, options: InboxOptions) {
    this.store = store
    this.ingest = ingest
    this.options = options
    const host = options.ports ?? {}
    this.configured = configuredActions(host)
    this.ports = buildPorts(host, store)
  }

  /** Availability of every action on this node, so a client can disable what would be refused. */
  availability(): Array<{ action: NotificationAction; availability: ActionAvailability }> {
    return NOTIFICATION_ACTIONS.map((action) => ({
      action,
      availability: !WIRE_ACTIONS.includes(action)
        ? 'not_exposed'
        : this.configured.has(action) ? 'available' : 'not_configured',
    }))
  }

  list(accountId: string, options: ListInboxOptions): InboxPage {
    this.expire()
    const rows = this.store.list(accountId, {
      states: options.states,
      limit: options.limit + 1,
      before: options.before,
    })
    const items = rows.slice(0, options.limit)
    const last = items[items.length - 1]
    return { items, nextCursor: rows.length > options.limit && last !== undefined ? last.id : null }
  }

  get(accountId: string, id: string): StoredNotification {
    this.expire()
    return this.store.get(accountId, id)
  }

  markRead(accountId: string, id: string): StoredNotification {
    this.expire()
    return this.store.markRead(accountId, id)
  }

  snooze(accountId: string, id: string, untilMs: number): StoredNotification {
    this.assertFuture(untilMs)
    return this.store.snooze(accountId, id, untilMs)
  }

  async execute(
    accountId: string,
    notificationId: string,
    action: NotificationAction,
    args: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<ActionExecution> {
    this.expire()
    if (!WIRE_ACTIONS.includes(action)) throw new InboxError('validation_failed')
    const notification = this.store.get(accountId, notificationId)
    if (!notification.actions.includes(action)) throw new InboxError('action_not_offered')
    // A refusal writes nothing: no reservation row, so the notification stays actionable.
    if (!this.configured.has(action)) throw new InboxError('not_configured')
    if (action === 'snooze') this.assertFuture(args.untilMs)
    return executeAction(this.store, this.ports, { accountId, notificationId, action, args, idempotencyKey })
  }

  private expire(): void {
    this.store.expireSnoozed(this.options.now())
  }

  private assertFuture(untilMs: unknown): void {
    if (typeof untilMs !== 'number' || !Number.isSafeInteger(untilMs) || untilMs <= this.options.now()) {
      throw new InboxError('invalid_snooze_time')
    }
  }
}
