#!/usr/bin/env node
/**
 * Interim runner for the catalog gates until DS1-a's runner is on main.
 *
 *   node packages/ui/gates/catalog/run.ts [--mode fast|browser|all] [--only G10,G12]
 *        [--release] [--selftest] [--json] [--update-snapshots] [--stories key,key]
 *
 * `--selftest` runs every gate on a clean scratch copy (it must pass) and on each seeded
 * violation (it must fail), which is G17's contract for these gates. Exit status is 1 when a
 * gate fails, or when a self-test expectation is not met.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultUsageScope } from '../../catalog/tooling/usage.ts'
import { catalogGates } from './registry.ts'
import { createScratch } from './lib/scratch.ts'
import type { CatalogGate, GateContext, GateResult } from './types.ts'

const uiRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const repoRoot = join(uiRoot, '..', '..')

function arg(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : (process.argv[index + 1] ?? null)
}

const mode = (arg('--mode') ?? 'fast') as 'fast' | 'browser' | 'all'
const only = arg('--only')?.split(',')
const json = process.argv.includes('--json')
const selftest = process.argv.includes('--selftest')

const gates = catalogGates.filter(
  (gate) => (mode === 'all' || gate.mode === mode) && (!only || only.includes(gate.id)),
)

const storiesArg = arg('--stories')?.split(',')

function baseContext(root: string, ui: string): GateContext {
  return {
    repoRoot: root,
    uiRoot: ui,
    usageScope: defaultUsageScope(root),
    release: process.argv.includes('--release'),
    updateSnapshots: process.argv.includes('--update-snapshots'),
    ...(storiesArg ? { stories: storiesArg } : {}),
  }
}

export interface SelftestCase {
  gate: string
  mode: string
  seeded: string | null
  expected: 'pass' | 'fail'
  actual: GateResult['status']
  ok: boolean
  findings: GateResult['findings']
}

export async function runSelftest(list: CatalogGate[]): Promise<SelftestCase[]> {
  const cases: SelftestCase[] = []
  for (const gate of list) {
    const runs: Array<{ seeded: CatalogGate['seeded'][number] | null }> = [{ seeded: null }, ...gate.seeded.map((seeded) => ({ seeded }))]
    for (const { seeded } of runs) {
      // Browser gates read stories through the harness and never touch files; fast gates get
      // a scratch copy so a seeded mutation never reaches the working tree.
      const scratch = gate.mode === 'fast' ? createScratch(repoRoot) : null
      try {
        let context = scratch ? { ...baseContext(scratch.repoRoot, scratch.uiRoot), baseTrustedKeys: null } : baseContext(repoRoot, uiRoot)
        if (seeded) {
          context = await seeded.apply({ repoRoot: scratch?.repoRoot ?? repoRoot, uiRoot: scratch?.uiRoot ?? uiRoot, context })
        }
        const outcome = await gate.run(context)
        const expected = seeded ? 'fail' : 'pass'
        cases.push({
          gate: gate.id,
          mode: gate.mode,
          seeded: seeded?.name ?? null,
          expected,
          actual: outcome.status,
          ok: outcome.status === expected,
          findings: outcome.findings,
        })
      } finally {
        scratch?.dispose()
      }
    }
  }
  return cases
}

async function main() {
  if (selftest) {
    const cases = await runSelftest(gates)
    const ok = cases.every((item) => item.ok)
    if (json) console.log(JSON.stringify({ selftest: cases, ok }, null, 2))
    else {
      for (const item of cases) {
        const label = item.seeded ? `seeded ${item.seeded}` : 'clean'
        console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.gate} ${label}: expected ${item.expected}, got ${item.actual}`)
        if (!item.ok) for (const finding of item.findings.slice(0, 10)) console.log(`       ${finding.severity} ${finding.component ?? finding.file ?? ''} ${finding.message}`)
      }
      console.log(ok ? `self-test ok (${cases.length} cases)` : 'self-test FAILED')
    }
    process.exit(ok ? 0 : 1)
  }

  const results: GateResult[] = []
  for (const gate of gates) results.push(await gate.run(baseContext(repoRoot, uiRoot)))
  const ok = results.every((item) => item.status !== 'fail')
  if (json) console.log(JSON.stringify({ gates: results, ok }, null, 2))
  else {
    for (const item of results) {
      console.log(`${item.status.toUpperCase().padEnd(7)} ${item.id} ${item.title}${item.reason ? ` (${item.reason})` : ''}`)
      for (const finding of item.findings) {
        console.log(`        ${finding.severity} ${finding.component ?? ''} ${finding.file ?? ''} ${finding.message}`)
      }
    }
  }
  process.exit(ok ? 0 : 1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()
