import type { RelayService } from '../relay/plugin.ts'
import type { RelayStarts } from '../relay/start.ts'
import type { RunStore } from '../runs/store.ts'
import type { ChildHandle, ChildLaunch, ChildReport, ChildReporter, ChildStarter } from './types.ts'

/** Terminal public statuses of a relay start (`RelayStartStatus.status`). */
const codeOf = (error: unknown): string => error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
const TERMINAL = new Set(['completed', 'canceled', 'failed', 'interrupted'])

export interface RelayStartsChildStarter extends ChildStarter { start(launch: ChildLaunch): ChildHandle; stop(childRunId: string): Promise<void> }
export interface RelayStartsChildOptions {
  /** Owner choices a lead can never make for itself: Full-access consent and allowed domains. */
  consent: 'full-access'
  domains?: readonly string[]
  runs: Pick<RunStore, 'complete' | 'signal' | 'renew' | 'modelStarted'>
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** Runs the delegated plan through the PUBLIC relay start (`RelayStarts`), keyed by the R1 child run id.
 *
 * `RelayStarts.start` always creates its own root run, so it cannot adopt the child that R1 `delegate`
 * created and promised. That child therefore stays the lead's promise (a mirror) and this adapter keeps it
 * in step with the relay run: it renews the mirror's lease, marks work started once the relay run left
 * preparation, raises one escalation when the relay run needs input, and completes the mirror with the relay
 * run's outcome. The start key is the child id, so a retry after a restart re-attaches to the same relay run
 * instead of starting a second one; a relay run the restart interrupted completes the mirror as failed
 * (the relay never resumes inference after a restart). */
export function relayStartsChildStarter(starts: Pick<RelayStarts, 'start' | 'status' | 'stop'>, options: RelayStartsChildOptions): RelayStartsChildStarter {
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const pollMs = options.pollMs ?? 5_000
  return {
    start(launch: ChildLaunch): ChildHandle {
      const key = launch.childRunId
      const done = (async () => {
        let status = await starts.start({ key, projectId: launch.projectId, connectionId: launch.brief.executor.connectionId,
          model: launch.brief.executor.model, consent: options.consent, domains: [...(options.domains ?? [])],
          plan: launch.brief.plan, caps: launch.brief.caps })
        let started = false
        let escalated = false
        try {
          for (;;) {
            if (status.status !== 'preparing' && !started) { started = true; options.runs.modelStarted(launch.attempt) }
            if (status.status === 'input_required' && !escalated) { escalated = true; options.runs.signal(launch.attempt, 'relay-input-required') }
            if (TERMINAL.has(status.status)) {
              options.runs.complete(launch.attempt, status.status === 'completed' ? 'completed' : status.status === 'canceled' ? 'canceled' : 'failed')
              return
            }
            await sleep(pollMs)
            // The mirror's lease is the lead's only proof the work is alive.
            options.runs.renew(launch.attempt)
            try { status = starts.status(key) } catch (error) {
              // A start that never existed ends the mirror; a relay that is momentarily closed or not ready does not.
              if (codeOf(error) === 'relay_not_found') throw error
            }
          }
        } catch (error) {
          // The lead canceled or the mirror's lease was lost: the lead service stops the relay run; nothing to report.
          if (codeOf(error) === 'stale_lease') return
          throw error
        }
      })()
      return { done }
    },
    async stop(childRunId: string): Promise<void> {
      try { await starts.stop(childRunId) } catch (error) {
        // Nothing to stop when the relay never created this start.
        if (codeOf(error) !== 'relay_not_found') throw error
      }
    },
  }
}

const reportOf = (ledger: ReturnType<RelayService['read']>, runId: string): ChildReport => {
  const current = ledger.evidence.filter(evidence => evidence.head === ledger.head)
  return {
    items: ledger.plan.items.map(item => ({ id: item.id, title: item.title, status: ledger.items[item.id] ?? 'open' })),
    gates: current.map(evidence => ({ item: evidence.item, ok: evidence.ok, head: evidence.head, output: evidence.output })),
    head: ledger.head, diffstat: ledger.diffstat, handoff: { ref: `relay:${runId}`, cycle: ledger.cycle },
    narrative: '', openQuestions: ledger.proposals,
    metrics: { cycles: ledger.cycle, tokens: ledger.tokens, moneyMicros: ledger.unknownCosts > 0 ? null : ledger.moneyMicros },
  }
}

/** Reads the relay ledger (a durable, scrubbed fact store) of the relay run started for a child, and nothing else. */
export function relayStartsChildReporter(starts: Pick<RelayStarts, 'status'>, relay: Pick<RelayService, 'read'>): ChildReporter {
  return {
    report(childRunId: string): ChildReport | null {
      try {
        const runId = starts.status(childRunId).runId
        return runId ? reportOf(relay.read(runId), runId) : null
      } catch { return null }
    },
  }
}
