#!/usr/bin/env node
// Scaffold a new @guanxi/ui component folder (guanxi-ui skill, decision ladder step 5).
// Usage: node .agents/skills/guanxi-ui/scripts/new-component.mjs <id> --level primitive|pattern
//          --states default,hover,disabled [--dry-run] [--repo <checkout>]
// Writes src/components/<id>/{<id>.tsx,<id>.css,<id>.stories.tsx,<id>.docs.md,<id>.review.json,
// index.ts} with status "draft", appends the export to src/index.ts and prints the next steps.
// The docs file starts with TODO markers that gate G10 rejects until they are replaced.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

// --repo lets tests scaffold into a scratch copy of the repository.
const repoRoot = resolve(option('--repo') ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'))
const uiRoot = join(repoRoot, 'packages', 'ui')

const id = process.argv[2]
const level = option('--level') ?? 'pattern'
const states = (option('--states') ?? 'default').split(',').map((state) => state.trim()).filter(Boolean)
const dryRun = process.argv.includes('--dry-run')

if (!id || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) {
  console.error('usage: new-component.mjs <kebab-id> --level primitive|pattern --states a,b,c [--dry-run]')
  process.exit(2)
}
if (!['primitive', 'pattern'].includes(level)) {
  console.error('--level must be primitive or pattern')
  process.exit(2)
}
if (states.some((state) => !/^[a-z][a-z0-9-]*$/.test(state)) || new Set(states).size !== states.length) {
  console.error('--states must be unique kebab-case names')
  process.exit(2)
}

const name = id.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('')
const exportName = (state) => state.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('') + 'State'
const dir = join(uiRoot, 'src', 'components', id)
if (existsSync(dir)) {
  console.error(`packages/ui/src/components/${id} already exists; extend it with a variant instead.`)
  process.exit(1)
}

const files = {
  [`${id}.tsx`]: `/*
 * Guanxi ${level}. Semantic tokens only; user-facing text comes from props or message keys.
 */
import type { ComponentProps } from 'react'
import { cx } from '../../lib/cx.ts'
import './${id}.css'

export interface ${name}Props extends Omit<ComponentProps<'div'>, 'className'> {
  className?: string
}

export function ${name}({ className, ...props }: ${name}Props) {
  return <div data-slot="${id}" className={cx('gx-${id}', className)} {...props} />
}
`,
  [`${id}.css`]: `.gx-${id} {
  display: flex;
  gap: var(--space-2);
  color: var(--color-text-primary);
}
`,
  [`${id}.stories.tsx`]: `import type { Story, StoryMeta } from '../../story-kit/index.tsx'
import { ${name}, type ${name}Props } from './${id}.tsx'

const meta = {
  title: '${level === 'primitive' ? 'Primitives' : 'Patterns'}/${name}',
  component: ${name},
} satisfies StoryMeta<${name}Props>

export default meta
${states.map((state) => `\nexport const ${exportName(state)}: Story<${name}Props> = { name: '${state}' }\n`).join('')}`,
  [`${id}.docs.md`]: `---
id: ${id}
level: ${level}
states: [${states.join(', ')}]
tokens: []
since: 0.1.0
---

# ${name}

${['Purpose', 'When to use', 'When not to use', 'Anatomy and variants', 'States', 'Accessibility', 'Content and i18n', 'Motion', "Do / Don't"]
  .map((heading) => `## ${heading}\n\nTODO: write this section.\n`)
  .join('\n')}`,
  [`${id}.review.json`]: `${JSON.stringify({ $schema: '../../../catalog/review.schema.json', id, status: 'draft', approval: null, requests: [] }, null, 2)}\n`,
  'index.ts': `export { ${name} } from './${id}.tsx'\nexport type { ${name}Props } from './${id}.tsx'\n`,
}

if (dryRun) {
  console.log(JSON.stringify({ dir: `packages/ui/src/components/${id}`, files: Object.keys(files) }, null, 2))
  process.exit(0)
}
mkdirSync(dir, { recursive: true })
for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content)
const index = join(uiRoot, 'src', 'index.ts')
const line = `export * from './components/${id}/index.ts'\n`
if (!readFileSync(index, 'utf8').includes(line)) appendFileSync(index, line)
console.log(`Scaffolded packages/ui/src/components/${id} (status draft). Next:
  1. implement it with semantic tokens and message keys; one story per state (${states.join(', ')});
  2. replace every TODO in ${id}.docs.md;
  3. npm run ui:manifest, then npm run ui:catalog:check and npm run ui:check:browser;
  4. list it in your hand-off as a new draft; never set "approved".`)
