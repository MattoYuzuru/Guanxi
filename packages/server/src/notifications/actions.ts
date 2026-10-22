import {
  NOTIFICATION_ACTIONS,
  NotificationStoreError,
  type FinishActionOptions,
  type NotificationAction,
  type NotificationStore,
  type StoredNotification,
  type StoredNotificationAction,
} from './store.ts'

export interface ActionArgumentMap {
  open: { target?: string; url?: string }
  add_prompt: { prompt: string; targetRunId?: string }
  accept_recommendation: { recommendation?: string; reason?: string }
  choose_action: { choice: string; reason?: string }
  wake_leads: Record<string, never>
  switch_connection: { connectionId: string; role?: string }
  pause_runs: { runIds?: string[]; connectionId?: string }
  resume_runs: { runIds?: string[]; connectionId?: string }
  snooze: { untilMs: number }
  raise_budget: { capMicros?: number; note?: string }
}

export interface ActionPortContext<A extends NotificationAction = NotificationAction> {
  accountId: string
  notificationId: string
  subject: StoredNotification['subject']
  action: A
  args: ActionArgumentMap[A]
  idempotencyKey: string
}

/**
 * One async method per typed action. A real implementation performs the side effect and returns
 * a JSON-serialisable result. `hasCompleted` is the crash-recovery probe: it must report whether
 * this idempotency key already took effect. It is optional because a port without a durable
 * effect must never be replayed blindly.
 */
export interface ActionPorts {
  open(context: ActionPortContext<'open'>): Promise<unknown>
  addPrompt(context: ActionPortContext<'add_prompt'>): Promise<unknown>
  acceptRecommendation(context: ActionPortContext<'accept_recommendation'>): Promise<unknown>
  chooseAction(context: ActionPortContext<'choose_action'>): Promise<unknown>
  /** Exactly one call per notification is allowed across retries. */
  wakeLeads(connectionId: string): Promise<unknown>
  switchConnection(context: ActionPortContext<'switch_connection'>): Promise<unknown>
  pauseRuns(context: ActionPortContext<'pause_runs'>): Promise<unknown>
  resumeRuns(context: ActionPortContext<'resume_runs'>): Promise<unknown>
  snooze(context: ActionPortContext<'snooze'>): Promise<unknown>
  /** Records an intent only; this port must never spend money by itself. */
  raiseBudget(context: ActionPortContext<'raise_budget'>): Promise<unknown>
  /** Crash recovery only: true means the key already took effect, so do not call the effect again. */
  hasCompleted?(idempotencyKey: string): boolean | Promise<boolean>
}

export type NotificationActionErrorCode =
  | 'invalid_action'
  | 'invalid_args'
  | 'action_not_offered'
  | 'notification_not_found'
  | 'notification_acted'
  | 'action_in_progress'
  | 'account_mismatch'
  | 'idempotency_conflict'
  | 'action_not_found'
  | 'port_failed'
  | 'action_outcome_unknown'

export class NotificationActionError extends Error {
  readonly code: NotificationActionErrorCode
  readonly result: unknown

  constructor(code: NotificationActionErrorCode, message: string, options: { result?: unknown } = {}) {
    super(message)
    this.name = 'NotificationActionError'
    this.code = code
    this.result = options.result ?? null
  }
}

export interface ExecuteActionInput {
  accountId: string
  notificationId: string
  action: NotificationAction
  args?: Record<string, unknown>
  idempotencyKey: string
}

export interface ActionExecution {
  notificationId: string
  action: NotificationAction
  status: 'done' | 'failed'
  result: unknown
  /** True when the idempotency key already had a stored action row before this call. */
  duplicate: boolean
}

/**
 * Same-process calls with an identical key share one in-flight promise, so a retry racing a live
 * attempt cannot probe a `started` row and invoke the port a second time.
 */
const activeExecutions = new Map<string, Promise<ActionExecution>>()

function completionOptions(action: NotificationAction, args: Record<string, unknown>): FinishActionOptions {
  return action === 'snooze' ? { snoozedUntil: args.untilMs as number } : {}
}

function storeFailure(error: NotificationStoreError): NotificationActionError {
  switch (error.code) {
    case 'invalid_action': return new NotificationActionError('invalid_action', error.message)
    case 'action_not_offered': return new NotificationActionError('action_not_offered', error.message)
    case 'notification_not_found': return new NotificationActionError('notification_not_found', error.message)
    case 'notification_acted': return new NotificationActionError('notification_acted', error.message)
    case 'action_in_progress': return new NotificationActionError('action_in_progress', error.message)
    case 'account_mismatch': return new NotificationActionError('account_mismatch', error.message)
    case 'idempotency_conflict': return new NotificationActionError('idempotency_conflict', error.message)
    case 'action_not_found': return new NotificationActionError('action_not_found', error.message)
    default: return new NotificationActionError('invalid_args', error.message)
  }
}

