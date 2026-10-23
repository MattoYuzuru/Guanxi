import type { Connections } from '../connections/service.ts'
import type { RuntimeMeter } from './model.ts'
import type { EgressScrubber } from '../egress/types.ts'
import { canonical, hash } from './handoff.ts'
import type { OllamaChatRequest } from '../ollama/types.ts'
import { invariant } from './types.ts'
import type { JudgeRole } from './delegation-brief.ts'
import { observeUntilAbort } from './judge-await.ts'
import { normalizeOllamaModelReference } from '../runtime/observation-key.ts'

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
/** The one runtime that counts and serves a transport-carrying meter (R2-op llama-server, F2-d remote node). The judge
 * dispatches through that meter's own transport, so a role must name the same connection and the same model, or the
 * count would be made by one runtime and the request run on another. */
export interface JudgeRuntimeBinding {
  connectionId: string
  model: string
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
  private readonly runtime?: JudgeRuntimeBinding
  constructor(
    connections: Connections,
    ownerAccountId: string,
    meter: RuntimeMeter & { readonly countIsExact: true },
    scrubber: EgressScrubber,
    attest: (input: JudgeModelInput) => Promise<InstalledJudgeAttestation | null>,
    maxAgeMs: number,
    now = Date.now,
    runtime?: JudgeRuntimeBinding
  ) {
    this.connections = connections
    this.ownerAccountId = ownerAccountId
    this.meter = meter
    this.scrubber = scrubber
    this.attest = attest
    this.maxAgeMs = maxAgeMs
    this.now = now
    this.runtime = runtime ? { connectionId: runtime.connectionId, model: runtime.model } : undefined
    invariant(
      meter.countIsExact === true &&
        // A stock Ollama meter is counted and served by the Ollama path K3 uses by default. A meter that names a
        // runtime transport (llama-server, remote node) is counted and served by that runtime, so the judge
        // dispatches through the same transport and only for the one connection and model that runtime serves.
        // An asynchronous counter without its transport would be counted by one runtime and run on another.
        (meter.transport
          ? Boolean(this.runtime?.connectionId.trim()) && normalizeOllamaModelReference(this.runtime?.model ?? '') !== null
          : !meter.countAsync) &&
        ownerAccountId.trim() &&
        Number.isSafeInteger(maxAgeMs) &&
        maxAgeMs >= 0,
      'judge_config_invalid'
    )
  }
  /** With a runtime binding, the role must be exactly the connection and model that runtime serves: the string that is sent
   * is the string the relay itself sends, and the transport's counter is the one that counted it. */
  private bound(role: JudgeRole): void {
    if (!this.runtime) return
    invariant(role.connectionId === this.runtime.connectionId && role.model === this.runtime.model, 'judge_config_invalid')
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
  /** The attestation and the loaded window were observed at admission, and one admission serves every sample of a request.
   * A runtime that takes longer than `maxAgeMs` for a few samples (a remote llama-server at a few tokens per second) would
   * otherwise find its own admission stale at the second sample. Past half the allowed age they are observed again. */
  private stale(admission: { fact: InstalledJudgeAttestation; window: Awaited<ReturnType<RuntimeMeter['observe']>> }): boolean {
    return this.now() - Math.min(admission.fact.observedAt, admission.window.observedAt) > this.maxAgeMs / 2
  }
  /** A fresh observation of the same runtime: same digest, same loaded window, same source. A different one is not refreshed
   * but refused, and the new observations are validated exactly like the admission's. */
  private async refresh(input: JudgeModelInput, admission: { fact: InstalledJudgeAttestation; window: Awaited<ReturnType<RuntimeMeter['observe']>> }): Promise<void> {
    const fact = await observeUntilAbort(input.signal, () => this.attest(input))
    invariant(fact, 'judge_local_unavailable')
    this.fact(input, fact)
    invariant(fact.digest === admission.fact.digest, 'judge_local_unavailable')
    const window = await observeUntilAbort(input.signal, () => this.meter.observe(input.signal))
    this.window(input, window)
    invariant(window.tokens === admission.window.tokens && window.source === admission.window.source, 'judge_window_unknown')
    input.signal.throwIfAborted()
    admission.fact = { ...fact }
    admission.window = { ...window }
  }
  async admit(input: JudgeModelInput): Promise<boolean> {
    input.signal.throwIfAborted()
    invariant(input.accountId === this.ownerAccountId, 'judge_account_denied')
    this.bound(input.role)
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
    this.bound(input.role)
    input.signal.throwIfAborted()
    input.check()
    if (this.stale(admission)) {
      await this.refresh(input, admission)
      input.check()
    }
    this.fact(input, admission.fact)
    this.window(input, admission.window)
    invariant(this.scrubber.isReady(), 'egress_not_ready')
    const prompt = this.scrubber.scrub(input.prompt)
    const transport = this.meter.transport
    // A relay runtime (a binding, or a local-only exact meter) renders and counts the `think:false` form of the request, as
    // the relay's own calls do. A judge request without it would be counted in one form and evaluated in another.
    const pinned = Boolean(transport || this.runtime || this.meter.localOnly)
    const options = {
      num_ctx: admission.window.tokens,
      num_predict: input.role.maxOutputTokens,
      temperature: input.role.temperature
    }
    if (transport && this.meter.countAsync) {
      // The exact answer needs a round trip to the runtime that will serve the request. It is obtained before the
      // dispatch path starts, and `meter.count` below is then only a lookup of this answer for the identical string.
      const known = await observeUntilAbort(input.signal, () => this.meter.countAsync!(prompt, input.signal))
      invariant(
        Number.isSafeInteger(known) && known >= 0 && known <= input.role.maxInputTokens,
        'judge_context_ceiling'
      )
      input.signal.throwIfAborted()
      input.check()
    }
    let dispatchedInput: number | undefined
    const result = await this.connections.localChat(
      this.ownerAccountId,
      input.role.connectionId,
      {
        model: input.role.model,
        stream: false,
        ...(pinned ? { think: false } : {}),
        messages: [{ role: 'user', content: prompt }],
        options
      },
      {
        runId: input.runId,
        requestId: input.requestId,
        background: true,
        singleAttempt: true,
        signal: input.signal,
        ...(transport ? { transport } : {}),
        // The runtime is observed again (identity, window) immediately before it is asked to evaluate, as for a relay call.
        ...(pinned
          ? {
              authorizeDispatch: async () => {
                await this.meter.authorizeDispatch?.(input.signal)
                input.signal.throwIfAborted()
                input.check()
                // The count of a slow remote string may have used up the admission's age.
                if (this.stale(admission)) await this.refresh(input, admission)
                input.check()
              }
            }
          : {}),
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
          // The relay meter's `validatePrepared` pins the relay turn's output limit, which is not the judge's. The
          // judge's own request is therefore pinned here, exactly, for the runtime that counts it.
          if (pinned) {
            const chat = request as OllamaChatRequest
            invariant(
              chat.model === input.role.model &&
                chat.stream === false &&
                chat.think === false &&
                canonical(chat.options) === canonical(options),
              'judge_request_shape'
            )
          }
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
