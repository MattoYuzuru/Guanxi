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
