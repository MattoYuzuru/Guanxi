/**
 * `<name>.docs.md` reader shared by the in-app catalog, the manifest builder and G10. Front
 * matter is a small YAML subset: `key: scalar` and `key: [a, b]` lines only.
 */
export const REQUIRED_DOC_SECTIONS = [
  'Purpose',
  'When to use',
  'When not to use',
  'Anatomy and variants',
  'States',
  'Accessibility',
  'Content and i18n',
  'Motion',
  'Do / Don\'t',
] as const

export const REQUIRED_FRONTMATTER = ['id', 'level', 'states', 'tokens', 'since'] as const

export type ComponentLevel = 'primitive' | 'pattern'

export interface ComponentDocs {
  frontmatter: Record<string, string | string[]>
  id: string | null
  level: ComponentLevel | null
  states: string[]
  tokens: string[]
  since: string | null
  title: string | null
  sections: Record<string, string>
  body: string
}

function parseValue(raw: string): string | string[] {
  const value = raw.trim()
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    return inner === '' ? [] : inner.split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
  }
  return value.replace(/^['"]|['"]$/g, '')
}

export function parseDocs(source: string): ComponentDocs {
  const text = source.replace(/\r\n/g, '\n')
  const frontmatter: Record<string, string | string[]> = {}
  let body = text
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (match) {
    body = text.slice(match[0].length)
    for (const line of (match[1] ?? '').split('\n')) {
      const separator = line.indexOf(':')
      if (separator <= 0) continue
      frontmatter[line.slice(0, separator).trim()] = parseValue(line.slice(separator + 1))
    }
  }
  const list = (key: string) => {
    const value = frontmatter[key]
    return Array.isArray(value) ? value : []
  }
  const scalar = (key: string) => {
    const value = frontmatter[key]
    return typeof value === 'string' && value !== '' ? value : null
  }
  const sections: Record<string, string> = {}
  let title: string | null = null
  let current: string | null = null
  for (const line of body.split('\n')) {
    const h1 = /^# (.+)$/.exec(line)
    const h2 = /^## (.+)$/.exec(line)
    if (h1 && title === null) title = (h1[1] ?? '').trim()
    if (h2) {
      current = (h2[1] ?? '').trim()
      sections[current] = ''
      continue
    }
    if (current !== null) sections[current] += `${line}\n`
  }
  for (const key of Object.keys(sections)) sections[key] = (sections[key] ?? '').trim()
  const level = scalar('level')
  return {
    frontmatter,
    id: scalar('id'),
    level: level === 'primitive' || level === 'pattern' ? level : null,
    states: list('states'),
    tokens: list('tokens'),
    since: scalar('since'),
    title,
    sections,
    body,
  }
}

/** Problems G10 reports for one docs file. */
export function docsProblems(docs: ComponentDocs, expectedId: string): string[] {
  const problems: string[] = []
  for (const key of REQUIRED_FRONTMATTER) {
    if (!(key in docs.frontmatter)) problems.push(`front matter lacks "${key}"`)
  }
  if (docs.id !== expectedId) problems.push(`front matter id "${docs.id ?? ''}" is not "${expectedId}"`)
  if (docs.level === null) problems.push('front matter level is not primitive or pattern')
  if (docs.states.length === 0) problems.push('front matter declares no states')
  if (new Set(docs.states).size !== docs.states.length) problems.push('front matter repeats a state')
  for (const section of REQUIRED_DOC_SECTIONS) {
    if (!(section in docs.sections)) problems.push(`missing section "## ${section}"`)
    else if ((docs.sections[section] ?? '').length === 0) problems.push(`section "## ${section}" is empty`)
    else if (/\bTODO\b/.test(docs.sections[section] ?? '')) problems.push(`section "## ${section}" still has a TODO`)
  }
  return problems
}
