/**
 * G11 Status policy (COMPONENTS_AND_CATALOG §4): a product screen or plugin that uses a
 * `draft` (or invalid) component fails every slice; `review` and `stale` warn on slices and
 * fail release or stage exit; a new use of a `deprecated` component fails. Drafts used only by
 * the catalog are allowed.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readInventory } from '../../catalog/tooling/inventory.ts'
import { scanUsage } from '../../catalog/tooling/usage.ts'
import { componentStatuses } from './lib/statuses.ts'
import { overlay } from './lib/scratch.ts'
import { result, type CatalogGate, type GateFinding } from './types.ts'

const fixtures = join(import.meta.dirname, 'fixtures', 'g11')

/** Committed count of deprecated uses that may remain; new uses push the count above it. */
function deprecatedBaseline(uiRoot: string): Record<string, number> {
  const path = join(uiRoot, 'catalog', 'deprecated-usage-baseline.json')
  if (!existsSync(path)) return {}
  return (JSON.parse(readFileSync(path, 'utf8')) as { components?: Record<string, number> }).components ?? {}
}

export const g11: CatalogGate = {
  id: 'G11',
  title: 'Status policy',
  mode: 'fast',
  async run(context) {
    const findings: GateFinding[] = []
    const inventory = readInventory(context.uiRoot)
    const statuses = componentStatuses(inventory)
    const usage = scanUsage(context.usageScope)
    const baseline = deprecatedBaseline(context.uiRoot)
    const owner = new Map<string, string>()
    for (const folder of inventory.folders) for (const name of folder.valueExports) owner.set(name, folder.id)

    for (const file of usage.get('*') ?? []) {
      findings.push({ severity: 'error', file, message: 'namespace or star import of @guanxi/ui hides which components are used' })
    }
    const filesById = new Map<string, Set<string>>()
    for (const [name, files] of usage) {
      if (name === '*') continue
      const id = owner.get(name)
      if (!id) continue
      const set = filesById.get(id) ?? new Set<string>()
      for (const file of files) set.add(file)
      filesById.set(id, set)
    }
    for (const [id, files] of filesById) {
      const status = statuses.get(id) ?? 'invalid'
      for (const file of files) {
        if (status === 'draft' || status === 'invalid') {
          findings.push({ severity: 'error', component: id, file, message: `product code uses ${status} component "${id}"` })
        } else if (status === 'review' || status === 'stale') {
          findings.push({
            severity: context.release ? 'error' : 'warning',
            component: id,
            file,
            message: `product code uses ${status} component "${id}"${context.release ? ' (release gate)' : '; list it in the hand-off'}`,
          })
        }
      }
      if (status === 'deprecated') {
        const allowed = baseline[id] ?? 0
        if (files.size > allowed) {
          findings.push({
            severity: 'error',
            component: id,
            message: `deprecated component "${id}" has ${files.size} uses, above the baseline of ${allowed}`,
          })
        }
      }
    }
    return result(this, findings)
  },
  seeded: [
    {
      name: 'draft-on-product-screen',
      description: 'A product screen in packages/web/src/features imports the draft Button',
      apply({ repoRoot, context }) {
        overlay(join(fixtures, 'draft-on-product-screen'), repoRoot)
        return context
      },
    },
  ],
}