function invalidArgs(field: string): NotificationActionError {
  return new NotificationActionError('invalid_args', `${field} is invalid`)
}

function textArg(args: Record<string, unknown>, field: string): string {
  const value = args[field]
  if (typeof value !== 'string' || value.length === 0) throw invalidArgs(field)
  return value
}

function optionalTextArg(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalidArgs(field)
  return value
}

function optionalStringArray(args: Record<string, unknown>, field: string): string[] | undefined {
  const value = args[field]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry.length === 0)) {
    throw invalidArgs(field)
  }
  return [...value]
}

function normaliseArgs(raw: Record<string, unknown> | undefined): Record<string, unknown> {
  if (raw === undefined) return {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NotificationActionError('invalid_args', 'args must be an object')
  }
  return raw
}

function validateArguments(
  notification: StoredNotification,
  action: NotificationAction,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  switch (action) {
    case 'open':
      optionalTextArg(raw, 'target')
      optionalTextArg(raw, 'url')
      return raw
    case 'add_prompt':
      textArg(raw, 'prompt')
      optionalTextArg(raw, 'targetRunId')
      return raw
    case 'accept_recommendation':
      optionalTextArg(raw, 'recommendation')
      optionalTextArg(raw, 'reason')
      return raw
    case 'choose_action':
      textArg(raw, 'choice')
      optionalTextArg(raw, 'reason')
      return raw
    case 'wake_leads': {
      if (notification.subject.type !== 'connection') {
        const connectionId = raw.connectionId
        if (typeof connectionId !== 'string' || connectionId.length === 0) throw invalidArgs('connectionId')
      }
      return raw
    }
    case 'switch_connection':
      textArg(raw, 'connectionId')
      optionalTextArg(raw, 'role')
      return raw
    case 'pause_runs':
    case 'resume_runs':
      optionalStringArray(raw, 'runIds')
      optionalTextArg(raw, 'connectionId')
      return raw
    case 'snooze': {
      const untilMs = raw.untilMs
      if (typeof untilMs !== 'number' || !Number.isFinite(untilMs)) throw invalidArgs('untilMs')
      return raw
    }
    case 'raise_budget': {
      const capMicros = raw.capMicros
      if (capMicros !== undefined && (typeof capMicros !== 'number' || !Number.isFinite(capMicros) || capMicros < 0)) {
        throw invalidArgs('capMicros')
      }
      optionalTextArg(raw, 'note')
      return raw
    }
  }
}

function contextFor<A extends NotificationAction>(
  notification: StoredNotification,
  action: A,
  args: Record<string, unknown>,
  idempotencyKey: string,
): ActionPortContext<A> {
  return {
    accountId: notification.accountId,
    notificationId: notification.id,
    subject: notification.subject,
    action,
    args: args as ActionArgumentMap[A],
    idempotencyKey,
  }
}

async function invokePort(
  ports: ActionPorts,
  notification: StoredNotification,
  action: NotificationAction,
  args: Record<string, unknown>,
  idempotencyKey: string,
): Promise<unknown> {
  switch (action) {
    case 'open': return ports.open(contextFor(notification, action, args, idempotencyKey))
    case 'add_prompt': return ports.addPrompt(contextFor(notification, action, args, idempotencyKey))
    case 'accept_recommendation': return ports.acceptRecommendation(contextFor(notification, action, args, idempotencyKey))
    case 'choose_action': return ports.chooseAction(contextFor(notification, action, args, idempotencyKey))
    case 'wake_leads': {
      const connectionId = notification.subject.type === 'connection'
        ? notification.subject.id
        : args.connectionId
      if (typeof connectionId !== 'string' || connectionId.length === 0) throw invalidArgs('connectionId')
      return ports.wakeLeads(connectionId)
    }
    case 'switch_connection': return ports.switchConnection(contextFor(notification, action, args, idempotencyKey))
    case 'pause_runs': return ports.pauseRuns(contextFor(notification, action, args, idempotencyKey))
    case 'resume_runs': return ports.resumeRuns(contextFor(notification, action, args, idempotencyKey))
    case 'snooze': return ports.snooze(contextFor(notification, action, args, idempotencyKey))
    case 'raise_budget': return ports.raiseBudget(contextFor(notification, action, args, idempotencyKey))
  }
}

