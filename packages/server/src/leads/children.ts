import type { RelayService } from '../relay/plugin.ts'
import type { RelayStarts } from '../relay/start.ts'
import type { RunStore } from '../runs/store.ts'
import type { RelayStartStatus } from '@guanxi/contract'
import { TERMINAL_RUN_STATES } from '../runs/types.ts'
import { LeadError, type ChildHandle, type ChildLaunch, type ChildReport, type ChildReporter, type ChildStarter } from './types.ts'

const codeOf = (error: unknown): string => error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
/** Public relay statuses after which the relay run makes no further progress by itself. `wrapping_up` and
 * `input_required` are written only when the executor has RETURNED (a cap, a wall limit, no progress, a probe
 * failure, a stop): the ledger is final and nobody can resume the run. */
const SETTLED = new Set(['completed', 'canceled', 'failed', 'interrupted', 'wrapping_up', 'input_required'])

export interface RelayStartsChildStarter extends ChildStarter { start(launch: ChildLaunch): ChildHandle; stop(childRunId: string): Promise<void> }
export interface RelayStartsChildOptions {
  /** Owner choices a lead can never make for itself: Full-access consent and allowed domains. */
  consent: 'full-access'
  domains?: readonly string[]
  runs: Pick<RunStore, 'complete' | 'renew' | 'get'>
  /** Status poll interval; the mirror's lease is renewed on the same interval. Default 5 s, at most 30 s. */
  pollMs?: number
  /** Consecutive unreadable statuses tolerated before the mirror fails. Default 5. */
  maxStatusErrors?: number
  sleep?: (ms: number) => Promise<void>
}

/** Runs the delegated plan through the PUBLIC relay start (`RelayStarts`), keyed by the R1 child run id.
 *
 * `RelayStarts.start` always creates its own root run, so it cannot adopt the child that R1 `delegate`
 * created and promised. That child therefore stays the lead's promise (a mirror) and this adapter keeps it
 * in step with the relay run:
 * - the mirror's lease is renewed on an interval for the whole life of the start, including the (unbounded)
 *   preparation, so a healthy relay run is never orphaned by lease expiry;
 * - the mirror NEVER records a model start: the relay run owns the work, and re-attaching to it by key is idempotent, so
 *   the lead service may re-attach a lost mirror (bounded by its `childStartLimit`) without ever replaying work;
 * - the mirror completes with the relay run's outcome. A run that settles without finishing its plan
 *   (`wrapping_up` or `input_required` after a cap, a wall limit or no progress) and an `interrupted` one end the
 *   mirror as `failed`: the ledger is final and the lead hears about it once, with the relay status in the packet;
 * - when R1's deadline puts the mirror into `wrapping_up` the relay run is stopped (the default "cancel after
 *   wrap-up"), and canceling the lead stops it once through the lead service.
 * The start key is the child id, so a re-attach reaches the same relay run. After a node restart the relay reports its
 * run `interrupted` (it never resumes inference), which ends the re-attached mirror as `failed` at once. */
