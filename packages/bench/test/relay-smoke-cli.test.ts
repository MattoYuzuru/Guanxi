import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FakeClock, FakeRelay } from '../src/relay-smoke-fake.ts'
import { sha256Hex } from '../src/relay-smoke-facts.ts'
import { runCli, type CliIo } from '../src/relay-smoke-cli.ts'
import { SmokeSourceError } from '../src/relay-smoke-source.ts'
import { T0 } from './relay-smoke-helpers.ts'

const CONFIG = {
  version: 1, experimentId: 'cli-test', harnessRevision: 'a'.repeat(40), endpoint: { url: 'http://127.0.0.1:4551' }, start: { projectId: 'p', connectionId: 'c', model: 'm' },
  stratum: { provider: 'fake', model: 'fake-model', revision: 'r1', quantization: { kind: 'not_applicable' }, runtime: 'rt', adapter: 'ad', resourceProfile: 'rp', windowTokens: 32768, tokenCountConvention: 'conv' },
  horizon: 7, caps: { tokens: null, moneyMicros: 0, wallMs: null }, tasks: ['ll-money-text', 'll-rules-fx'], seeds: [0],
  arms: [{ kind: 'ledger_relay', id: 'ledger-relay' }, { kind: 'naive_compaction', id: 'naive-compaction', enabled: true, url: 'http://127.0.0.1:4651' }],
}
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'b3b-cli-'))
  const clock = new FakeClock(T0)
  const fake = new FakeRelay(clock)
  const out: string[] = []; const err: string[] = []
  const io = (extra: Partial<CliIo> = {}): CliIo => ({ out: t => out.push(t), err: l => err.push(l), now: clock.now, sleep: clock.sleep, source: () => fake, ...extra })
  const file = (name: string, value: unknown) => { const p = join(dir, name); writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)); return p }
  const stdout = () => { const text = out.join(''); assert.equal(text.split('\n').filter(Boolean).length, 1, 'exactly one JSON document on stdout'); return JSON.parse(text) }
  return { dir, fake, out, err, io, file, stdout, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('plan prints the corpus and digests without any configuration', async () => {
  const h = harness()
  try {
    assert.equal(await runCli(['plan'], h.io()), 0)
    const doc = h.stdout()
    assert.equal(doc.tasks.length, 5)
    assert.deepEqual(Object.keys(doc.digests), ['taskManifestSha256', 'acceptanceSha256', 'verifierSetSha256'])
    assert.equal(doc.expectedTrials, null)
  } finally { h.cleanup() }
})

test('plan with a configuration counts the trials of the planned arms only', async () => {
  const h = harness()
  try {
    const path = h.file('cfg.json', { ...CONFIG, arms: undefined, tasks: undefined, seeds: [0, 1] })
    assert.equal(await runCli(['plan', '--config', path], h.io()), 0)
    const doc = h.stdout()
    assert.equal(doc.expectedTrials, 5 * 2 * 1, 'the naive arm is unsupported by default')
    assert.deepEqual(doc.arms.map((a: { availability: string }) => a.availability), ['planned', 'unsupported'])
  } finally { h.cleanup() }
})

test('fixture runs the whole pipeline offline and writes private files that report accepts', async () => {
  const h = harness()
  try {
    const out = join(h.dir, 'out')
    assert.equal(await runCli(['fixture', '--out', out], h.io()), 0)
    const doc = h.stdout()
    assert.deepEqual([doc.ok, doc.origin, doc.gate, doc.document.valid, doc.expectedTrials], [true, 'synthetic_fixture', 'measurement_only', true, 10])
    for (const name of ['measurement.json', 'report.json', 'summary.json', 'manifest.json']) assert.equal(statSync(join(out, name)).mode & 0o777, 0o600, name)
    assert.equal(statSync(join(out, 'observations')).mode & 0o777, 0o700)
    assert.equal(readdirSync(join(out, 'observations')).length, 10)
    h.out.length = 0
    assert.equal(await runCli(['report', '--measurement', join(out, 'measurement.json')], h.io()), 0)
    const report = h.stdout().report
    assert.deepEqual([report.gate, report.b3Decision, report.realEvidenceCredit], ['measurement_only', 'unevaluated', 0])
  } finally { h.cleanup() }
})

test('run writes the document, resumes from the observation files and never stores event text', async () => {
  const h = harness()
  try {
    const out = join(h.dir, 'run'); const cfg = h.file('cfg.json', CONFIG)
    assert.equal(await runCli(['run', '--config', cfg, '--out', out], h.io()), 0)
    const first = h.stdout()
    assert.deepEqual([first.ok, first.exitCode, first.incomplete, first.expectedTrials], [true, 0, 0, 4])
    assert.equal(h.fake.started.length, 4)
    assert.ok(h.err.length >= 8 && h.err.every(l => { JSON.parse(l); return true }), 'progress is JSON lines on stderr')
    // the observation files hold facts only
    for (const f of readdirSync(join(out, 'observations'))) assert.ok(!readFileSync(join(out, 'observations', f), 'utf8').includes('withheld'), 'assistant text is never kept')
    // the manifest binds every file it lists
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { files: Array<[string, string]> }
    assert.equal(manifest.files.length, 3 + 4, 'measurement, report, summary and one file per trial')
    for (const [name, hash] of manifest.files) assert.equal(sha256Hex(readFileSync(join(out, name))), hash, name)
    // a second invocation re-attaches to the stored observations and starts nothing
    h.out.length = 0
    assert.equal(await runCli(['run', '--config', cfg, '--out', out], h.io()), 0)
    assert.equal(h.fake.started.length, 4)
  } finally { h.cleanup() }
})

test('--tasks and --seeds narrow the cohort and change the plan digest', async () => {
  const h = harness()
  try {
    const cfg = h.file('cfg.json', CONFIG)
    await runCli(['run', '--config', cfg, '--out', join(h.dir, 'a')], h.io()); const full = h.stdout(); h.out.length = 0
    assert.equal(await runCli(['run', '--config', cfg, '--out', join(h.dir, 'b'), '--tasks', 'll-money-text', '--seeds', '0,1'], h.io()), 0)
    const narrow = h.stdout()
    assert.equal(narrow.expectedTrials, 4)
    assert.notEqual(narrow.planSha256, full.planSha256)
  } finally { h.cleanup() }
})

test('an interrupted run exits 3, still writes a valid document and names what is missing', async () => {
  const h = harness()
  try {
    const abort = new AbortController(); abort.abort()
    const out = join(h.dir, 'run')
    assert.equal(await runCli(['run', '--config', h.file('cfg.json', CONFIG), '--out', out], h.io({ signal: abort.signal })), 3)
    const doc = h.stdout()
    assert.deepEqual([doc.ok, doc.exitCode, doc.incomplete, doc.document.valid], [true, 3, 4, true])
    const measurement = JSON.parse(readFileSync(join(out, 'measurement.json'), 'utf8'))
    assert.ok(measurement.trials.every((t: { state: string; reason: string }) => t.state === 'missing' && t.reason === 'not_collected'))
    assert.equal(h.fake.started.length, 0)
  } finally { h.cleanup() }
})

test('usage and configuration errors exit 2 with a fixed code and never echo input', async () => {
  const h = harness()
  try {
    const run = async (args: string[]) => { h.out.length = 0; const code = await runCli(args, h.io()); return [code, JSON.parse(h.out.join(''))] as const }
    assert.deepEqual(await run([]), [2, { ok: false, code: 'usage' }])
    assert.deepEqual(await run(['launch']), [2, { ok: false, code: 'usage' }])
    assert.deepEqual(await run(['run', '--config']), [2, { ok: false, code: 'usage' }])
    assert.deepEqual(await run(['run', '--config', 'a', '--config', 'b', '--out', 'x']), [2, { ok: false, code: 'usage' }])
    assert.deepEqual(await run(['run', '--config', join(h.dir, 'missing.json'), '--out', join(h.dir, 'o')]), [2, { ok: false, code: 'file_unreadable' }])
    assert.deepEqual(await run(['run', '--config', h.file('bad.json', 'LEAK-MARKER {'), '--out', join(h.dir, 'o')]), [2, { ok: false, code: 'smoke_config_invalid' }])
    assert.deepEqual(await run(['run', '--config', h.file('far.json', { ...CONFIG, endpoint: { url: 'http://203.0.113.9:4551' } }), '--out', join(h.dir, 'o')]), [2, { ok: false, code: 'endpoint_invalid' }])
    assert.deepEqual(await run(['run', '--config', h.file('tasks.json', CONFIG), '--out', join(h.dir, 'o'), '--tasks', 'nope']), [2, { ok: false, code: 'smoke_config_tasks' }])
    assert.deepEqual(await run(['report', '--measurement', h.file('m.json', 'not json')]), [2, { ok: false, code: 'file_invalid' }])
  } finally { h.cleanup() }
})

test('report refuses an invalid document with exit 1 and fixed issues', async () => {
  const h = harness()
  try {
    assert.equal(await runCli(['fixture', '--out', join(h.dir, 'o')], h.io()), 0); h.out.length = 0
    const doc = JSON.parse(readFileSync(join(h.dir, 'o', 'measurement.json'), 'utf8')); doc.plan.horizon = 9
    assert.equal(await runCli(['report', '--measurement', h.file('tampered.json', doc)], h.io()), 1)
    const result = h.stdout()
    assert.equal(result.ok, false)
    assert.ok(result.issues.length > 0 && result.issues.every((i: { code: string }) => typeof i.code === 'string'))
  } finally { h.cleanup() }
})

test('preflight checks the endpoint, the fixture repository and the home database, and fails when any is wrong', async () => {
  const h = harness()
  try {
    const cfg = h.file('cfg.json', { ...CONFIG, endpoint: { url: 'http://127.0.0.1:4551', homeDb: join(h.dir, 'absent.db') } })
    const live = { ...h.fake, kind: 'fake' as const, status: async () => { throw new SmokeSourceError('relay_not_found') } }
    assert.equal(await runCli(['preflight', '--config', cfg], h.io({ source: () => live as never })), 1)
    const failed = h.stdout()
    assert.deepEqual(failed.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { name: string; code: string }) => [c.name, c.code]), [['home_database:ledger-relay', 'home_database_unreadable']])
    // a reachable endpoint without a configured database is fine, but says what becomes unknown
    h.out.length = 0
    const ok = h.file('cfg2.json', CONFIG)
    assert.equal(await runCli(['preflight', '--config', ok], h.io({ source: () => live as never })), 0)
    assert.ok(h.stdout().checks.some((c: { code?: string }) => c.code === 'not_configured_items_context_integrity_unknown'))
    // an unreachable endpoint fails with its code
    h.out.length = 0
    const down = { ...live, status: async () => { throw new SmokeSourceError('endpoint_unreachable') } }
    assert.equal(await runCli(['preflight', '--config', ok], h.io({ source: () => down as never })), 1)
    assert.ok(h.stdout().checks.some((c: { name: string; code?: string }) => c.name === 'endpoint:ledger-relay' && c.code === 'endpoint_unreachable'))
    // a repository without the pinned base commit fails the fixture checks
    h.out.length = 0
    const repo = join(h.dir, 'repo'); execFileSync('git', ['init', '-q', repo])
    assert.equal(await runCli(['preflight', '--config', ok, '--repo', repo], h.io({ source: () => live as never })), 1)
    const checks = h.stdout().checks as Array<{ name: string; ok: boolean; code?: string }>
    assert.deepEqual(checks.find(c => c.name === 'fixture_base_commit'), { name: 'fixture_base_commit', ok: false, code: 'base_commit_missing' })
    assert.ok(checks.filter(c => c.name.startsWith('verifier:')).every(c => !c.ok && c.code === 'verifier_missing'))
  } finally { h.cleanup() }
})