function execution(
  input: ExecuteActionInput,
  record: StoredNotificationAction,
  duplicate: boolean,
): ActionExecution {
  return {
    notificationId: input.notificationId,
    action: input.action,
    status: record.status === 'failed' ? 'failed' : 'done',
    result: record.result,
    duplicate,
  }
}

/**
 * Validate the command against the notification, reserve the idempotency key, perform the port
 * effect and persist the terminal result. Finished keys never call a port again. A `started`
 * key from a crashed process is replayed only when `hasCompleted` explicitly reports no record.
 */
export async function executeAction(
  store: NotificationStore,
  ports: ActionPorts,
  input: ExecuteActionInput,
): Promise<ActionExecution> {
  const scope = `${store.path}\0${input.idempotencyKey}\0${input.notificationId}\0${input.action}`
  const active = activeExecutions.get(scope)
  if (active !== undefined) return active

  const running = runAction(store, ports, input)
  activeExecutions.set(scope, running)
  try {
    return await running
  } finally {
    if (activeExecutions.get(scope) === running) activeExecutions.delete(scope)
  }
}

async function runAction(
  store: NotificationStore,
  ports: ActionPorts,
  input: ExecuteActionInput,
): Promise<ActionExecution> {
  if (!(NOTIFICATION_ACTIONS as readonly string[]).includes(input.action)) {
    throw new NotificationActionError('invalid_action', 'Unknown notification action')
  }

  let notification: StoredNotification
  try {
    notification = store.get(input.accountId, input.notificationId)
  } catch (error) {
    if (error instanceof NotificationStoreError) throw storeFailure(error)
    throw error
  }

  if (!notification.actions.includes(input.action)) {
    throw new NotificationActionError('action_not_offered', 'Action is not offered by this notification')
  }
  const args = validateArguments(notification, input.action, normaliseArgs(input.args))

  let reservation: 'started' | 'duplicate'
  try {
    reservation = store.beginAction(input.accountId, input.notificationId, input.action, input.idempotencyKey)
  } catch (error) {
    if (error instanceof NotificationStoreError) throw storeFailure(error)
    throw error
  }

  let duplicate = false
  if (reservation === 'duplicate') {
    duplicate = true
    let record: StoredNotificationAction | null
    try {
      record = store.actionRecord(input.accountId, input.idempotencyKey)
    } catch (error) {
      if (error instanceof NotificationStoreError) throw storeFailure(error)
      throw error
    }
    if (!record) throw new NotificationActionError('action_not_found', 'Action not found')
    if (record.status !== 'started') return execution(input, record, true)

    // The process died after beginAction but before finishAction. Replaying the effect is only
    // safe when the port explicitly says it has no record of this key.
    if (ports.hasCompleted === undefined) {
      throw new NotificationActionError(
        'action_outcome_unknown',
        'Action was started but its port has no idempotency probe',
      )
    }
    let completed: boolean
    try {
      completed = (await ports.hasCompleted.call(ports, input.idempotencyKey)) === true
    } catch {
      throw new NotificationActionError('action_outcome_unknown', 'Action port could not report its state')
    }
    if (completed) {
      let finished: StoredNotificationAction
      try {
        finished = store.finishAction(
          input.idempotencyKey,
          'done',
          { recovered: true },
          input.accountId,
          completionOptions(input.action, args),
        )
      } catch (error) {
        if (error instanceof NotificationStoreError) throw storeFailure(error)
        throw error
      }
      return execution(input, finished, true)
    }
  }

  let result: unknown
  try {
    result = await invokePort(ports, notification, input.action, args, input.idempotencyKey)
  } catch {
    let failed: StoredNotificationAction
    try {
      failed = store.finishAction(input.idempotencyKey, 'failed', { code: 'port_failed' }, input.accountId)
    } catch (finishError) {
      if (finishError instanceof NotificationStoreError) throw storeFailure(finishError)
      throw finishError
    }
    throw new NotificationActionError('port_failed', 'Action port failed', { result: failed.result })
  }

  let finished: StoredNotificationAction
  try {
    finished = store.finishAction(
      input.idempotencyKey,
      'done',
      result,
      input.accountId,
      completionOptions(input.action, args),
    )
  } catch (error) {
    if (error instanceof NotificationStoreError) throw storeFailure(error)
    throw error
  }
  return execution(input, finished, duplicate)
}
