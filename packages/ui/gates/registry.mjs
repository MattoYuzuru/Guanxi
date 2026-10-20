import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checks } from './checks.mjs'

const names = ['Tokens valid', 'Generated output fresh', 'Contrast', 'Variables resolve', 'No literal classes', 'No literal CSS values', 'No literal motion']
export async function registry(ctx) {
  const gates = Object.entries(checks).map(([id, check], i) => ({ id, name: names[i], mode: 'fast', check, seed: `packages/ui/gates/seeds/${id}.json` }))
  // Node 26 also loads erasable TypeScript registrations without a transpiler.
  const directory = resolve(ctx.root, 'packages/ui/gates/extensions')
  for (const name of (await readdir(directory)).filter(n => /\.gate\.(?:mjs|ts)$/.test(n)).sort()) {
    const extension = (await import(pathToFileURL(resolve(directory, name)).href)).default
    gates.push(...(Array.isArray(extension) ? extension : [extension]))
  }
  const ids = gates.map(g => g.id)
  if (new Set(ids).size !== ids.length || ids.includes('G17')) throw Error('Duplicate or reserved gate ID')
  for (const gate of gates) if (!gate.id || !gate.name || typeof gate.check !== 'function' || !gate.seed || !['fast', 'browser'].includes(gate.mode)) throw Error('Invalid gate registration')
  return gates.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
}
