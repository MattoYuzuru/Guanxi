import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { assertBudget, readFailureCode } from './safe-read.ts'

interface Candidate {
  path: string
  bytes: number
  real: string
  outside: boolean
}

function inside(root: string, candidate: string): boolean {
  const result = relative(root, candidate)
  return result === '' || (!result.startsWith(`..${sep}`) && result !== '..' && !isAbsolute(result))
}

function posixPath(root: string, target: string): string {
  return relative(root, target).split(sep).join('/')
}

/**
 * Loads instruction files from `cwd` up to `projectRoot` without cutting a file
 * in the middle. Nearest files are tried first; the first that does not fit and
 * every farther file are reported as omitted. Returned text is project-root
 * first, nearest last, so the nearest instructions take precedence when read.
 */
export async function loadInstructions(input: {
  projectRoot: string
  cwd: string
  budgetBytes: number
  fileNames?: string[]
}): Promise<{
  files: { path: string; bytes: number; included: boolean }[]
  text: string
  unreadable: string[]
  overflow: null | { totalBytes: number; budgetBytes: number; omitted: string[] }
}> {
  const budget = assertBudget(input.budgetBytes, 'instructions_budget_invalid')
  const projectRoot = await realpath(input.projectRoot)
  let cwd: string
  try {
    cwd = await realpath(input.cwd)
  } catch {
    throw new TypeError('instructions_cwd_outside_project_root')
  }
  if (!inside(projectRoot, cwd)) throw new TypeError('instructions_cwd_outside_project_root')

  const names = [...new Set(input.fileNames ?? ['AGENTS.md'])]
  for (const name of names) {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      throw new TypeError('instructions_file_name_invalid')
    }
  }

  const directories: string[] = []
  let current = cwd
  while (true) {
    directories.push(current)
    if (current === projectRoot) break
    const parent = dirname(current)
    if (parent === current) throw new TypeError('instructions_cwd_outside_project_root')
    current = parent
  }

  const groups: { items: Candidate[] }[] = []
  for (const directory of directories) {
    const items: Candidate[] = []
    for (const name of names) {
      const absolute = join(directory, name)
      const info = await stat(absolute).catch(() => null)
      if (!info?.isFile()) continue
      let real: string
      try { real = await realpath(absolute) } catch { continue }
      items.push({
        path: posixPath(projectRoot, absolute),
        bytes: info.size,
        real,
        outside: !inside(projectRoot, real),
      })
    }
    groups.push({ items })
  }

  const ordered = [...groups].reverse().flatMap(group => group.items)
  const included = new Set<Candidate>()
  const omitted = new Set<Candidate>()
  let used = 0
  let stopped = false
  for (const candidate of groups.flatMap(group => group.items)) {
    if (candidate.outside) continue
    if (!stopped && used + candidate.bytes <= budget) {
      included.add(candidate)
      used += candidate.bytes
    } else {
      stopped = true
      omitted.add(candidate)
    }
  }

  const totalBytes = groups.flatMap(group => group.items)
    .filter(candidate => !candidate.outside)
    .reduce((total, candidate) => total + candidate.bytes, 0)
  const omittedPaths = ordered.filter(candidate => omitted.has(candidate)).map(candidate => candidate.path)
  const outsidePaths = ordered.filter(candidate => candidate.outside).map(candidate => candidate.path)

  const parts: string[] = []
  const unreadable: string[] = []
  for (const candidate of ordered) {
    if (!included.has(candidate)) continue
    try {
      parts.push(`## ${candidate.path}\n${await readFile(candidate.real, 'utf8')}`)
    } catch (error) {
      if (readFailureCode(error) !== 'unreadable') throw error
      included.delete(candidate)
      unreadable.push(candidate.path)
    }
  }
  let text = parts.join('\n\n')
  if (outsidePaths.length > 0) {
    const notice = `Skipped instruction files outside the project root: ${outsidePaths.join(', ')}.`
    text = text ? `${text}\n\n${notice}` : notice
  }
  if (unreadable.length > 0) {
    const notice = `Unreadable instruction files: ${unreadable.join(', ')}.`
    text = text ? `${text}\n\n${notice}` : notice
  }
  if (omittedPaths.length > 0) {
    const notice = `Omitted instruction files: ${omittedPaths.join(', ')} (budget ${budget} bytes; ${totalBytes} bytes found).`
    text = text ? `${text}\n\n${notice}` : notice
  }

  return {
    files: ordered.map(candidate => ({ path: candidate.path, bytes: candidate.bytes, included: included.has(candidate) })),
    text,
    unreadable,
    overflow: omittedPaths.length > 0
      ? { totalBytes, budgetBytes: budget, omitted: omittedPaths }
      : null,
  }
}
