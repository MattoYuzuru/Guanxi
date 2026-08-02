import { createHash } from 'node:crypto'
import {
  messageSchema,
  type ChatJobOutput,
  type Job,
  type JobEventOutput,
  type JobState,
  type Message,
  type ToolCall,
  type Usage,
} from '@alamo/contract'
import type { JobService } from './service.ts'
import type {
  ChatJobAssociation,
  ChatRecoveryCursor,
  JobStore,
} from '../store/jobs.ts'
import type { TerminalMessageUpdate, ThreadStore } from '../store/threads.ts'

export const DEFAULT_CHAT_RECOVERY_SCAN_PAGE_SIZE = 50
export const DEFAULT_CHAT_RECOVERY_OUTPUT_PAGE_SIZE = 100

const TERMINAL = new Set<JobState>(['completed', 'failed', 'cancelled', 'interrupted'])
const INTERRUPTED_STATES = new Set<JobState>([
  'reserving',
  'loading',
  'prefill',
  'thinking',
  'generating',
  'waiting_tool',
  'waiting_approval',
  'finalizing',
])

export type ChatRecoveryCheckpoint =
  | { phase: 'scan_page'; page: number }
  | { phase: 'before_terminal'; jobId: string; previousState: JobState }
  | { phase: 'schedule_page'; page: number }

export interface ChatRecoveryOptions {
  scanPageSize?: number
  outputPageSize?: number
  scheduleQueued?: boolean
  checkpoint?: (checkpoint: ChatRecoveryCheckpoint) => void
}

export interface ChatRecoveryReport {
  scanned: number
  scanPages: number
  outputPages: number
  queuedValidated: number
  queuedScheduled: number
  interrupted: number
  cancelled: number
}

interface ChatRecoveryDependencies {
  jobs: JobStore
  jobService: JobService
  threads: ThreadStore
  chatExecution: { ensureStarted(jobId: string): void }
}

interface ReconcileDependencies {
  jobs: JobStore
  jobService: JobService
  threads: ThreadStore
}

interface RecoveryProjection {
  message: Message
  update: TerminalMessageUpdate
  steps: number
  outputEvents: number
  outputPages: number
  matchedStart: boolean
}

export class ChatRecoveryError extends Error {
  readonly code = 'chat_startup_recovery_failed'

  constructor() {
    super('Chat startup recovery could not reconcile durable state')
    this.name = 'ChatRecoveryError'
  }
}

function pageSize(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 1_000) {
    throw new RangeError(`${field} must be an integer from 1 to 1000`)
  }
  return resolved
}

function fingerprint(input: ChatJobAssociation['input']): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

function privateOutput(event: ChatJobOutput): JobEventOutput {
  return { privacyClassification: 'private_chat', event }
}

function upsertToolCall(toolCalls: ToolCall[], next: ToolCall): void {
  const index = toolCalls.findIndex((toolCall) => toolCall.id === next.id)
  if (index === -1) toolCalls.push(next)
  else toolCalls[index] = next
}

function applyToolResult(
  toolCalls: ToolCall[],
  result: Extract<ChatJobOutput, { type: 'tool_result' }>['data'],
): void {
  const index = toolCalls.findIndex((toolCall) => toolCall.id === result.toolCallId)
  if (index === -1) throw new Error('A recovered Chat tool result has no preceding tool call')
  const current = toolCalls[index]!
  toolCalls[index] = {
    ...current,
    status: result.status,
    result: result.result,
    error: result.error,
    durationMs: result.durationMs,
  }
}

function validateAssociation(
  dependencies: ReconcileDependencies,
  association: ChatJobAssociation,
): Message {
  const { job } = association
  if (
    job.kind !== 'inference' ||
    job.operation !== 'chat' ||
    job.idempotencyScope !== `chat:${association.threadId}:send:v1` ||
    association.requestFingerprint !== fingerprint(association.input)
  ) {
    throw new Error('A durable Chat association does not match its immutable command')
  }

  const user = messageSchema.parse(dependencies.threads.getMessage(association.userMessageId))
  const initialAssistant = messageSchema.parse(
    dependencies.threads.getMessage(association.assistantMessageId),
  )
  if (
    user.role !== 'user' ||
    user.threadId !== association.threadId ||
    user.jobId !== job.id ||
    user.content !== association.input.content ||
    initialAssistant.role !== 'assistant' ||
    initialAssistant.threadId !== association.threadId ||
    initialAssistant.jobId !== job.id
  ) {
    throw new Error('A durable Chat association points at inconsistent Messages')
  }

  const pending = dependencies.threads
    .pendingAssistantsForJob(job.id)
    .map((message) => messageSchema.parse(message))
  if (pending.length !== 1) {
    throw new Error('A non-terminal Chat Job must own exactly one pending assistant Message')
  }
  return pending[0]!
}

