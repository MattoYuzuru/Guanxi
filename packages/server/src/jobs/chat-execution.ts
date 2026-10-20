import { createHash, randomUUID } from 'node:crypto'
import type {
  ChatJobInputSnapshot,
  ChatJobOutput,
  ChatStreamEvent,
  Job,
  JobCancelReason,
  JobError,
  JobEventOutput,
  JobState,
  Message,
  TurnError,
} from '@guanxi/contract'
import { runTurn, TURN_ABORT_REASON } from '../agent/loop.ts'
import type { ApprovalGate } from '../agent/approvals.ts'
import type { PrefillTracker } from '../context/usage.ts'
import type { ModelService } from '../models/service.ts'
import type { OllamaClient } from '../ollama/client.ts'
import {
  RESOURCE_GOVERNOR_CLOSE_REASON,
  type AdmissionTicket,
  type ResourceGovernor,
  type ResourceLease,
} from '../runtime/resource-governor.ts'
import type { JobStore, ChatJobAssociation, CreateChatJobResult } from '../store/jobs.ts'
import type { SettingsStore } from '../store/settings.ts'
import type {
  TerminalMessageResult,
  TerminalMessageUpdate,
  ThreadStore,
} from '../store/threads.ts'
import type { WorkspaceStore } from '../store/workspaces.ts'
import { ToolRegistry } from '../tools/registry.ts'
import { recoverChatJobs, reconcileLostChatExecution } from './chat-recovery.ts'
import { JobService } from './service.ts'

export const CHAT_JOB_OPERATION = 'chat'
export const CHAT_OUTPUT_CHUNK_BYTES = 16 * 1024

const TERMINAL = new Set<JobState>(['completed', 'failed', 'cancelled', 'interrupted'])

export interface ChatExecutionDependencies {
  jobs: JobStore
  jobService: JobService
  threads: ThreadStore
  workspaces: WorkspaceStore
  settings: SettingsStore
  approvals: ApprovalGate
  tracker: PrefillTracker
  governor: ResourceGovernor
  /** Compatibility mirror only; controllers remain owned by this class by jobId. */
  activeTurns: Map<string, AbortController>
  ollama(): OllamaClient
  models(): ModelService
}

interface ActiveExecution {
  controller: AbortController
  threadId: string
  task: Promise<void>
}

interface DeferredTerminal {
  messageId: string
  update: TerminalMessageUpdate
}

export function chatIdempotencyScope(threadId: string): string {
  return `chat:${threadId}:send:v1`
}

export function chatRequestFingerprint(input: ChatJobInputSnapshot): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

function privateOutput(event: ChatJobOutput): JobEventOutput {
  return { privacyClassification: 'private_chat', event }
}

function withoutSequence(event: ChatStreamEvent): ChatJobOutput {
  return { type: event.type, data: event.data } as ChatJobOutput
}

function projectedMessage(message: Message, update: TerminalMessageUpdate): Message {
  return {
    ...message,
    content: update.content,
    thinking: update.thinking,
    toolCalls: update.toolCalls,
    usage: update.usage,
    turnStatus: update.outcome,
    turnError: update.error,
    stopReason: update.stopReason,
  }
}

function safeJobError(error: TurnError | null): JobError {
  if (!error) {
    return {
      category: 'internal',
      code: 'chat_execution_failed',
      message: 'The Chat execution did not reach a valid terminal projection',
      retryable: false,
    }
  }
  const category: JobError['category'] =
    error.code === 'runtime_protocol'
      ? 'runtime_protocol'
      : error.code === 'ollama_unavailable' || error.code.startsWith('ollama_') || error.code === 'upstream_error'
        ? 'runtime_unavailable'
        : error.code === 'storage_error'
          ? 'storage'
          : 'internal'
  return { category, code: error.code, message: error.message, retryable: category !== 'internal' }
}

function splitUtf8(value: string, maxBytes: number): string[] {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return [value]
  const chunks: string[] = []
  let current = ''
  let currentBytes = 0
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (current && currentBytes + bytes > maxBytes) {
      chunks.push(current)
      current = ''
      currentBytes = 0
    }
    current += character
    currentBytes += bytes
  }
  if (current) chunks.push(current)
  return chunks
}

