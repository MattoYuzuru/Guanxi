import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Budget } from './budget.ts'
import { selectCorpus } from './corpus.ts'
import { validatePlan } from './protocol.ts'
import { htmlReport } from './report.ts'
import { fixtureExecutor, harborExecutor, runBench } from './runner.ts'
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
const dir = resolve(process.env.GUANXI_DATA_DIR ?? '.lane-data', 'bench')
async function main(args: string[]) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const [command, path, hostPath] = args
  if (command === 'corpus' && path && hostPath && args[3]) {
    const corpus = selectCorpus(await read(path), { from: hostPath, through: args[3] })
    await writeFile(join(dir, 'corpus.json'), JSON.stringify(corpus, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify({ status: 'selected', fresh: 50, regression: 30, sha256: corpus.sha256 }))
    return
  }
  const plan = command === 'fixture' ? validatePlan({
    version: 1, id: `fixture-${randomUUID()}`, mode: 'fixture',
    tasks: [0, 1].map(i => ({ id: `toy-${i}`, suite: 'fixture', revision: '0'.repeat(40), path: `toy-${i}`, published: '2026-10-21' })),
    seeds: [0], arms: [{ id: 'control', kind: 'mini-swe-agent', version: '2.4.6' }, { id: 'candidate', kind: 'fixture', version: '1' }],
    model: 'fixture-free', provider: 'fixture', connection: null,
    maxTrialMicrousd: 0, maxTrialTokens: 0, maxSteps: 4, armCapMicrousd: 0, dailyTokenCap: 0,
    timeoutSec: 120, cpus: 1, memoryMb: 128,
  }) : command === 'run' && path && hostPath ? validatePlan(await read(path)) : null
  if (!plan) throw new Error('usage')
  const executor = command === 'fixture' ? fixtureExecutor({ 'toy-1:candidate:0': 'failed' }) : harborExecutor(z.object({ ssh: z.string(), root: z.string() }).strict().parse(await read(hostPath!)))
  const budget = new Budget(join(dir, 'budget.sqlite'))
  const abort = new AbortController()
  const stop = () => abort.abort()
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    const trials = await runBench(plan, budget, executor, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(plan.timeoutSec * 1000)]) })
    await writeFile(join(dir, `${plan.id}.json`), JSON.stringify({ plan, trials }, null, 2) + '\n', { mode: 0o600 })
    await writeFile(join(dir, `${plan.id}.html`), htmlReport(plan, trials), { mode: 0o600 })
    console.log(JSON.stringify({ version: 1, id: plan.id, trials: trials.length, report: join(dir, `${plan.id}.html`), spendMicrousd: trials.reduce((n, t) => n + (t.costMicrousd ?? 0), 0) }))
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
    budget.close()
  }
}
main(process.argv.slice(2)).catch(() => { console.error('bench_command_failed'); process.exitCode = 1 })
