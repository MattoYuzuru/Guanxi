/**
 * G10 Catalog complete: every exported component has a story per declared state, a complete
 * docs file and a review record; no catalog entry is orphaned; the manifest is fresh.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseReviewRecord } from '../../catalog/approval/index.ts'
import { docsProblems } from '../../catalog/docs.ts'
import { cssVariablesOf, readInventory } from '../../catalog/tooling/inventory.ts'
import { buildManifest, serialiseManifest } from '../../catalog/tooling/manifest.ts'
import { overlay } from './lib/scratch.ts'
import { result, type CatalogGate, type GateFinding } from './types.ts'

const fixtures = join(import.meta.dirname, 'fixtures', 'g10')

export const g10: CatalogGate = {
  id: 'G10',
  title: 'Catalog complete',
  mode: 'fast',
  async run(context) {
    const findings: GateFinding[] = []
    const inventory = readInventory(context.uiRoot)
    const error = (component: string, message: string) => findings.push({ severity: 'error', component, message })

    for (const target of inventory.strayExports) {
      findings.push({
        severity: 'error',
        message: `src/index.ts exports ${target}, which is neither a component folder nor a utility module (src/i18n, src/lib)`,
      })
    }
    for (const id of inventory.publicFolders) {
      if (!inventory.folders.some((folder) => folder.id === id)) error(id, 'exported from src/index.ts but the folder is missing')
    }
    for (const folder of inventory.folders) {
      const id = folder.id
      if (!inventory.publicFolders.includes(id)) {
        error(id, 'orphaned: the folder is not exported from src/index.ts')
        continue
      }
      if (!folder.hasImplementation) error(id, `missing ${id}.tsx`)
      if (!folder.hasIndex) error(id, 'missing index.ts')
      if (!folder.hasStories) error(id, `missing ${id}.stories.tsx`)
      if (!folder.hasDocs) error(id, `missing ${id}.docs.md`)
      if (!folder.hasReview) error(id, `missing ${id}.review.json`)
      if (folder.valueExports.length === 0) error(id, 'index.ts exports no value')
      for (const problem of folder.storyParseErrors) error(id, `stories: ${problem}`)

      if (folder.docs) {
        for (const problem of docsProblems(folder.docs, id)) error(id, `docs: ${problem}`)
        const states = folder.docs.states
        const names = folder.stories.map((story) => story.name)
        for (const story of folder.stories) {
          if (story.name === null) error(id, `story export ${story.exportName} has no literal name`)
        }
        for (const state of states) {
          const count = names.filter((name) => name === state).length
          if (count === 0) error(id, `declared state "${state}" has no story`)
          if (count > 1) error(id, `declared state "${state}" has ${count} stories`)
        }
        for (const name of names) {
          if (name !== null && !states.includes(name)) error(id, `story "${name}" is not a declared state`)
        }
        const variables = cssVariablesOf(folder)
        for (const token of folder.docs.tokens) {
          if (!variables.includes(token.startsWith('--') ? token : `--${token}`)) {
            error(id, `docs lists token "${token}" that the component does not read`)
          }
        }
      }
      if (folder.hasReview) {
        if (folder.reviewParseError) error(id, `review record is not JSON: ${folder.reviewParseError}`)
        else {
          const parsed = parseReviewRecord(folder.reviewJson, id)
          if (!parsed.ok) for (const problem of parsed.errors) error(id, `review record: ${problem}`)
        }
      }
    }

    const manifestPath = join(context.uiRoot, 'catalog', 'manifest.json')
    let committed = ''
    try {
      committed = readFileSync(manifestPath, 'utf8')
    } catch {
      findings.push({ severity: 'error', message: 'catalog/manifest.json is missing' })
    }
    let fresh: string | null = null
    try {
      fresh = serialiseManifest(buildManifest(context.uiRoot, context.usageScope))
    } catch (problem) {
      // Source hashes fail closed (an import they cannot resolve): report, never pass silently.
      findings.push({ severity: 'error', message: `manifest cannot be built: ${(problem as Error).message}` })
    }
    if (committed !== '' && fresh !== null && committed !== fresh) {
      findings.push({
        severity: 'error',
        file: 'packages/ui/catalog/manifest.json',
        message: 'catalog/manifest.json is stale; run `npm run manifest --workspace @guanxi/ui`',
      })
    }
    return result(this, findings)
  },
  seeded: [
    {
      name: 'export-without-catalog-entry',
      description: 'A new exported component "NewThing" with no stories, docs or review record',
      expect: /missing new-thing\.stories\.tsx/,
      apply({ repoRoot, context }) {
        overlay(join(fixtures, 'export-without-catalog-entry'), repoRoot)
        return context
      },
    },
    {
      name: 'stray-named-export',
      description: 'src/index.ts exports a component by name from outside the folder convention',
      expect: /src\/index\.ts exports "Fancy" from \.\/fancy\.tsx, which is neither/,
      apply({ repoRoot, context }) {
        overlay(join(fixtures, 'stray-named-export'), repoRoot)
        return context
      },
    },
    {
      name: 'state-without-story',
      description: 'Button docs declare a "pressed" state that has no story',
      expect: /declared state "pressed" has no story/,
      apply({ uiRoot, context }) {
        const docs = join(uiRoot, 'src', 'components', 'button', 'button.docs.md')
        const source = readFileSync(docs, 'utf8').replace('states: [default,', 'states: [pressed, default,')
        writeFileSync(docs, source)
        return context
      },
    },
  ],
}
