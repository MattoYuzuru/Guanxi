import { execFileSync } from 'node:child_process'

export function affected(files) {
  const areas = new Set()
  for (const file of files) {
    if (/^(docs\/|.*\.md$)/.test(file)) areas.add('docs')
    else if (/^packages\/(server|cli)\//.test(file)) areas.add('server')
    else if (/^packages\/web\//.test(file)) areas.add('web')
    else if (/^packages\/ui\//.test(file)) areas.add('ui')
    else if (/^packages\/kernel\//.test(file)) areas.add('kernel')
    else if (/^packages\/bench\//.test(file)) areas.add('bench')
    else areas.add('shared')
  }
  return {
    areas: [...areas].sort(),
    guidance: [...areas].sort().map(area => ({ area, commands: {
      docs: ['npm run lint:md'],
      server: ['node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test <changed-and-dependent-test-files>', 'npm run typecheck --workspace @guanxi/server'],
      web: ['npm exec --workspace @guanxi/web -- vitest run <related-test-files>', 'npm run typecheck --workspace @guanxi/web', 'npm run test:browser --workspace @guanxi/web -- <related-specs>'],
      ui: ['npm run ui:check', 'npm exec --workspace @guanxi/ui -- vitest run <related-test-files>', 'browser checks for changed stories under the shared lock'],
      kernel: ['node --test <related-kernel-test-files>', 'npm run typecheck --workspace @guanxi/kernel'],
      bench: ['node --test <related-bench-test-files>', 'npm run typecheck --workspace @guanxi/bench'],
      shared: ['Inspect transitive consumers; contract/config/dependencies/unknown paths widen scope. Final full CI is mandatory.'],
    }[area] })),
    note: 'Read-only guidance, not automatic proof of complete dependency coverage. Choose exact tests and explain the scope; full final CI is unchanged.',
  }
}
if (process.argv[1] === import.meta.filename) {
  try {
    const base = process.argv[2] ?? 'origin/main'
    const git = args => execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean)
    const files = [...new Set([...git(['diff', '--name-only', `${base}...HEAD`]), ...git(['diff', '--name-only', 'HEAD']), ...git(['ls-files', '--others', '--exclude-standard'])])]
    console.log(JSON.stringify(affected(files), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
