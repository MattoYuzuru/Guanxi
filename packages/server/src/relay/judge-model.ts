import type { Connections } from '../connections/service.ts'
import type { RuntimeMeter } from './model.ts'
import type { EgressScrubber } from '../egress/types.ts'
import { hash } from './handoff.ts'
import { invariant } from './types.ts'
import type { JudgeRole } from './delegation-brief.ts'
import { observeUntilAbort } from './judge-await.ts'

export interface JudgeModelInput {
  accountId: string
  role: JudgeRole
  signal: AbortSignal
}
export interface JudgeModel {
  /** Pure T0 inventory/consent/window observation. No model or permit may be started here. */
  admit(input: JudgeModelInput): Promise<boolean>
  /** Owns any started resource until this promise settles, including abort cleanup. */
  sample(
    input: JudgeModelInput & {
      runId: string
      requestId: string
      prompt: string
      check(): void
      started?(): void
    }
  ): Promise<string>
}
export interface InstalledJudgeAttestation {
  accountId: string
  connectionId: string
  model: string
  placement: 'installed-local'
  digest: string
  source: string
  observedAt: number
  confidence: 'high'
  unattended: true
}
/** Explicit account scope and host inventory are required. Neither a local_runtime kind nor
 * a model-name suffix proves local placement. No cloud/API fallback exists in this adapter. */
export class ConnectionJudgeModel implements JudgeModel {
  private readonly admitted = new Map<
    string,
    { fact: InstalledJudgeAttestation; window: Awaited<ReturnType<RuntimeMeter['observe']>> }
  >()
  private readonly connections: Connections
  private readonly ownerAccountId: string
  private readonly meter: RuntimeMeter & { readonly countIsExact: true }
  private readonly scrubber: EgressScrubber
  private readonly attest: (input: JudgeModelInput) => Promise<InstalledJudgeAttestation | null>
  private readonly maxAgeMs: number
  private readonly now: () => number
  constructor(
    connections: Connections,
    ownerAccountId: string,
    meter: RuntimeMeter & { readonly countIsExact: true },
    scrubber: EgressScrubber,
    attest: (input: JudgeModelInput) => Promise<InstalledJudgeAttestation | null>,
    maxAgeMs: number,
    now = Date.now
  ) {
    this.connections = connections
    this.ownerAccountId = ownerAccountId
    this.meter = meter
    this.scrubber = scrubber
    this.attest = attest
    this.maxAgeMs = maxAgeMs
    this.now = now
    invariant(
      meter.countIsExact === true &&
        ownerAccountId.trim() &&
        Number.isSafeInteger(maxAgeMs) &&
        maxAgeMs >= 0,
      'judge_config_invalid'
    )
  }
  private fact(input: JudgeModelInput, fact: InstalledJudgeAttestation): void {
    invariant(
      input.accountId === this.ownerAccountId &&
        fact.accountId === input.accountId &&
        fact.connectionId === input.role.connectionId &&
        fact.model === input.role.model &&
        fact.placement === 'installed-local' &&
        fact.unattended === true &&
        fact.confidence === 'high' &&
        /^[a-f0-9]{64}$/.test(fact.digest) &&
        fact.source.trim() &&
        fact.observedAt <= this.now() &&
        this.now() - fact.observedAt <= this.maxAgeMs &&
        !input.role.model.endsWith(':cloud'),
      'judge_local_unavailable'
    )
    const connection = this.connections
      .snapshot(this.ownerAccountId)
      .connections.find((c) => c.id === input.role.connectionId)
    invariant(
      connection?.kind === 'local_runtime' && connection.unattended,
      'judge_local_unavailable'
    )
  }
  private window(
    input: JudgeModelInput,
    window: Awaited<ReturnType<RuntimeMeter['observe']>>
  ): void {
    invariant(
      window.tokens === input.role.windowTokens &&
        window.source.trim() &&
        window.confidence === 'high' &&
        Number.isSafeInteger(window.observedAt) &&
        window.observedAt >= 0 &&
        Number.isSafeInteger(this.now()) &&
        window.observedAt <= this.now() &&
        this.now() - window.observedAt <= this.maxAgeMs,
      'judge_window_unknown'
    )
  }
  async admit(input: JudgeModelInput): Promise<boolean> {
    input.signal.throwIfAborted()
    invariant(input.accountId === this.ownerAccountId, 'judge_account_denied')
    const fact = await observeUntilAbort(input.signal, () => this.attest(input))
    if (!fact) return false
    this.fact(input, fact)
    const window = await observeUntilAbort(input.signal, () => this.meter.observe(input.signal))
    this.window(input, window)
    input.signal.throwIfAborted()
    this.admitted.set(hash({ account: input.accountId, role: input.role }), {
      fact: { ...fact },
      window: { ...window }
    })
    return true
  }
  async sample(input: Parameters<JudgeModel['sample']>[0]): Promise<string> {
    const admission = this.admitted.get(hash({ account: input.accountId, role: input.role }))
    invariant(admission, 'judge_local_unavailable')
    input.signal.throwIfAborted()
    input.check()
    this.fact(input, admission.fact)
    this.window(input, admission.window)
    invariant(this.scrubber.isReady(), 'egress_not_ready')
    const prompt = this.scrubber.scrub(input.prompt)
    let dispatchedInput: number | undefined
    const result = await this.connections.localChat(
      this.ownerAccountId,
      input.role.connectionId,
      {
        model: input.role.model,
        stream: false,
        messages: [{ role: 'user', content: prompt }],
        options: {
          num_ctx: admission.window.tokens,
          num_predict: input.role.maxOutputTokens,
          temperature: input.role.temperature
        }
      },
      {
        runId: input.runId,
        requestId: input.requestId,
        background: true,
        singleAttempt: true,
        signal: input.signal,
        onPrepared: (request) => {
          input.signal.throwIfAborted()
          input.check()
          this.fact(input, admission.fact)
          invariant(
            request.messages.length === 1 &&
              request.messages[0]!.role === 'user' &&
              typeof request.messages[0]!.content === 'string',
            'judge_request_shape'
          )
          const count = this.meter.count(request.messages[0]!.content as string)
          invariant(
            Number.isSafeInteger(count) && count >= 0 && count <= input.role.maxInputTokens,
            'judge_context_ceiling'
          )
          // Counter callbacks are T0 but may observe time/fence changes. The last
          // synchronous check follows counting, immediately before K3 dispatch.
          input.signal.throwIfAborted()
          input.check()
          this.fact(input, admission.fact)
          this.window(input, admission.window)
          dispatchedInput = count
        },
        onStarted: () => {
          input.check()
          input.started?.()
        }
      }
    )
    input.signal.throwIfAborted()
    input.check()
    invariant(
      Number.isSafeInteger(result.prompt_eval_count) &&
        result.prompt_eval_count === dispatchedInput &&
        result.prompt_eval_count! >= 0 &&
        result.prompt_eval_count! <= input.role.maxInputTokens &&
        Number.isSafeInteger(result.eval_count) &&
        result.eval_count! >= 0 &&
        result.eval_count! <= input.role.maxOutputTokens &&
        result.done_reason !== 'length',
      'judge_usage_invalid'
    )
    return this.scrubber.scrub(result.message?.content ?? '')
  }
}
