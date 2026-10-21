/**
 * Lane DS1-b registrations for DS1-a's gate runner (packages/ui/gates/README.md): G10, G11,
 * G12 and G15 (fast), G13, G14 and G16 (browser). Each adapts a checker from ../catalog/ to
 * the extension contract: the runner's context may overlay files (G17 seeds), so overlaid
 * files are written into a scratch copy of the checkout before the checker runs.
 *
 * G15's browser half (no clipping in Russian or the +40% pseudo-locale) is its own registration,
 * `G15-clipping`, because ids are unique and G17 runs one seed per registration: grouped with
 * G14, removing either checker would still pass G17 (GPT N12).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultUsageScope } from '../../catalog/tooling/usage.ts'
import { g10 } from '../catalog/g10-catalog-complete.ts'
import { g11 } from '../catalog/g11-status-policy.ts'
import { g12 } from '../catalog/g12-approval-integrity.ts'
import { g15 } from '../catalog/g15-i18n-literals.ts'
import { g13, g14, g15Clipping, g16 } from '../catalog/browser/gates.ts'
import { createScratch } from '../catalog/lib/scratch.ts'
import type { CatalogGate, GateContext, GateResult } from '../catalog/types.ts'

/** The runner's context (packages/ui/gates/context.mjs). */
interface ExtensionContext {
  root: string
  files: string[]
  read(path: string): Promise<string>
}

interface ExtensionResult {
  ok: boolean
  errors: string[]
  warnings?: string[]
}

/** A browser seed selects stories instead of changing files. */
const SELECTED = 'packages/ui/gates/catalog/fixtures/browser/selected.json'
const SEEDS = 'packages/ui/gates/catalog/seeds'

async function materialise(ctx: ExtensionContext): Promise<{ repoRoot: string; uiRoot: string; dispose(): void }> {
  const changed: Array<[string, string]> = []
  for (const file of ctx.files) {
    if (file === SELECTED) continue
    const onDisk = join(ctx.root, file)
    const text = await ctx.read(file)
    if (!existsSync(onDisk) || readFileSync(onDisk, 'utf8') !== text) changed.push([file, text])
  }
  if (changed.length === 0) return { repoRoot: ctx.root, uiRoot: join(ctx.root, 'packages', 'ui'), dispose: () => undefined }
  const scratch = createScratch(ctx.root)
  for (const [file, text] of changed) {
    mkdirSync(dirname(join(scratch.repoRoot, file)), { recursive: true })
    writeFileSync(join(scratch.repoRoot, file), text)
  }
  return scratch
}

function adapt(outcomes: GateResult[]): ExtensionResult {
  const errors: string[] = []
  const warnings: string[] = []
  for (const outcome of outcomes) {
    if (outcome.status === 'skipped') warnings.push(`${outcome.id} skipped: ${outcome.reason ?? ''}`)
    for (const finding of outcome.findings) {
      const line = `${outcome.id} ${finding.component ?? finding.file ?? ''} ${finding.message}`.replace(/\s+/g, ' ')
      if (finding.severity === 'error') errors.push(line)
      else warnings.push(line)
    }
  }
  return { ok: outcomes.every((outcome) => outcome.status !== 'fail'), errors, warnings }
}

function register(id: string, name: string, gates: CatalogGate[]) {
  const mode = gates[0]!.mode
  return {
    id,
    name,
    mode,
    seed: `${SEEDS}/${id}.json`,
    async check(ctx: ExtensionContext): Promise<ExtensionResult> {
      const workspace = await materialise(ctx)
      try {
        let context: GateContext = {
          repoRoot: workspace.repoRoot,
          uiRoot: workspace.uiRoot,
          usageScope: defaultUsageScope(workspace.repoRoot),
          release: process.env['GUANXI_UI_RELEASE'] === '1',
        }
        if (mode === 'browser' && ctx.files.includes(SELECTED)) {
          const selected = JSON.parse(await ctx.read(SELECTED)) as { stories: string[]; fixtures?: boolean; seed?: string }
          context = { ...context, stories: selected.stories, fixtures: selected.fixtures === true, ...(selected.seed ? { seed: selected.seed } : {}) }
        }
        const outcomes: GateResult[] = []
        for (const gate of gates) outcomes.push(await gate.run(context))
        return adapt(outcomes)
      } finally {
        workspace.dispose()
      }
    },
  }
}

export default [
  register('G10', g10.title, [g10]),
  register('G11', g11.title, [g11]),
  register('G12', g12.title, [g12]),
  register('G15', g15.title, [g15]),
  register('G13', g13.title, [g13]),
  register('G14', g14.title, [g14]),
  register('G15-clipping', g15Clipping.title, [g15Clipping]),
  register('G16', g16.title, [g16]),
]