export function relayStartsChildStarter(starts: Pick<RelayStarts, 'start' | 'status' | 'stop'>, options: RelayStartsChildOptions): RelayStartsChildStarter {
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => { setTimeout(resolve, ms).unref() }))
  const pollMs = options.pollMs ?? 5_000
  const maxErrors = options.maxStatusErrors ?? 5
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 30_000 || !Number.isSafeInteger(maxErrors) || maxErrors < 0) throw new LeadError('invalid_input')
  const stopQuietly = async (key: string): Promise<void> => {
    try { await starts.stop(key) } catch (error) { if (codeOf(error) !== 'relay_not_found') throw error }
  }
  return {
    start(launch: ChildLaunch): ChildHandle {
      const key = launch.childRunId
      const done = (async () => {
        let lost = false
        const keepAlive = setInterval(() => {
          try { options.runs.renew(launch.attempt) } catch (error) { if (codeOf(error) === 'stale_lease') lost = true }
        }, pollMs)
        keepAlive.unref()
        try {
          let status: RelayStartStatus
          try {
            status = await starts.start({ key, projectId: launch.projectId, connectionId: launch.brief.executor.connectionId,
              model: launch.brief.executor.model, consent: options.consent, domains: [...(options.domains ?? [])],
              plan: launch.brief.plan, caps: launch.brief.caps })
          } catch (error) {
            // The lead was canceled while the relay prepared: the stop is the expected end, not a failure.
            if (codeOf(error) === 'relay_stopped') {
              if (lost || TERMINAL_RUN_STATES.has(options.runs.get(launch.childRunId).state)) return
              // The node is shutting down: restart reconciliation owns the mirror, it did not fail.
              try { starts.status(key) } catch (probe) { if (codeOf(probe) === 'relay_closed') return }
            }
            throw error
          }
          let stopRequested = false
          let errors = 0
          for (;;) {
            if (lost) return
            if (SETTLED.has(status.status)) {
              options.runs.complete(launch.attempt, status.status === 'completed' ? 'completed' : status.status === 'canceled' ? 'canceled' : 'failed')
              return
            }
            if (!stopRequested && options.runs.get(launch.childRunId).state === 'wrapping_up') {
              // Only a stop that went through counts; a refused one is retried on the next poll, bounded like status errors.
              try { await stopQuietly(key); stopRequested = true } catch (error) { if (++errors > maxErrors) throw error }
            }
            await sleep(pollMs)
            try { status = starts.status(key); errors = 0 } catch (error) {
              const why = codeOf(error)
              // The node is going down: restart reconciliation owns the mirror. A start that never existed, or
              // a status that stays unreadable, fails it.
              if (why === 'relay_closed') return
              if (why === 'relay_not_found') throw error
              if (++errors > maxErrors) {
                // Nobody can watch it any more: do not leave a Full-access run unobserved and unstopped.
                await stopQuietly(key).catch(() => undefined)
                throw error
              }
            }
          }
        } catch (error) {
          // The lead canceled or the mirror's lease was lost: the lead service stops the relay run; nothing to report.
          if (codeOf(error) === 'stale_lease') return
          throw error
        } finally { clearInterval(keepAlive) }
      })()
      return { done }
    },
    stop: stopQuietly,
  }
}

const reportOf = (ledger: ReturnType<RelayService['read']>, runId: string, relayStatus: string): ChildReport => {
  // The ledger's evidence is an append-only log of gate runs, and the relay re-proves every done item when the plan
  // closes. The lead is told each item's gate once: the newest result at the current head, in plan order.
  const latest = new Map<string, (typeof ledger.evidence)[number]>()
  for (const evidence of ledger.evidence) if (evidence.head === ledger.head) latest.set(evidence.item, evidence)
  const current = ledger.plan.items.flatMap(item => latest.get(item.id) ?? [])
  return {
    items: ledger.plan.items.map(item => ({ id: item.id, title: item.title, status: ledger.items[item.id] ?? 'open' })),
    gates: current.map(evidence => ({ item: evidence.item, ok: evidence.ok, head: evidence.head, output: evidence.output })),
    head: ledger.head, diffstat: ledger.diffstat, handoff: { ref: `relay:${runId}`, cycle: ledger.cycle },
    narrative: `relay run status: ${relayStatus}`, openQuestions: ledger.proposals,
    metrics: { cycles: ledger.cycle, tokens: ledger.tokens, moneyMicros: ledger.unknownCosts > 0 ? null : ledger.moneyMicros },
  }
}

/** Reads the relay ledger (a durable, scrubbed fact store) of the relay run started for a child, and nothing else. */
export function relayStartsChildReporter(starts: Pick<RelayStarts, 'status'>, relay: Pick<RelayService, 'read'>): ChildReporter {
  return {
    report(childRunId: string): ChildReport | null {
      try {
        const status = starts.status(childRunId)
        return status.runId ? reportOf(relay.read(status.runId), status.runId, status.status) : null
      } catch { return null }
    },
  }
}
