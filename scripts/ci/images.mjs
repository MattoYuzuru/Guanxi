import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { root } from './tasks.mjs'

const context = resolve(root, 'packages/server/src/native-agent/container')
const guard = createHash('sha256').update(readFileSync(resolve(context, 'guard.c'))).update(readFileSync(resolve(context, 'Dockerfile'))).digest('hex')
const source = readFileSync(resolve(root, 'packages/ui/gates/catalog/browser/gates.ts'), 'utf8')
const playwright = source.match(/export const PLAYWRIGHT_IMAGE\s*=\s*'([^']+@sha256:[a-f0-9]{64})'/)?.[1]
if (!playwright) throw new Error('Cannot resolve the canonical pinned Playwright image')
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `guard=${guard}\nplaywright=${playwright}\n`)
console.log(JSON.stringify({ guard, playwright }))
