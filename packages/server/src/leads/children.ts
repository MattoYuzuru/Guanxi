import type { RelayService, RelayInput } from '../relay/plugin.ts'
import type { ChildHandle, ChildLaunch, ChildReport, ChildReporter, ChildStarter } from './types.ts'

export interface RelayChildStarter extends ChildStarter { start(launch: ChildLaunch): ChildHandle }

/** Starts delegated work through the existing public `RelayService` surface only. The relay's
 * own `RelayStarts.start` always creates a new root run, so it cannot adopt the child that R1
 * `delegate` already created and promised; the child's R1 attempt is initialized here instead.
 * The host supplies the workspace and runtime meter (R2-op) in `prepare`; with no host there is
 * no starter, and delegation fails closed before the lead is stopped. */
export function relayChildStarter(relay: Pick<RelayService, 'init' | 'execute' | 'stop' | 'recover' | 'read'>,
  host: { prepare(launch: ChildLaunch): Promise<RelayInput> }): RelayChildStarter {
  return {
    start(launch: ChildLaunch): ChildHandle {
      const done = (async () => {
        // A kill between the R1 attempt and the ledger leaves no ledger to recover.
        let initialized = false
        if (launch.previousAttempts > 0) { try { relay.read(launch.childRunId); initialized = true } catch { initialized = false } }
        if (initialized) relay.recover(launch.attempt)
        else relay.init(launch.attempt, launch.brief.plan, launch.brief.caps)
        await relay.execute(launch.attempt, await host.prepare(launch))
      })()
      return { done }
    },
    stop: childRunId => relay.stop(childRunId),
  }
}

/** Reads the relay ledger (a durable, scrubbed fact store) and nothing else: no trace, no notes. */
export function relayChildReporter(relay: Pick<RelayService, 'read'>): ChildReporter {
  return {
    report(childRunId: string): ChildReport | null {
      let ledger: ReturnType<RelayService['read']>
      try { ledger = relay.read(childRunId) } catch { return null }
      const current = ledger.evidence.filter(evidence => evidence.head === ledger.head)
      return {
        items: ledger.plan.items.map(item => ({ id: item.id, title: item.title, status: ledger.items[item.id] ?? 'open' })),
        gates: current.map(evidence => ({ item: evidence.item, ok: evidence.ok, head: evidence.head, output: evidence.output })),
        head: ledger.head, diffstat: ledger.diffstat, handoff: { ref: `relay:${childRunId}`, cycle: ledger.cycle },
        narrative: '', openQuestions: ledger.proposals,
        metrics: { cycles: ledger.cycle, tokens: ledger.tokens, moneyMicros: ledger.unknownCosts > 0 ? null : ledger.moneyMicros },
      }
    },
  }
}