test('the real process prints one JSON document on stdout and sets the exit code', () => {
  const h = harness()
  try {
    const entry = join(import.meta.dirname, '..', 'src', 'relay-smoke-cli.ts')
    const fixture = spawnSync(process.execPath, [entry, 'fixture', '--out', join(h.dir, 'proc')], { encoding: 'utf8' })
    assert.equal(fixture.status, 0, fixture.stderr)
    assert.equal(JSON.parse(fixture.stdout).document.valid, true)
    assert.equal(fixture.stdout.trim().split('\n').length, 1)
    const bad = spawnSync(process.execPath, [entry, 'frobnicate'], { encoding: 'utf8' })
    assert.equal(bad.status, 2)
    assert.deepEqual(JSON.parse(bad.stdout), { ok: false, code: 'usage' })
  } finally { h.cleanup() }
})

test('a corrupt or foreign observation file is refused with a fixed code, not skipped', async () => {
  const h = harness()
  try {
    const out = join(h.dir, 'run'); const cfg = h.file('cfg.json', CONFIG)
    assert.equal(await runCli(['run', '--config', cfg, '--out', out], h.io()), 0); h.out.length = 0
    const files = readdirSync(join(out, 'observations'))
    const target = join(out, 'observations', files[0]!)
    const good = readFileSync(target, 'utf8')
    for (const bad of ['{not json', JSON.stringify({ ...JSON.parse(good), version: 2 }), JSON.stringify({ ...JSON.parse(good), key: 'b3s-0000000000000000' }), JSON.stringify({ ...JSON.parse(good), facts: 'x' }), JSON.stringify({ ...JSON.parse(good), extra: 1 })]) {
      writeFileSync(target, bad); h.out.length = 0
      assert.equal(await runCli(['run', '--config', cfg, '--out', out], h.io()), 2)
      assert.deepEqual(JSON.parse(h.out.join('')), { ok: false, code: 'smoke_config_observation_invalid' })
    }
    assert.equal(h.fake.started.length, 4, 'nothing was started again')
  } finally { h.cleanup() }
})

