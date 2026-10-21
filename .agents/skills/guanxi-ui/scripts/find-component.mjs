#!/usr/bin/env node
// Search the @guanxi/ui catalog before writing JSX (guanxi-ui skill, decision ladder step 1).
// Usage: node .agents/skills/guanxi-ui/scripts/find-component.mjs "<need>" [--all]
// Prints JSON: the best matches from packages/ui/catalog/manifest.json with their purpose,
// status, import line, states and product usage. Exit 1 when nothing matches.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const uiRoot = join(repoRoot, 'packages', 'ui')
const manifest = JSON.parse(readFileSync(join(uiRoot, 'catalog', 'manifest.json'), 'utf8'))

const query = process.argv.slice(2).filter((arg) => !arg.startsWith('--')).join(' ').trim().toLowerCase()
if (!query) {
  console.error('usage: find-component.mjs "<what you need>" [--all]')
  process.exit(2)
}

function section(docs, heading) {
  const match = new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(docs)
  return match ? match[1].trim().replace(/\s+/g, ' ') : ''
}

const words = query.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1)
const results = manifest.components.map((component) => {
  const docsPath = join(uiRoot, component.folder, `${component.id}.docs.md`)
  const docs = existsSync(docsPath) ? readFileSync(docsPath, 'utf8') : ''
  const purpose = section(docs, 'Purpose')
  const whenToUse = section(docs, 'When to use')
  const haystack = {
    name: `${component.id} ${component.title} ${component.exports.join(' ')}`.toLowerCase(),
    text: `${purpose} ${whenToUse} ${component.states.join(' ')}`.toLowerCase(),
  }
  let score = 0
  for (const word of words) {
    if (haystack.name.includes(word)) score += 5
    if (haystack.text.includes(word)) score += 1
  }
  return {
    score,
    id: component.id,
    title: component.title,
    level: component.level,
    status: component.status,
    import: `import { ${component.componentExports.join(', ')} } from '@guanxi/ui'`,
    purpose,
    whenToUse,
    states: component.states,
    usage: component.usage.count,
    docs: `packages/ui/${component.folder}/${component.id}.docs.md`,
    catalog: `/settings/developer/components?component=${component.id}`,
  }
})

const matches = results
  .filter((result) => process.argv.includes('--all') || result.score > 0)
  .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  .slice(0, process.argv.includes('--all') ? undefined : 5)
console.log(JSON.stringify({ query, matches }, null, 2))
if (matches.length === 0) {
  console.error('No component matches. Compose a pattern from primitives, or scaffold one with new-component.mjs.')
  process.exit(1)
}