/** Process-local owner: durable execution outlives every HTTP subscriber, not the process. */
export class ChatJobExecutionOwner {
  private readonly active = new Map<string, ActiveExecution>()
  private readonly dependencies: ChatExecutionDependencies
  private shuttingDown = false

  constructor(dependencies: ChatExecutionDependencies) {
    this.dependencies = dependencies
  }

  createAndStart(input: {
    threadId: string
    idempotencyKey?: string
    snapshot: ChatJobInputSnapshot
    derivedTitle: string
  }): CreateChatJobResult {
    const idempotencyKey = input.idempotencyKey ?? randomUUID()
    const result = this.dependencies.jobService.createChat({
      threadId: input.threadId,
      idempotencyScope: chatIdempotencyScope(input.threadId),
      idempotencyKey,
      requestFingerprint: chatRequestFingerprint(input.snapshot),
      input: input.snapshot,
      derivedTitle: input.derivedTitle,
    })
    this.ensureStarted(result.job.id)
    return result
  }

  ensureStarted(jobId: string): void {
    if (this.shuttingDown || this.active.has(jobId)) return
    const association = this.dependencies.jobs.chatInput(jobId)
    if (
      !association ||
      association.job.status !== 'queued' ||
      association.job.startedAt !== null
    ) {
      return
    }

    const controller = new AbortController()
    const task = Promise.resolve()
      .then(() => this.execute(association, controller))
      .catch(() => {
        // execute() converts reachable failures into durable safe state. A
        // permanent SQLite failure intentionally remains observable for P1-E.
      })
      .finally(() => {
        const current = this.active.get(jobId)
        if (current?.controller === controller) this.active.delete(jobId)
        if (this.dependencies.activeTurns.get(association.threadId) === controller) {
          this.dependencies.activeTurns.delete(association.threadId)
        }
      })

    this.active.set(jobId, { controller, threadId: association.threadId, task })
    this.dependencies.activeTurns.set(association.threadId, controller)
  }

  async cancel(jobId: string, reason: JobCancelReason): Promise<Job> {
    const association = this.dependencies.jobs.chatInput(jobId)
    if (!association) return this.dependencies.jobService.cancel(jobId, reason)

    while (true) {
      const current = this.dependencies.jobService.get(jobId)
      if (!current) throw new Error('Job not found')
      if (TERMINAL.has(current.status)) return current
      if (current.status === 'cancelling') {
        this.active.get(jobId)?.controller.abort(TURN_ABORT_REASON.explicitStop)
        return current
      }

      if (current.status === 'queued') {
        const transition = this.dependencies.jobService.transition({
          jobId,
          expectedStatus: 'queued',
          status: 'cancelling',
          phase: 'cancel_requested',
          metadata: { stopReason: reason },
        })
        if (!transition.applied) continue
        this.active.get(jobId)?.controller.abort(TURN_ABORT_REASON.explicitStop)
        return this.confirmCancellation(association, reason)
      }

      const cancelling = this.dependencies.jobService.cancel(jobId, reason)
      this.active.get(jobId)?.controller.abort(TURN_ABORT_REASON.explicitStop)
      return cancelling
    }
  }

  async cancelThread(threadId: string): Promise<Job | null> {
    const association = this.dependencies.jobs.activeChatJobForThread(threadId)
    if (!association) return null
    return this.cancel(association.job.id, 'user_requested')
  }

  isThreadActive(threadId: string): boolean {
    return this.dependencies.jobs.activeChatJobForThread(threadId) !== null
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const executions = [...this.active.values()]
    for (const execution of executions) {
      execution.controller.abort(TURN_ABORT_REASON.applicationShutdown)
    }
    const governorClosed = this.dependencies.governor.close()
    await Promise.all(executions.map((execution) => execution.task))
    await governorClosed
    await recoverChatJobs(
      {
        jobs: this.dependencies.jobs,
        jobService: this.dependencies.jobService,
        threads: this.dependencies.threads,
        chatExecution: this,
      },
      { scheduleQueued: false },
    )
  }