function reduceProjection(
  dependencies: ReconcileDependencies,
  association: ChatJobAssociation,
  pageLimit: number,
): RecoveryProjection {
  const pending = validateAssociation(dependencies, association)
  let cursor = 0
  let outputPages = 0
  let outputEvents = 0
  let activeMessageId: string | null = null
  let matchedStart = false
  let content = pending.content
  let thinking = pending.thinking
  let toolCalls = pending.toolCalls.slice()
  let usage: Usage | null = pending.usage
  let steps = 0

  while (true) {
    const page = dependencies.jobs.eventsAfter(association.job.id, cursor, pageLimit)
    if (page.length === 0) break
    outputPages += 1

    for (const event of page) {
      cursor = event.sequence
      if (TERMINAL.has(event.state)) {
        throw new Error('A non-terminal Chat Job contains a terminal event')
      }
      if (!event.output) continue
      outputEvents += 1
      const output = event.output.event

      if (output.type === 'start') {
        if (output.data.jobId && output.data.jobId !== association.job.id) {
          throw new Error('A recovered Chat start event belongs to another Job')
        }
        activeMessageId = output.data.messageId
        if (activeMessageId === pending.id) {
          if (matchedStart) throw new Error('A pending Chat Message has duplicate start events')
          matchedStart = true
          content = ''
          thinking = null
          toolCalls = []
          usage = null
          steps = Math.max(steps, output.data.step + 1)
        }
        continue
      }

      if (activeMessageId === null) {
        throw new Error('A recovered private Chat output precedes its start event')
      }
      if (activeMessageId !== pending.id) continue

      if (output.type === 'token') content += output.data.delta
      else if (output.type === 'thinking') thinking = `${thinking ?? ''}${output.data.delta}`
      else if (output.type === 'tool_call') upsertToolCall(toolCalls, output.data)
      else if (output.type === 'tool_approval_required') {
        upsertToolCall(toolCalls, output.data.toolCall)
      } else if (output.type === 'tool_result') applyToolResult(toolCalls, output.data)
      else if (output.type === 'usage') usage = output.data
      else if (output.type === 'done') {
        throw new Error('A non-terminal Chat Job contains a private terminal output')
      }
    }

    if (page.length < pageLimit) break
  }

  if (outputEvents > 0 && !matchedStart) {
    throw new Error('A pending Chat Message has no matching durable start event')
  }

  return {
    message: pending,
    update: {
      outcome: 'failed',
      error: {
        code: 'internal_error',
        message: 'The Chat execution was interrupted by an application restart',
      },
      stopReason: 'internal_error',
      content,
      thinking,
      toolCalls,
      usage,
    },
    steps,
    outputEvents,
    outputPages,
    matchedStart,
  }
}

function terminalOutput(
  projection: RecoveryProjection,
  outcome: 'failed' | 'cancelled',
): JobEventOutput {
  const cancelled = outcome === 'cancelled'
  return privateOutput({
    type: 'done',
    data: {
      messageId: projection.message.id,
      stopReason: cancelled ? 'stopped_by_user' : 'error',
      outcome,
      terminalStopReason: cancelled ? 'stopped_by_user' : 'internal_error',
      steps: projection.steps,
    },
  })
}

export function reconcileLostChatExecution(
  dependencies: ReconcileDependencies,
  association: ChatJobAssociation,
  options: Pick<ChatRecoveryOptions, 'outputPageSize' | 'checkpoint'> = {},
): { job: Job; outputPages: number; outcome: 'interrupted' | 'cancelled' | 'unchanged' } {
  const current = dependencies.jobService.get(association.job.id)
  if (!current) throw new Error('A recovery candidate disappeared')
  if (TERMINAL.has(current.status)) {
    return { job: current, outputPages: 0, outcome: 'unchanged' }
  }
  if (current.status !== 'cancelling' && !INTERRUPTED_STATES.has(current.status)) {
    throw new Error('A Chat recovery candidate has no safe terminal policy')
  }

  const outputPageSize = pageSize(
    options.outputPageSize,
    DEFAULT_CHAT_RECOVERY_OUTPUT_PAGE_SIZE,
    'outputPageSize',
  )
  const projection = reduceProjection(
    dependencies,
    { ...association, job: current },
    outputPageSize,
  )
  options.checkpoint?.({
    phase: 'before_terminal',
    jobId: current.id,
    previousState: current.status,
  })

  if (current.status === 'cancelling') {
    const result = dependencies.jobService.terminalizeChat({
      jobId: current.id,
      expectedStatus: 'cancelling',
      status: 'cancelled',
      messageId: projection.message.id,
      message: {
        ...projection.update,
        outcome: 'cancelled',
        error: null,
        stopReason: 'stopped_by_user',
      },
      outcome: {
        code: 'chat_cancelled',
        metadata: {
          messageId: projection.message.id,
          previousState: current.status,
          recoveryReason: 'application_restart',
        },
      },
      stopReason: 'user_requested',
      output: terminalOutput(projection, 'cancelled'),
    })
    if (!result.applied) {
      if (TERMINAL.has(result.job.status)) {
        return { job: result.job, outputPages: projection.outputPages, outcome: 'unchanged' }
      }
      throw new Error('A cancelling Chat Job changed during recovery')
    }
    return { job: result.job, outputPages: projection.outputPages, outcome: 'cancelled' }
  }

  const result = dependencies.jobService.terminalizeRecoveredChat({
    jobId: current.id,
    expectedStatus: current.status,
    status: 'interrupted',
    messageId: projection.message.id,
    message: projection.update,
    error: {
      category: 'internal',
      code: 'application_restart',
      message: 'The Chat execution was interrupted by an application restart',
      retryable: false,
    },
    outcome: {
      code: 'chat_interrupted',
      metadata: {
        messageId: projection.message.id,
        previousState: current.status,
        recoveryReason: 'application_restart',
      },
    },
    stopReason: 'application_restart',
    output: terminalOutput(projection, 'failed'),
  })
  if (!result.applied) {
    if (TERMINAL.has(result.job.status)) {
      return { job: result.job, outputPages: projection.outputPages, outcome: 'unchanged' }
    }
    throw new Error('An executing Chat Job changed during recovery')
  }
  return { job: result.job, outputPages: projection.outputPages, outcome: 'interrupted' }
}

