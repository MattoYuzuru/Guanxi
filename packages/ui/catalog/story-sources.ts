/** Raw story files for the catalog's Code tab, keyed by component id. */
const sources = import.meta.glob(
  ['../src/components/*/*.stories.tsx', '!../src/components/*/*.test.stories.tsx'],
  { eager: true, query: '?raw', import: 'default' },
)

export const storySources: Record<string, string> = Object.fromEntries(
  Object.entries(sources).map(([path, source]) => {
    const parts = path.split('/')
    return [parts[parts.length - 2] ?? path, String(source)]
  }),
)