  private async execute(
    association: ChatJobAssociation,
    controller: AbortController,
  ): Promise<void> {
    let ticket: AdmissionTicket | undefined
    let lease: ResourceLease | undefined
    let deferred: DeferredTerminal | null = null
    let terminalOutput: ChatJobOutput | null = null

    try {
      if (controller.signal.aborted) return
      const thread = this.dependencies.threads.get(association.threadId)
      if (!thread) throw new Error('The Chat thread was removed before execution')

      const reserved = this.dependencies.jobService.transition({
        jobId: association.job.id,
        expectedStatus: 'queued',
        status: 'reserving',
        phase: 'resource_admission',
        metadata: { threadId: association.threadId },
      })
      if (!reserved.applied) {
        if (reserved.job.status === 'cancelling') {
          this.confirmCancellation(association, 'user_requested')
        }
        return
      }

      ticket = this.dependencies.governor.enqueue({
        owner: { kind: 'job', jobId: association.job.id },
        operation: 'chat',
        model: { provider: 'ollama', name: thread.model },
        requestedContext: thread.options.numCtx,
        priority: 'normal',
        enqueuedAt: new Date().toISOString(),
      })
      lease = await this.dependencies.governor.acquire(ticket, {
        signal: controller.signal,
        abortOwner: () => controller.abort(RESOURCE_GOVERNOR_CLOSE_REASON),
      })
      if (controller.signal.aborted) {
        this.confirmCancellation(association, 'user_requested')
        return
      }

      const loading = this.dependencies.jobService.transition({
        jobId: association.job.id,
        expectedStatus: 'reserving',
        status: 'loading',
        phase: 'provider_connect',
        metadata: {},
      })
      if (!loading.applied) {
        if (loading.job.status === 'cancelling') {
          this.confirmCancellation(association, 'user_requested')
        }
        return
      }

      const workspace = thread.workspaceId
        ? this.dependencies.workspaces.get(thread.workspaceId)
        : null
      if (thread.workspaceId && !workspace) {
        throw new Error('The Chat workspace was removed before execution')
      }
      if (workspace) this.dependencies.workspaces.touch(workspace.id)

      const settings = this.dependencies.settings.get()
      const registry = new ToolRegistry({
        hasWorkspace: thread.mode === 'agent' && workspace !== null,
        enableBash: settings.enableBash,
      })
      const modelSupportsTools = await this.dependencies.models().supportsTools(thread.model).catch(() => false)

      for await (const event of runTurn({
        thread,
        workspace,
        client: this.dependencies.ollama(),
        store: this.dependencies.threads,
        registry,
        approvals: this.dependencies.approvals,
        tracker: this.dependencies.tracker,
        modelSupportsTools,
        autoApprove: association.input.autoApprove ?? settings.autoApproveTools,
        enableBash: settings.enableBash,
        signal: controller.signal,
        jobId: association.job.id,
        initialAssistantMessageId: association.assistantMessageId,
        terminalizeMessage: (messageId, update) => {
          if (update.stopReason === 'tool_calls') {
            return this.dependencies.threads.terminalizeMessage(messageId, update)
          }
          const message = this.dependencies.threads.getMessage(messageId)
          if (!message) throw new Error('The final assistant projection is unavailable')
          deferred = { messageId, update }
          return { applied: true, message: projectedMessage(message, update) }
        },
      })) {
        const output = withoutSequence(event)
        if (event.type === 'done') {
          terminalOutput = output
          continue
        }
        await this.advanceForOutput(association.job.id, output)
        this.persistOutput(association.job.id, output)
      }

      if (!deferred || !terminalOutput || terminalOutput.type !== 'done') {
        throw new Error('The Chat execution ended without a terminal projection')
      }
      if (controller.signal.reason === TURN_ABORT_REASON.applicationShutdown) {
        reconcileLostChatExecution(this.dependencies, association)
        return
      }
      this.finish(association, deferred, terminalOutput)
    } catch {
      this.finishUnexpectedFailure(association, controller.signal)
    } finally {
      lease?.release()
      if (!lease && ticket) this.dependencies.governor.cancel(ticket)
    }
  }

