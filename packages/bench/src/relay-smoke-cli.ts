// B3-b: non-interactive entry point of the smoke cohort runner. It is a separate runner, not a mode of the B3-a
// validator or reducer, which stay pure libraries. stdout is one JSON document per invocation; progress lines go
// to stderr as JSON. Exit codes: 0 every planned trial reached a terminal observation and the document validates,
// 3 the document validates but some planned trials are missing or were cancelled, 1 failure, 2 usage or configuration.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TrialObservation } from './relay-smoke-build.ts'
import { SMOKE_BASE_COMMIT, SMOKE_TASK_IDS, smokeDigests, smokePlan, smokeVerifierBlobs } from './relay-smoke-corpus.ts'
import { FakeClock, FakeRelay } from './relay-smoke-fake.ts'
import { sha256Hex } from './relay-smoke-facts.ts'
import { parseSmokeConfig, resolveArms, runSmoke, type ObservationStore, type SmokeConfig, type SmokeResult } from './relay-smoke-run.ts'
import { HttpRelaySource, SmokeSourceError, SqliteLedgerReader, type RelaySource } from './relay-smoke-source.ts'
import { checkRelayMeasurement } from './relay-protocol.ts'
import { reduceRelayMeasurement } from './relay-measurement.ts'

export interface CliIo {
  out(text: string): void
  err(line: string): void
  signal?: AbortSignal
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Test seam: replaces the HTTP source of a `run`. */
  source?: (config: SmokeConfig) => RelaySource
}
class UsageError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.code = code }
}

function flags(args: string[], allowed: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const name = args[i]!
    if (!allowed.includes(name) || args[i + 1] === undefined || values[name] !== undefined) throw new UsageError('usage')
    values[name] = args[++i]!
  }
  return values
}
const required = (v: Record<string, string>, name: string): string => v[name] ?? (() => { throw new UsageError('usage') })()
const readText = (path: string): string => { try { return readFileSync(path, 'utf8') } catch { throw new UsageError('file_unreadable') } }
const sleepReal = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolveSleep, reject) => {
  if (signal?.aborted) { reject(new Error('aborted')); return }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolveSleep() }, ms)
  const stop = () => { clearTimeout(timer); reject(new Error('aborted')) }
  signal?.addEventListener('abort', stop, { once: true })
})
const writePrivate = (path: string, text: string) => { writeFileSync(path, text, { mode: 0o600 }); chmodSync(path, 0o600) }
const json = (value: unknown) => JSON.stringify(value) + '\n'

/** One JSON file per trial under `<out>/observations`, owner-only; facts only, no event text. */
export function fileStore(out: string): ObservationStore {
  const dir = join(out, 'observations')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return {
    load(key) {
      const path = join(dir, `${key}.json`)
      if (!existsSync(path)) return null
      try { return JSON.parse(readFileSync(path, 'utf8')) as TrialObservation } catch { return null }
    },
    save(o) { writePrivate(join(dir, `${o.key}.json`), json(o)) },
  }
}
const applyOverrides = (config: SmokeConfig, v: Record<string, string>): SmokeConfig => {
  const next: SmokeConfig = { ...config }
  if (v['--tasks'] !== undefined) next.tasks = v['--tasks'].split(',').filter(Boolean)
  if (v['--seeds'] !== undefined) next.seeds = v['--seeds'].split(',').map(s => Number(s))
  return parseSmokeConfig(JSON.stringify(next))
}

function persist(out: string, result: SmokeResult, store: ObservationStore | null): void {
  mkdirSync(out, { recursive: true, mode: 0o700 })
  const files: Array<[string, string]> = []
  if (result.measurement) files.push(['measurement.json', json(result.measurement)])
  if (result.report) files.push(['report.json', json(result.report)])
  files.push(['summary.json', json(result.summary)])
  for (const [name, text] of files) writePrivate(join(out, name), text)
  // The manifest lets a reader check that the sidecar files are the ones the summary was produced from.
  const obsDir = join(out, 'observations')
  const sidecars = store && existsSync(obsDir) ? readdirSync(obsDir).sort().map(f => [`observations/${f}`, sha256Hex(readFileSync(join(obsDir, f)))]) : []
  writePrivate(join(out, 'manifest.json'), json({ format: 'guanxi.b3.smoke-manifest/v1', files: [...files.map(([n, t]) => [n, sha256Hex(t)]), ...sidecars] }))
}

