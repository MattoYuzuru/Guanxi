import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createContext } from './context.mjs'
import { registry } from './registry.mjs'
import { execute } from './checks.mjs'

export async function selfTest(ctx, gates) {
  const results = []
  for (const gate of gates) {
    try {
      const fixture = await ctx.json(gate.seed)
      const seeded = await ctx.withFiles(fixture.files)
      const checked = await execute(gate.check, seeded)
      const detected = !checked.ok && checked.errors.some(error => error.includes(fixture.expectedError))
      results.push({ id: gate.id, ok: detected, errors: detected ? [] : [`Seed did not trigger the expected violation: ${JSON.stringify(checked)}`] })
    } catch (error) { results.push({ id: gate.id, ok: false, errors: [error.message] }) }
  }
  return { ok: results.every(r => r.ok), results }
}
export async function run(ctx, { mode = 'fast' } = {}) {
  ctx ??= await createContext()
  const gates = await registry(ctx)
  return runGates(ctx, gates, mode)
}
export async function runGates(ctx, gates, mode = 'fast') {
  const selected = gates.filter(g => g.mode === mode)
  const results = []
  for (const gate of selected) results.push({ id: gate.id, name: gate.name, ...await execute(gate.check, ctx) })
  results.push({ id: 'G17', name: 'Gates self-test', ...await selfTest(ctx, selected) })
  return { ok: results.every(r => r.ok), scope: mode, registered: gates.map(g => ({ id: g.id, mode: g.mode })), results }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await run(undefined, { mode: process.argv.includes('--browser') ? 'browser' : 'fast' })
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    process.exitCode = report.ok ? 0 : 1
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, errors: [error.message] }) + '\n')
    process.exitCode = 1
  }
}