  private persistOutput(jobId: string, output: ChatJobOutput): void {
    const outputs =
      output.type === 'token' || output.type === 'thinking'
        ? splitUtf8(output.data.delta, CHAT_OUTPUT_CHUNK_BYTES).map((delta) => ({
            ...output,
            data: { delta },
          }) as ChatJobOutput)
        : [output]

    for (const event of outputs) {
      while (true) {
        const job = this.dependencies.jobService.get(jobId)
        if (!job || TERMINAL.has(job.status) || job.status === 'cancelling') return
        try {
          this.dependencies.jobService.appendSafeEvent({
            jobId,
            expectedNextSequence: job.lastEventSequence + 1,
            type: event.type === 'error' ? 'error' : 'output',
            metadata: {
              channel: event.type,
              bytes: Buffer.byteLength(JSON.stringify(event), 'utf8'),
            },
            output: privateOutput(event),
          })
          break
        } catch {
          const current = this.dependencies.jobService.get(jobId)
          if (!current || current.lastEventSequence === job.lastEventSequence) throw new Error('Job output persistence failed')
        }
      }
    }
  }

  private async advanceForOutput(jobId: string, output: ChatJobOutput): Promise<void> {
    if (output.type === 'start') return
    if (output.type === 'thinking') {
      this.advanceTo(jobId, 'prefill')
      this.advanceTo(jobId, 'thinking')
      return
    }
    if (output.type === 'token') {
      this.advanceTo(jobId, 'prefill')
      this.advanceTo(jobId, 'generating')
      return
    }
    if (output.type === 'tool_call') {
      this.advanceTo(jobId, 'prefill')
      this.advanceTo(jobId, 'generating')
      this.advanceTo(jobId, 'waiting_tool')
      return
    }
    if (output.type === 'tool_approval_required') {
      this.advanceTo(jobId, 'waiting_approval')
      return
    }
    if (output.type === 'tool_result') {
      const job = this.dependencies.jobService.get(jobId)
      if (job?.status === 'waiting_approval') this.advanceTo(jobId, 'waiting_tool')
    }
  }

  private advanceTo(jobId: string, target: JobState): Job | null {
    while (true) {
      const current = this.dependencies.jobService.get(jobId)
      if (!current || TERMINAL.has(current.status) || current.status === 'cancelling') return current
      if (current.status === target) return current

      let next: JobState | null = null
      if (target === 'prefill' && (current.status === 'loading' || current.status === 'waiting_tool')) {
        next = 'prefill'
      } else if (target === 'thinking' && current.status === 'prefill') {
        next = 'thinking'
      } else if (
        target === 'generating' &&
        (current.status === 'prefill' || current.status === 'thinking')
      ) {
        next = 'generating'
      } else if (target === 'waiting_tool' && current.status === 'generating') {
        next = 'waiting_tool'
      } else if (target === 'waiting_tool' && current.status === 'waiting_approval') {
        next = 'waiting_tool'
      } else if (target === 'waiting_approval' && current.status === 'waiting_tool') {
        next = 'waiting_approval'
      } else if (target === 'finalizing') {
        if (current.status === 'loading' || current.status === 'waiting_tool') next = 'prefill'
        else if (current.status === 'prefill' || current.status === 'thinking') next = 'generating'
        else if (current.status === 'generating') next = 'finalizing'
      }
      if (!next) return current

      const transitioned = this.dependencies.jobService.transition({
        jobId,
        expectedStatus: current.status,
        status: next,
        phase: next === 'prefill' ? 'prompt_processing' : next,
        metadata: {},
      })
      if (!transitioned.applied) continue
      if (transitioned.job.status === target) return transitioned.job
    }
  }

  private finish(
    association: ChatJobAssociation,
    deferred: DeferredTerminal,
    done: Extract<ChatJobOutput, { type: 'done' }>,
  ): Job {
    const outcome = done.data.outcome ?? deferred.update.outcome
    if (outcome === 'cancelled') {
      const current = this.dependencies.jobService.get(association.job.id)
      if (current && current.status !== 'cancelling' && !TERMINAL.has(current.status)) {
        this.dependencies.jobService.cancel(association.job.id, 'user_requested')
      }
      return this.terminalizeProjection(
        association.job.id,
        'cancelling',
        'cancelled',
        deferred,
        done,
        null,
      )
    }

    if (outcome === 'completed') {
      const finalizing = this.advanceTo(association.job.id, 'finalizing')
      if (!finalizing || finalizing.status !== 'finalizing') {
        throw new Error('The Chat Job could not enter finalizing')
      }
      return this.terminalizeProjection(
        association.job.id,
        'finalizing',
        'completed',
        deferred,
        done,
        null,
      )
    }

    const current = this.dependencies.jobService.get(association.job.id)
    if (!current || TERMINAL.has(current.status)) return current ?? association.job
    return this.terminalizeProjection(
      association.job.id,
      current.status,
      'failed',
      deferred,
      done,
      safeJobError(deferred.update.error),
    )
  }