function nextCursor(page: readonly ChatJobAssociation[]): ChatRecoveryCursor {
  const last = page.at(-1)
  if (!last) throw new Error('A recovery page did not contain a cursor')
  return { createdAt: last.job.createdAt, jobId: last.job.id }
}

function runRecovery(
  dependencies: ChatRecoveryDependencies,
  options: ChatRecoveryOptions,
): ChatRecoveryReport {
  const scanPageSize = pageSize(
    options.scanPageSize,
    DEFAULT_CHAT_RECOVERY_SCAN_PAGE_SIZE,
    'scanPageSize',
  )
  const outputPageSize = pageSize(
    options.outputPageSize,
    DEFAULT_CHAT_RECOVERY_OUTPUT_PAGE_SIZE,
    'outputPageSize',
  )
  const report: ChatRecoveryReport = {
    scanned: 0,
    scanPages: 0,
    outputPages: 0,
    queuedValidated: 0,
    queuedScheduled: 0,
    interrupted: 0,
    cancelled: 0,
  }

  let cursor: ChatRecoveryCursor | null = null
  while (true) {
    const page = dependencies.jobs.chatRecoveryPage(cursor, scanPageSize)
    if (page.length === 0) break
    report.scanPages += 1

    for (const association of page) {
      report.scanned += 1
      const current = dependencies.jobService.get(association.job.id)
      if (!current || TERMINAL.has(current.status)) continue

      if (current.status === 'queued') {
        const projection = reduceProjection(
          dependencies,
          { ...association, job: current },
          outputPageSize,
        )
        report.outputPages += projection.outputPages
        if (
          current.startedAt !== null ||
          current.phase !== null ||
          projection.outputEvents !== 0 ||
          projection.matchedStart
        ) {
          throw new Error('A queued Chat Job contains execution evidence')
        }
        report.queuedValidated += 1
        continue
      }

      const recovered = reconcileLostChatExecution(
        dependencies,
        { ...association, job: current },
        { outputPageSize, checkpoint: options.checkpoint },
      )
      report.outputPages += recovered.outputPages
      if (recovered.outcome === 'interrupted') report.interrupted += 1
      if (recovered.outcome === 'cancelled') report.cancelled += 1
    }

    cursor = nextCursor(page)
    options.checkpoint?.({ phase: 'scan_page', page: report.scanPages })
    if (page.length < scanPageSize) break
  }

  if (options.scheduleQueued === false) return report

  cursor = null
  let schedulePage = 0
  while (true) {
    const page = dependencies.jobs.chatRecoveryPage(cursor, scanPageSize)
    if (page.length === 0) break
    schedulePage += 1
    for (const association of page) {
      const current = dependencies.jobService.get(association.job.id)
      if (!current || current.status !== 'queued') {
        throw new Error('Unsafe Chat state appeared after startup reconciliation')
      }
      const projection = reduceProjection(
        dependencies,
        { ...association, job: current },
        outputPageSize,
      )
      report.outputPages += projection.outputPages
      if (
        current.startedAt !== null ||
        current.phase !== null ||
        projection.outputEvents !== 0 ||
        projection.matchedStart
      ) {
        throw new Error('A queued Chat Job became unsafe before scheduling')
      }
      dependencies.chatExecution.ensureStarted(current.id)
      report.queuedScheduled += 1
    }
    cursor = nextCursor(page)
    options.checkpoint?.({ phase: 'schedule_page', page: schedulePage })
    if (page.length < scanPageSize) break
  }

  return report
}

/**
 * Fail-closed application startup boundary. The public error deliberately has
 * no cause/details so SQLite text, prompts, provider bodies and paths cannot be
 * printed by the foreground CLI.
 */
export async function recoverChatJobs(
  dependencies: ChatRecoveryDependencies,
  options: ChatRecoveryOptions = {},
): Promise<ChatRecoveryReport> {
  try {
    return runRecovery(dependencies, options)
  } catch {
    throw new ChatRecoveryError()
  }
}