async function preflight(config: SmokeConfig, repo: string | undefined, io: CliIo): Promise<{ ok: boolean; checks: Array<{ name: string; ok: boolean; code?: string }> }> {
  const checks: Array<{ name: string; ok: boolean; code?: string }> = [{ name: 'config', ok: true }]
  const tasks = config.tasks ?? SMOKE_TASK_IDS
  checks.push({ name: 'corpus_plans', ok: tasks.every(t => { try { smokePlan(t); return true } catch { return false } }) })
  if (repo) {
    const base = (() => { try { return execFileSync('git', ['-C', resolve(repo), 'rev-parse', `${SMOKE_BASE_COMMIT}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null } })()
    checks.push({ name: 'fixture_base_commit', ok: base === SMOKE_BASE_COMMIT, ...(base === SMOKE_BASE_COMMIT ? {} : { code: 'base_commit_missing' }) })
    for (const { path, blob } of smokeVerifierBlobs(tasks)) {
      const found = (() => { try { return execFileSync('git', ['-C', resolve(repo), 'rev-parse', `${SMOKE_BASE_COMMIT}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null } })()
      checks.push({ name: `verifier:${path}`, ok: found === blob, ...(found === blob ? {} : { code: found ? 'verifier_blob_differs' : 'verifier_missing' }) })
    }
  }
  const arms = resolveArms(config).filter(a => a.planned)
  checks.push({ name: 'arms_planned', ok: arms.length > 0, ...(arms.length ? {} : { code: 'no_arm_planned' }) })
  const source = io.source ? io.source(config) : new HttpRelaySource(Object.fromEntries(arms.map(a => [a.id, { url: a.url, homeDb: a.homeDb }])))
  for (const arm of arms) {
    try { await source.status(arm.id, 'b3s-preflight', io.signal); checks.push({ name: `endpoint:${arm.id}`, ok: true }) } catch (error) {
      // An unknown key answers 404 relay_not_found: the route is live, which is all this check wants.
      const code = error instanceof SmokeSourceError ? error.code : 'endpoint_check_failed'
      checks.push({ name: `endpoint:${arm.id}`, ok: code === 'relay_not_found', ...(code === 'relay_not_found' ? {} : { code }) })
    }
    if (arm.homeDb) {
      try {
        const missing = new SqliteLedgerReader(arm.homeDb).check()
        checks.push({ name: `home_database:${arm.id}`, ok: missing.length === 0, ...(missing.length ? { code: `missing_tables:${missing.join(',')}` } : {}) })
      } catch (error) { checks.push({ name: `home_database:${arm.id}`, ok: false, code: error instanceof SmokeSourceError ? error.code : 'home_database_unreadable' }) }
    } else checks.push({ name: `home_database:${arm.id}`, ok: true, code: 'not_configured_items_context_integrity_unknown' })
  }
  return { ok: checks.every(c => c.ok), checks }
}

const fixtureConfig = (): SmokeConfig => parseSmokeConfig(JSON.stringify({
  version: 1, experimentId: 'b3-smoke-fixture', harnessRevision: 'a'.repeat(40), endpoint: { url: 'http://127.0.0.1:4551' },
  start: { projectId: 'fixture-project', connectionId: 'fixture-connection', model: 'fixture-model' },
  stratum: { provider: 'fixture', model: 'fixture-model', revision: 'rev-1', quantization: { kind: 'not_applicable' }, runtime: 'fake runtime', adapter: 'fake adapter', resourceProfile: 'fake profile', windowTokens: 32768, tokenCountConvention: 'fixture-count-v1' },
  horizon: 8, caps: { tokens: null, moneyMicros: 0, wallMs: null },
  arms: [{ kind: 'ledger_relay', id: 'ledger-relay' }, { kind: 'naive_compaction', id: 'naive-compaction', enabled: true }],
}))

/** Runs one command and returns the process exit code. Never throws; failures are fixed codes on stdout. */
export async function runCli(args: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = args
  try {
    switch (command) {
      case 'plan': {
        const v = flags(rest, ['--config'])
        const config = v['--config'] ? parseSmokeConfig(readText(v['--config'])) : null
        const tasks = config?.tasks ?? SMOKE_TASK_IDS
        const arms = config ? resolveArms(config) : []
        io.out(json({ ok: true, base: SMOKE_BASE_COMMIT, tasks: tasks.map(t => ({ id: t, items: smokePlan(t).items.map(i => i.id) })), digests: smokeDigests(tasks),
          arms: arms.map(a => ({ id: a.id, kind: a.kind, availability: a.planned ? 'planned' : 'unsupported' })),
          expectedTrials: config ? tasks.length * config.seeds.length * arms.filter(a => a.planned).length : null }))
        return 0
      }
      case 'preflight': {
        const v = flags(rest, ['--config', '--repo'])
        const result = await preflight(parseSmokeConfig(readText(required(v, '--config'))), v['--repo'], io)
        io.out(json(result))
        return result.ok ? 0 : 1
      }
      case 'run': {
        const v = flags(rest, ['--config', '--out', '--tasks', '--seeds'])
        const out = resolve(required(v, '--out'))
        const config = applyOverrides(parseSmokeConfig(readText(required(v, '--config'))), v)
        const planned = resolveArms(config).filter(a => a.planned)
        const source = io.source ? io.source(config) : new HttpRelaySource(Object.fromEntries(planned.map(a => [a.id, { url: a.url, homeDb: a.homeDb }])))
        const store = fileStore(out)
        const result = await runSmoke(config, { source, now: io.now ?? Date.now, sleep: io.sleep ?? sleepReal, store, ...(io.signal ? { signal: io.signal } : {}), log: line => io.err(JSON.stringify(line)) })
        persist(out, result, store)
        io.out(json({ ok: result.exitCode !== 1, exitCode: result.exitCode, out, planSha256: result.summary.planSha256, origin: result.summary.origin,
          expectedTrials: result.summary.expectedTrials, incomplete: result.summary.incomplete, document: result.summary.document, gate: 'measurement_only',
          unresolved: result.report?.unresolved ?? [] }))
        return result.exitCode
      }
      case 'report': {
        const v = flags(rest, ['--measurement'])
        let raw: unknown
        try { raw = JSON.parse(readText(required(v, '--measurement'))) } catch (error) { if (error instanceof UsageError) throw error; throw new UsageError('file_invalid') }
        const checked = checkRelayMeasurement(raw)
        if (!checked.ok) { io.out(json({ ok: false, issues: checked.issues })); return 1 }
        io.out(json({ ok: true, report: reduceRelayMeasurement(raw) }))
        return 0
      }
      case 'fixture': {
        const v = flags(rest, ['--out'])
        const out = resolve(required(v, '--out'))
        const clock = new FakeClock(Date.parse('2026-11-01T00:00:00Z'))
        const store = fileStore(out)
        const result = await runSmoke(fixtureConfig(), { source: new FakeRelay(clock), now: clock.now, sleep: clock.sleep, store })
        persist(out, result, store)
        io.out(json({ ok: result.exitCode === 0, exitCode: result.exitCode, out, origin: result.summary.origin, expectedTrials: result.summary.expectedTrials, document: result.summary.document, gate: 'measurement_only' }))
        return result.exitCode === 1 ? 1 : 0
      }
      default: throw new UsageError('usage')
    }
  } catch (error) {
    const code = error instanceof UsageError ? error.code : error instanceof SmokeSourceError ? error.code : error instanceof Error && /^smoke_config_/.test(error.message) ? error.message : 'command_failed'
    io.out(json({ ok: false, code }))
    return error instanceof UsageError || (error instanceof Error && /^smoke_config_/.test(error.message)) || (error instanceof SmokeSourceError && error.code === 'endpoint_invalid') ? 2 : 1
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const abort = new AbortController()
  const stop = () => abort.abort()
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  runCli(process.argv.slice(2), { out: t => process.stdout.write(t), err: l => process.stderr.write(l + '\n'), signal: abort.signal })
    .then(code => { process.exitCode = code })
    .catch(() => { process.stdout.write('{"ok":false,"code":"command_failed"}\n'); process.exitCode = 1 })
}