  private terminalizeProjection(
    jobId: string,
    expectedStatus: JobState,
    status: 'completed' | 'failed' | 'cancelled',
    deferred: DeferredTerminal,
    done: Extract<ChatJobOutput, { type: 'done' }>,
    error: JobError | null,
  ): Job {
    const result = this.dependencies.jobService.terminalizeChat({
      jobId,
      expectedStatus,
      status,
      messageId: deferred.messageId,
      message: deferred.update,
      error,
      outcome:
        status === 'failed'
          ? null
          : { code: `chat_${status}`, metadata: { messageId: deferred.messageId } },
      stopReason: deferred.update.stopReason,
      output: privateOutput(done),
    })
    return result.job
  }

  private confirmCancellation(association: ChatJobAssociation, reason: JobCancelReason): Job {
    const pending =
      this.dependencies.threads.latestPendingAssistantForJob(association.job.id) ??
      this.dependencies.threads.getMessage(association.assistantMessageId)
    if (!pending) throw new Error('The cancelled Chat projection is unavailable')
    const update: TerminalMessageUpdate = {
      outcome: 'cancelled',
      error: null,
      stopReason: 'stopped_by_user',
      content: pending.content,
      thinking: pending.thinking,
      toolCalls: pending.toolCalls,
      usage: pending.usage,
    }
    const done: Extract<ChatJobOutput, { type: 'done' }> = {
      type: 'done',
      data: {
        messageId: pending.id,
        stopReason: 'stopped_by_user',
        outcome: 'cancelled',
        terminalStopReason: 'stopped_by_user',
        steps: 0,
      },
    }
    return this.terminalizeProjection(
      association.job.id,
      'cancelling',
      'cancelled',
      { messageId: pending.id, update },
      done,
      null,
    )
  }

  private finishUnexpectedFailure(association: ChatJobAssociation, signal: AbortSignal): void {
    const current = this.dependencies.jobService.get(association.job.id)
    if (!current || TERMINAL.has(current.status)) return
    if (
      signal.reason === TURN_ABORT_REASON.applicationShutdown ||
      signal.reason === RESOURCE_GOVERNOR_CLOSE_REASON
    ) {
      reconcileLostChatExecution(this.dependencies, association)
      return
    }
    if (current.status === 'cancelling' || signal.aborted) {
      if (current.status !== 'cancelling') {
        try {
          this.dependencies.jobService.cancel(association.job.id, 'user_requested')
        } catch {
          return
        }
      }
      try {
        this.confirmCancellation(association, 'user_requested')
      } catch {
        // Permanent storage failure remains a non-terminal recovery signal.
      }
      return
    }

    const pending = this.dependencies.threads.latestPendingAssistantForJob(association.job.id)
    if (!pending) return
    const turnError: TurnError = {
      code: 'internal_error',
      message: 'The durable Chat execution could not be finalized',
    }
    const update: TerminalMessageUpdate = {
      outcome: 'failed',
      error: turnError,
      stopReason: 'internal_error',
      content: pending.content,
      thinking: pending.thinking,
      toolCalls: pending.toolCalls,
      usage: pending.usage,
    }
    const done: Extract<ChatJobOutput, { type: 'done' }> = {
      type: 'done',
      data: {
        messageId: pending.id,
        stopReason: 'error',
        outcome: 'failed',
        terminalStopReason: 'internal_error',
        steps: 0,
      },
    }
    try {
      this.terminalizeProjection(
        association.job.id,
        current.status,
        'failed',
        { messageId: pending.id, update },
        done,
        safeJobError(turnError),
      )
    } catch {
      // Permanent storage failure leaves Job/Message non-terminal and observable.
    }
  }
}
