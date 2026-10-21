import { conclusion, holm, mcnemar, mean, noiseFloor, pairedBootstrap, type Pair } from './stats.ts'
import { passHat } from './reducers.ts'
import { validateResults, type Plan, type Trial } from './protocol.ts'
export function analyze(plan: Plan, raw: unknown) {
  const trials = validateResults(plan, raw)
  const control = plan.arms.find(a => a.kind === 'mini-swe-agent') ?? plan.arms[0]!
  const suites = [...new Set(plan.tasks.map(t => t.suite))]
  const family = Math.max(1, (plan.arms.length - 1) * suites.length)
  const summaries = plan.arms.map(arm => {
    const rows = trials.filter(t => t.arm === arm.id)
    const scored = rows.filter(t => !t.outcome.startsWith('infra_'))
    return { arm: arm.id, passed: scored.filter(t => t.outcome === 'passed').length,
      failed: scored.filter(t => t.outcome === 'failed').length,
      infraErrors: rows.filter(t => t.outcome === 'infra_error').length,
      infraTainted: rows.filter(t => t.outcome === 'infra_tainted').length,
      costMicrousd: rows.some(t => t.costMicrousd === null) ? null : rows.reduce((n, t) => n + t.costMicrousd!, 0) }
  })
  const comparisons = plan.arms.filter(a => a.id !== control.id).flatMap(arm => suites.map(suite => {
    const pairs: Pair[] = []
    const excluded: string[] = []
    for (const task of plan.tasks.filter(t => t.suite === suite)) {
      const side = (id: string) => plan.seeds.map(seed => trials.find(t => t.task === task.id && t.arm === id && t.seed === seed)!)
      const a = side(control.id); const b = side(arm.id)
      // MUTATION: infra-separation
      if ([...a, ...b].some(t => t.outcome.startsWith('infra_'))) { excluded.push(task.id); continue }
      pairs.push({ task: task.id, control: a.map(t => Number(t.outcome === 'passed')), candidate: b.map(t => Number(t.outcome === 'passed')) })
    }
    if (pairs.length < 2) return { arm: arm.id, suite, excluded, pairs: pairs.length, stats: null }
    // Family-wise intervals use Bonferroni coverage; McNemar p-values use Holm below.
    const ci = pairedBootstrap(pairs, 25, 10_000, 0.05 / family)
    const exact = mcnemar(pairs.map(p => Number(p.control.every(Boolean))), pairs.map(p => Number(p.candidate.every(Boolean))))
    return { arm: arm.id, suite, excluded, pairs: pairs.length, stats: {
      ci, mcnemarAllSeeds: exact, mcnemarHolmP: 1,
      conclusion: conclusion(ci, plan.change, measuredSaving(trials.filter(t => pairs.some(p => p.task === t.task)), control.id, arm.id)),
      flips: pairs.filter(p => mean(p.control) !== mean(p.candidate)).map(p => ({ task: p.task, control: mean(p.control), candidate: mean(p.candidate) })),
      passHat: [1, 3, 5].map(k => ({ k, control: averageDefined(pairs.map(p => passHat(p.control, k))), candidate: averageDefined(pairs.map(p => passHat(p.candidate, k))) })),
    } }
  }))
  const valid = comparisons.filter(c => c.stats !== null)
  holm(valid.map(c => c.stats!.mcnemarAllSeeds.p)).forEach((p, i) => { valid[i]!.stats!.mcnemarHolmP = p })
  const noise = plan.mode === 'noise-floor' ? noiseFloor(plan.tasks.map(task => plan.seeds.map(seed => {
    const t = trials.find(t => t.task === task.id && t.seed === seed)!
    if (t.outcome.startsWith('infra_')) throw new Error('noise_floor_incomplete_rerun_infra')
    return Number(t.outcome === 'passed')
  }))) : null
  return { version: 1, model: plan.model, provider: plan.provider, control: control.id,
    horizon: 'fixed; no repeated peeking; holdout and guardrails required',
    summaries, comparisons, noise, gate: 'measurement_only',
    infraWarning: trials.some(t => t.outcome.startsWith('infra_')) }
}
function measuredSaving(rows: Trial[], control: string, candidate: string): number {
  const total = (arm: string, metric: 'costMicrousd' | 'durationMs') => rows.filter(t => t.arm === arm).reduce((n, t) => n + (t[metric] ?? 0), 0)
  return Math.max(0, ...(['costMicrousd', 'durationMs'] as const).map(metric => total(control, metric) > 0 ? 1 - total(candidate, metric) / total(control, metric) : 0))
}
function averageDefined(xs: (number | null)[]) { return xs.some(x => x === null) ? null : mean(xs as number[]) }
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
/** Standalone English report. Internal mode includes opaque flipped task IDs; never task content. */
export function htmlReport(plan: Plan, trials: Trial[], publicAggregate = false): string {
  const result = analyze(plan, trials)
  const comparisons = result.comparisons.map(c => ({ ...c,
    excluded: publicAggregate ? c.excluded.length : c.excluded,
    stats: c.stats ? { ...c.stats, flips: publicAggregate ? c.stats.flips.length : c.stats.flips } : null }))
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Benchmark measurement</title><style>body{font:16px system-ui;max-width:72rem;margin:2rem auto;padding:0 1rem;line-height:1.5}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.5rem;border-bottom:1px solid #888}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<h1>Benchmark measurement</h1><p>Fixed horizon, task-clustered paired bootstrap. Measurement only: release requires holdout and guardrails. Rates exclude infrastructure errors and tainted tasks from both paired arms.</p>
<table><caption>Hidden-test outcomes and separate infrastructure counts</caption><thead><tr><th>Arm</th><th>Passed</th><th>Failed</th><th>Infra errors</th><th>Tainted</th><th>Cost (USD micro-units)</th></tr></thead><tbody>${result.summaries.map(s => `<tr>${[s.arm, s.passed, s.failed, s.infraErrors, s.infraTainted, s.costMicrousd ?? 'unknown'].map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>
<h2>Paired comparisons</h2><p>Intervals control family-wise coverage; McNemar tests all-seed success per task with Holm correction. Missing pass^k means fewer than k seeds. Infra exclusions can bias estimates; rerun them before deciding.</p><pre>${esc(JSON.stringify(comparisons, null, 2))}</pre>
<h2>Noise floor</h2><pre>${esc(JSON.stringify(result.noise, null, 2))}</pre></html>`
}
