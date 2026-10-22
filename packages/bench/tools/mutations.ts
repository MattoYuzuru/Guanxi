import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = resolve(import.meta.dirname, '..')
const cases = [
  { id: 'inspect-estimator', file: 'src/reducers.ts', before: 'result *= (correct - i) / (scores.length - i)', after: 'result *= correct / scores.length', test: 'test/stats.test.ts' },
  { id: 'planted-regression', file: 'src/stats.ts', before: 'regression: ci.upper < 0', after: 'regression: false', test: 'test/stats.test.ts' },
  { id: 'infra-separation', file: 'src/report.ts', before: "if ([...a, ...b].some(t => t.outcome.startsWith('infra_')))", after: 'if (false)', test: 'test/protocol.test.ts' },
  { id: 'budget-cap', file: 'src/budget.ts', before: 'if (perArm > p.armCapMicrousd || spent.n + dollars > MONTHLY_CAP || daily.n + tokens > p.dailyTokenCap)', after: 'if (false)', test: 'test/budget.test.ts' },
  { id: 'monthly-budget-only', file: 'src/budget.ts', before: 'spent.n + dollars > MONTHLY_CAP', after: 'false', test: 'test/budget.test.ts' },
  { id: 'host-output-bound', file: 'python/guanxi_bench/environment.py', before: 'if total > OUTPUT_LIMIT:', after: 'if False:', test: 'test/python.test.ts' },
  { id: 'budget-before-dispatch', file: 'src/runner.ts', before: 'budget.reserve(plan)', after: '// reservation removed', test: 'test/budget.test.ts' },
  { id: 'host-user', file: 'python/guanxi_bench/environment.py', before: "if os.getuid() != 1001 or pwd.getpwuid(os.getuid()).pw_name != 'guanxi-bench':", after: 'if False:', test: 'test/python.test.ts' },
  { id: 'lease-loss-abort', file: 'src/plugin.ts', before: 'home.renew(attempt)', after: 'void 0', test: 'test/plugin.test.ts' },
  { id: 'report-private-source', file: 'src/report.ts', before: "publicAggregate ? 'Aggregate publication' : esc(plan.id)", after: "'Aggregate publication'", test: 'test/protocol.test.ts' },
  { id: 'report-mode', file: 'src/report.ts', before: '${esc(plan.mode)}', after: 'unknown', test: 'test/protocol.test.ts' },
  { id: 'report-candidate-version', file: 'src/report.ts', before: '${a.kind}@${a.version}', after: '${a.kind}@${a.id === "candidate" ? "removed" : a.version}', test: 'test/protocol.test.ts' },
  { id: 'request-money', file: 'src/budget.ts', before: 'costMicrousd > trial.max_cost - used.cost', after: 'false', test: 'test/request-admission.test.ts' },
  { id: 'request-tokens', file: 'src/budget.ts', before: 'tokens > trial.max_tokens - used.tokens', after: 'false', test: 'test/request-admission.test.ts' },
  { id: 'request-steps', file: 'src/budget.ts', before: 'used.steps >= trial.max_steps', after: 'false', test: 'test/request-admission.test.ts' },
  { id: 'request-crash-hold', file: 'src/budget.ts', before: "AND state='reserved'", after: "AND state='absent'", test: 'test/request-admission.test.ts' },
  { id: 'request-unknown-halt', file: 'src/budget.ts', before: 'if (trial.halted)', after: 'if (false)', test: 'test/request-admission.test.ts' },
  { id: 'request-model-binding', file: 'src/budget.ts', before: 'if (quote.provider !== run.provider || quote.model !== run.model)', after: 'if (false)', test: 'test/request-admission.test.ts' },
  { id: 'request-digest-binding', file: 'src/request-admission.ts', before: 'quote.preparedSha256 !== digest', after: 'false', test: 'test/request-admission.test.ts' },
  { id: 'request-output-binding', file: 'src/request-admission.ts', before: 'quote.outputTokenLimit !== outputTokenLimit', after: 'false', test: 'test/request-admission.test.ts' },
  { id: 'request-before-dispatch', file: 'src/request-admission.ts', before: 'budget.admitRequest(identity, quote)', after: 'void 0', test: 'test/request-admission.test.ts' },
  { id: 'gateway-unknown-result', file: 'src/k3-gateway.ts', before: "if (observed === null) { unknown(); throw new BenchGatewayError('gateway_usage_unknown') }", after: 'if (false) {}', test: 'test/k3-gateway.test.ts' },
  { id: 'gateway-output-ceiling', file: 'src/k3-gateway.ts', before: 'maxTokens: outputTokenLimit', after: 'maxTokens: undefined', test: 'test/k3-gateway.test.ts' },
  { id: 'gateway-error-hold', file: 'src/k3-gateway.ts', before: 'if (admitted) unknown()', after: 'if (false) unknown()', test: 'test/k3-gateway.test.ts' },
  { id: 'gateway-single-attempt', file: 'src/k3-gateway.ts', before: 'singleAttempt: true', after: 'singleAttempt: undefined', test: 'test/k3-gateway.test.ts' },
  { id: 'b3a-critical-field-partial', file: 'src/relay-measurement.ts', before: 'b.expected > 0 && b.groupsWithoutOccasion === 0 &&', after: 'b.expected > 0 &&', test: 'test/relay-measurement.test.ts' },
  { id: 'b3a-plan-digest', file: 'src/relay-protocol.ts', before: 'if (relayPlanDigest(plan) !== input.planSha256)', after: 'if (false)', test: 'test/relay-protocol.test.ts' },
  { id: 'b3a-ref-attempt-binding', file: 'src/relay-protocol.ts', before: ' || e.attempt !== ctx.attempt', after: '', test: 'test/relay-protocol.test.ts' },
  { id: 'b3a-row-coverage', file: 'src/relay-protocol.ts', before: 'for (const m of manifest) if (!rows.has(m))', after: 'for (const m of manifest) if (false)', test: 'test/relay-protocol.test.ts' },
  { id: 'b3a-strict-envelope', file: 'src/relay-protocol.ts', before: 'trials: z.array(trialSlot).max(MAX_TRIALS),\n}).strict()', after: 'trials: z.array(trialSlot).max(MAX_TRIALS),\n})', test: 'test/relay-protocol.test.ts' },
  { id: 'b3a-first-attempt-split', file: 'src/relay-measurement.ts', before: "if (first.state === 'unknown') b.firstUnknown++; else if (first.result === 'correct') b.firstCorrect++", after: "if (last.state === 'unknown') b.firstUnknown++; else if (last.result === 'correct') b.firstCorrect++", test: 'test/relay-measurement.test.ts' },
  { id: 'b3a-unknown-denominator', file: 'src/relay-measurement.ts', before: 'firstAttemptCorrectOverExpected: denominatorKnown ? frac(b.firstCorrect, b.expected) : null,', after: 'firstAttemptCorrectOverExpected: frac(b.firstCorrect, b.expected),', test: 'test/relay-measurement.test.ts' },
  { id: 'b3a-paired-infra-exclusion', file: 'src/relay-measurement.ts', before: "rows.some(x => x.o === 'infra_error' || x.o === 'infra_tainted') ? 'infra'", after: "false ? 'infra'", test: 'test/relay-measurement.test.ts' },
  { id: 'b3a-guarded-repeat', file: 'src/relay-measurement.ts', before: 'if (k.guardActive) c.guards.guardedRepeats++; else c.guards.unguardedRepeats++', after: 'c.guards.unguardedRepeats++', test: 'test/relay-measurement.test.ts' },
  { id: 'b3a-eta-equality', file: 'src/relay-measurement.ts', before: '<= selected.p80RemainingMs', after: '< selected.p80RemainingMs', test: 'test/relay-measurement.test.ts' },
  { id: 'b3a-no-real-credit', file: 'src/relay-measurement.ts', before: 'realEvidenceCredit: 0,', after: "realEvidenceCredit: input.declaredOrigin === 'recorded_observation' ? 1 : 0,", test: 'test/relay-measurement.test.ts' },
  { id: 'b3a-single-use-evidence', file: 'src/relay-protocol.ts', before: 'if (referenced.has(ref) && SINGLE_USE.has(e.kind))', after: 'if (false)', test: 'test/relay-protocol.test.ts' },
  { id: 'b3a-bounds-before-parse', file: 'src/relay-protocol.ts', before: '!bounded(record.evidence, MAX_EVIDENCE)', after: 'false', test: 'test/relay-protocol.test.ts' },
  { id: 'b3a-cycle-infra-taint', file: 'src/relay-measurement.ts', before: 'return t.cycles.some(c => c.state', after: 'return false && t.cycles.some(c => c.state', test: 'test/relay-measurement.test.ts' },
]
for (const mutation of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'b1-mutation-'))
  try {
    cpSync(root, dir, { recursive: true, filter: path => !path.includes('node_modules') && !path.includes('__pycache__') })
    symlinkSync(resolve(root, '../../node_modules'), join(dir, 'node_modules'), 'dir')
    const file = join(dir, mutation.file)
    const source = readFileSync(file, 'utf8')
    if (!source.includes(mutation.before)) throw new Error(`mutation_site_missing:${mutation.id}`)
    writeFileSync(file, source.replace(mutation.before, mutation.after))
    const result = spawnSync(process.execPath, ['--test', mutation.test], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } })
    if (result.status === 0 || result.status === null || !result.stdout.includes('AssertionError')) throw new Error(`mutation_not_killed_by_assertion:${mutation.id}:${result.stderr}:${result.stdout}`)
    console.log(`${mutation.id}: guard removed -> assertion failed (exit ${result.status})`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
