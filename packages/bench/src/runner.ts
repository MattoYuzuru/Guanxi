import { agentExecResultSchema } from '@guanxi/contract'
import { Budget } from './budget.ts'
import { processJson } from './process.ts'
import { schedule, validatePlan, validateResults, type Plan, type Trial } from './protocol.ts'
export interface Executor {
  /** A trusted K3-backed model gateway must enforce request bounds before billing. */
  boundedBilling?: true
  run(plan: Plan, signal?: AbortSignal): Promise<unknown>
}
export async function runBench(raw: unknown, budget: Budget, executor: Executor, options: { signal?: AbortSignal; paidApproval?: { approvedBy: string; experiment: string } } = {}) {
  const plan = validatePlan(raw)
  options.signal?.throwIfAborted()
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(plan.timeoutSec * 1000)])
  if (plan.maxTrialMicrousd > 0 && (!executor.boundedBilling || options.paidApproval?.experiment !== plan.id || !options.paidApproval.approvedBy)) throw new Error('paid_run_requires_integrator_and_bounded_gateway')
  // MUTATION: reserve-before-dispatch
  budget.reserve(plan)
  // Interrupted runs retain reservations. A repeated ID never dispatches twice, even after restart.
  const results = validateResults(plan, await executor.run(plan, signal))
  budget.settle(plan.id)
  return results
}
export function fixtureExecutor(outcomes?: Record<string, Trial['outcome']>): Executor {
  return { async run(plan, signal) {
    signal?.throwIfAborted()
    return schedule(plan).map(({ task, seed, arm }) => {
      const outcome = outcomes?.[`${task.id}:${arm.id}:${seed}`] ?? 'passed'
      return { task: task.id, arm: arm.id, seed, outcome, costMicrousd: 0, tokens: 0, durationMs: 1,
        reason: outcome === 'passed' ? 'none' : outcome === 'failed' ? 'hidden_tests' : outcome === 'infra_tainted' ? 'preempted' : 'environment' }
    })
  } }
}
export interface BenchHost {
  ssh: string
  /** Pre-staged source/venv under /home/guanxi-bench; no workstation paths. */
  root: string
}
function quote(s: string) { return "'" + s.replace(/'/g, "'\\''") + "'" }
export function remoteCommand(host: BenchHost): string[] {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(host.ssh) || !/^\/home\/guanxi-bench\/[a-zA-Z0-9_/-]+$/.test(host.root) || host.root.split('/').includes('..')) throw new Error('invalid_bench_host')
  return ['-T', '-o', 'BatchMode=yes', '--', host.ssh,
    `cd /tmp && exec sudo -n -u guanxi-bench env -i HOME=/home/guanxi-bench XDG_RUNTIME_DIR=/run/user/1001 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus PATH=/usr/bin:/bin PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=${quote(host.root)} ${quote(host.root + '/.venv/bin/python')} -m guanxi_bench.worker`]
}
/** All untrusted execution is remote. There is no localhost/owner/root fallback. */
export function harborExecutor(host: BenchHost): Executor {
  const args = remoteCommand(host)
  return { run: (plan, signal) => processJson('ssh', args, plan, signal) }
}
export function decodeAgentExec(raw: unknown) {
  const parsed = agentExecResultSchema.parse(raw)
  return { completed: parsed.status === 'completed', status: parsed.status }
}
