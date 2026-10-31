// Mutation check for test/relay-smoke-server-shapes.test.ts. That test drives the real relay executor, so it cannot run in the copied
// package tools/mutations.ts uses; this script instead edits the real files of this checkout in place, runs the test, and restores every
// file (also on an error or a signal). Each mutant is a change of a note field on the server side or of a rule on the runner side, and
// the test must fail for it. Usage, from the repository root: node packages/bench/tools/server-shape-mutations.ts
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const EXECUTOR = 'packages/server/src/relay/executor.ts'
const MARKER = "relay: 'compaction', mode: 'naive', attempt: a.id, epoch: a.epoch"
interface Mutant { name: string; file: string; edits: Array<[before: string, after: string]> }
const m = (name: string, file: string, before: string, after: string): Mutant => ({ name, file, edits: [[before, after]] })
const mutants: Mutant[] = [
  m('server marker attempt renamed', EXECUTOR, MARKER, "relay: 'compaction', mode: 'naive', attemptId: a.id, epoch: a.epoch"),
  m('server marker epoch dropped', EXECUTOR, MARKER, "relay: 'compaction', mode: 'naive', attempt: a.id"),
  m('server summary attempt dropped', EXECUTOR, "relay: 'compaction_summary', mode: 'naive', attempt: a.id, cycle: h.cycle,", "relay: 'compaction_summary', mode: 'naive', cycle: h.cycle,"),
  m('server summaryLimitBytes renamed', EXECUTOR, 'summaryLimitBytes: this.room(h, max)', 'handoffLimitBytes: this.room(h, max)'),
  m('server outputLimitTokens renamed', EXECUTOR, 'outputLimitTokens: this.reserves.turn', 'outputLimit: this.reserves.turn'),
  m('server degradedReason renamed', EXECUTOR, "degradedReason: h.degraded ? degradedReason ?? 'unknown' : null", "reason: h.degraded ? degradedReason ?? 'unknown' : null"),
  m('server probe_not_applicable renamed', EXECUTOR, "relay: 'probe_not_applicable', mode: 'naive'", "relay: 'probe_skipped', mode: 'naive'"),
  m('server probe_not_applicable damaged dropped', EXECUTOR, "reason: 'ledger_facts_not_shown', damaged })", "reason: 'ledger_facts_not_shown', damaged: false })"),
  m('server marker switched off', EXECUTOR, "if (this.naive) this.store.emit(a, { type: 'agent.note', data: { text: canonical({ relay: 'compaction'", "if (this.naive && a.epoch < 0) this.store.emit(a, { type: 'agent.note', data: { text: canonical({ relay: 'compaction'"),
  m('server call purpose no longer announced', EXECUTOR, "model: 'relay:' + purpose", "model: 'relay:work'"),
  m('runner reads the wrong seal column', 'packages/bench/src/relay-smoke-source.ts', 'attempt_id AS attemptId', 'run_id AS attemptId'),
  m('runner: sealing attempt without a marker passes', 'packages/bench/src/relay-smoke-facts.ts', "if (!marked.has(seal.attemptId)) return 'mixed'", ''),
  m('runner: ledger probe note in a naive trial passes', 'packages/bench/src/relay-smoke-facts.ts', "f.kind === 'probe' || f.kind === 'probe_degraded' || ", ''),
  m('runner: ledger probe call in a naive trial passes', 'packages/bench/src/relay-smoke-facts.ts', " || (f.kind === 'call_started' && f.purpose === 'probe')", ''),
  { name: 'runner: a database without the run is believed', file: 'packages/bench/src/relay-smoke-facts.ts', edits: [
    ["if (evidence === null || !evidence.snapshot) return 'unconfirmed'", "if (evidence === null) return 'unconfirmed'"],
    ["if (facts.some(f => f.kind === 'sealed' && !stored.has(f.cycle))) return 'unconfirmed'", ''],
  ] },
  m('runner: degraded reason not parsed', 'packages/bench/src/relay-smoke-facts.ts', 'degradedReason: fixedCode(p.degradedReason),', 'degradedReason: null,'),
  m('runner: degraded reasons not noted', 'packages/bench/src/relay-smoke-build.ts', 'if (reasons.size) notes.push(', 'if (false) notes.push('),
  m('runner: damaged seal not noted', 'packages/bench/src/relay-smoke-build.ts', 'if (damaged) notes.push(', 'if (false) notes.push('),
  m('runner: non-applicable probe read as unavailable', 'packages/bench/src/relay-smoke-build.ts', "inCycle.some(f => f.kind === 'probe_not_applicable') ? 'unsupported' : 'unavailable'", "'unavailable'"),
]

const originals = new Map<string, string>()
const restore = () => { for (const [file, text] of originals) writeFileSync(join(root, file), text) }
process.on('SIGINT', () => { restore(); process.exit(130) })
process.on('SIGTERM', () => { restore(); process.exit(143) })
const survivors: string[] = []
try {
  for (const mutant of mutants) {
    const path = join(root, mutant.file)
    const original = readFileSync(path, 'utf8')
    originals.set(mutant.file, original)
    let text = original
    for (const [before, after] of mutant.edits) {
      if (!text.includes(before)) throw new Error(`mutation_site_missing:${mutant.name}`)
      text = text.replace(before, after)
    }
    writeFileSync(path, text)
    const result = spawnSync(process.execPath, ['--import', join(root, 'packages/server/test/setup/no-ambient-key-file.mjs'), '--test', 'test/relay-smoke-server-shapes.test.ts'],
      { cwd: join(root, 'packages/bench'), encoding: 'utf8' })
    writeFileSync(path, original); originals.delete(mutant.file)
    const killed = result.status !== 0 && result.stdout.includes('AssertionError')
    console.log(`${killed ? 'killed  ' : 'SURVIVED'} ${mutant.name}`)
    if (!killed) survivors.push(mutant.name)
  }
} finally { restore() }
if (survivors.length) { console.error(`survivors: ${survivors.join('; ')}`); process.exit(1) }
console.log(`${mutants.length} mutants, all killed`)
