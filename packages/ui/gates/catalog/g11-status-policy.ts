/**
 * G11 Status policy (COMPONENTS_AND_CATALOG §4): a product screen or plugin that uses a
 * `draft` (or invalid) component fails every slice; `review` and `stale` warn on slices and
 * fail release or stage exit. Drafts used only by the catalog route are allowed.
 *
 * `deprecated` counts as `draft` for now: deprecation is an owner decision, and until the node
 * can write a signed deprecation an agent could otherwise mark a never-approved component
 * deprecated and put it on a product screen.
 */
import { join } from 'node:path'
import { readInventory } from '../../catalog/tooling/inventory.ts'
import { scanUsage } from '../../catalog/tooling/usage.ts'
import { componentStatuses } from './lib/statuses.ts'
import { overlay } from './lib/scratch.ts'
import { result, type CatalogGate, type GateFinding } from './types.ts'

const fixtures = join(import.meta.dirname, 'fixtures', 'g11')

export const g11: CatalogGate = {
  id: 'G11',
  title: 'Status policy',
  mode: 'fast',
  async run(context) {
    const findings: GateFinding[] = []
    const inventory = readInventory(context.uiRoot)
    const statuses = componentStatuses(inventory)
    const usage = scanUsage(context.usageScope)
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
        if (status === 'draft' || status === 'invalid' || status === 'deprecated') {
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
    }
    return result(this, findings)
  },
  seeded: [
    {
      name: 'draft-on-product-screen',
      description: 'A product screen in packages/web/src/features imports the draft Button',
      expect: /product code uses draft component "button"/,
      apply({ repoRoot, context }) {
        overlay(join(fixtures, 'draft-on-product-screen'), repoRoot)
        return context
      },
    },
    {
      name: 'deprecated-laundering',
      description: 'An agent marks the draft Badge deprecated (unsigned) and uses it on a product screen',
      expect: /product code uses deprecated component "badge"/,
      apply({ repoRoot, context }) {
        overlay(join(fixtures, 'deprecated-laundering'), repoRoot)
        return context
      },
    },
  ],
}