test('a changed configuration over an old output directory is refused with a fixed code', async () => {
  const h = harness()
  try {
    const out = join(h.dir, 'run')
    assert.equal(await runCli(['run', '--config', h.file('a.json', CONFIG), '--out', out], h.io()), 0); h.out.length = 0
    assert.equal(await runCli(['run', '--config', h.file('b.json', { ...CONFIG, start: { ...CONFIG.start, model: 'other-model' } }), '--out', out], h.io()), 2)
    assert.deepEqual(JSON.parse(h.out.join('')), { ok: false, code: 'smoke_config_observation_mismatch' })
  } finally { h.cleanup() }
})

test('--arms runs one arm per pass against the same output directory and the passes merge into one document', async () => {
  const h = harness()
  try {
    const shared = h.file('shared.json', { ...CONFIG, arms: [{ kind: 'ledger_relay', id: 'ledger-relay' }, { kind: 'naive_compaction', id: 'naive-compaction', enabled: true }] })
    const out = join(h.dir, 'passes')
    assert.equal(await runCli(['run', '--config', shared, '--out', out], h.io()), 2, 'two arms behind one endpoint in one pass')
    assert.deepEqual(JSON.parse(h.out.join('')), { ok: false, code: 'smoke_config_arm_endpoint' }); h.out.length = 0
    assert.equal(await runCli(['run', '--config', shared, '--out', out, '--arms', 'ledger-relay'], h.io()), 3)
    assert.equal(h.stdout().expectedTrials, 4); h.out.length = 0
    assert.equal(await runCli(['run', '--config', shared, '--out', out, '--arms', 'naive-compaction'], h.io()), 0)
    const done = h.stdout()
    assert.deepEqual([done.exitCode, done.incomplete], [0, 0])
    const measurement = JSON.parse(readFileSync(join(out, 'measurement.json'), 'utf8'))
    assert.ok(measurement.trials.every((t: { state: string }) => t.state === 'observed'))
    assert.equal(h.fake.started.length, 4)
    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'))
    assert.equal(summary.armIdentity, 'operator_asserted')
  } finally { h.cleanup() }
})

test('the entry point works when reached through a symlink', () => {
  const h = harness()
  try {
    const entry = join(import.meta.dirname, '..', 'src', 'relay-smoke-cli.ts')
    const link = join(h.dir, 'linked-cli.ts')
    symlinkSync(entry, link)
    const result = spawnSync(process.execPath, [link, 'plan'], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.stdout.trim().length > 0, 'a silent exit with empty output is the failure to avoid')
    assert.equal(JSON.parse(result.stdout).ok, true)
  } finally { h.cleanup() }
})
