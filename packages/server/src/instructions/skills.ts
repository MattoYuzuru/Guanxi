import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { assertBudget, openRegularFile, readFailureCode, readToEnd } from './safe-read.ts'

export interface SkillSource { kind: 'project' | 'user'; root: string }
export interface SkillSummary { id: string; name: string; description: string; source: 'project' | 'user'; dir: string; bytes: number }
export interface SkillIndex { skills: SkillSummary[]; warnings: { path: string; code: string }[] }

/** Allowed real-path boundary per skill id, captured while the index was built. */
const boundaries = new WeakMap<SkillIndex, ReadonlyMap<string, string>>()

const FRONT_MATTER_LIMIT = 8 * 1024
const READ_CHUNK = 512

interface FrontMatterFile { text: string; bodyOffset: number; size: number }
/** Front matter plus the byte count actually read, for bounded-read tests. */
export interface SkillHead extends FrontMatterFile { bytesRead: number }
/** Discovery read seam: production reads the filesystem; tests can observe bounds. */
export type SkillHeadReader = (path: string, maxBytes: number) => Promise<SkillHead | null>
export interface SkillDirectoryEntry { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }
/** Discovery directory seam; entries are sorted by name before processing. */
export type SkillDirectoryReader = (path: string) => Promise<SkillDirectoryEntry[]>

interface ScanSource extends SkillSource { boundary: string; scan: string }
interface Candidate { source: ScanSource; dir: string; file: string }

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function inside(root: string, candidate: string): boolean {
  const result = relative(root, candidate)
  return result === '' || (!result.startsWith(`..${sep}`) && result !== '..' && !isAbsolute(result))
}

/** Locates the closing `---` line without decoding or parsing the body. */
function findFrontMatter(buffer: Buffer, complete: boolean): { text: string; bodyOffset: number } | null {
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
  const start = bom ? 3 : 0
  const firstBreak = buffer.indexOf(0x0a, start)
  if (firstBreak === -1) return null
  if (buffer.toString('utf8', start, firstBreak).replace(/\r$/, '').trim() !== '---') return null
  let lineStart = firstBreak + 1
  while (lineStart <= buffer.length) {
    const lineBreak = buffer.indexOf(0x0a, lineStart)
    const lineEnd = lineBreak === -1 ? buffer.length : lineBreak
    if (buffer.toString('utf8', lineStart, lineEnd).replace(/\r$/, '').trim() === '---') {
      // A chunk can end in the middle of a line. Only an unterminated final
      // line at EOF is a valid delimiter; otherwise wait for the next chunk.
      if (lineBreak === -1 && !complete) return null
      return {
        text: buffer.toString('utf8', firstBreak + 1, lineStart),
        bodyOffset: lineBreak === -1 ? buffer.length : lineBreak + 1,
      }
    }
    if (lineBreak === -1) return null
    lineStart = lineBreak + 1
  }
  return null
}

/**
 * Reads at most `maxBytes`, stopping as soon as the closing delimiter is seen.
 * The returned `bytesRead` lets tests prove discovery never asks for or reads
 * a whole body.
 */
export async function readSkillHead(path: string, maxBytes: number): Promise<SkillHead | null> {
  const handle = await openRegularFile(path)
  try {
    const info = await handle.stat()
    const chunks: Buffer[] = []
    let total = 0
    while (total < maxBytes && total < info.size) {
      const length = Math.min(READ_CHUNK, maxBytes - total, info.size - total)
      const chunk = Buffer.alloc(length)
      const { bytesRead } = await handle.read(chunk, 0, length, total)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      total += bytesRead
      const found = findFrontMatter(Buffer.concat(chunks), total >= info.size)
      if (found) return { ...found, size: info.size, bytesRead: total }
    }
    return null
  } finally {
    await handle.close()
  }
}

function parseQuoted(text: string, quote: '"' | "'"): string | null {
  if (text[0] !== quote) return null
  let value = ''
  for (let index = 1; index < text.length; index++) {
    const character = text[index]!
    if (character === quote) {
      if (quote === "'" && text[index + 1] === "'") {
        value += "'"
        index++
        continue
      }
      return value
    }
    if (quote === '"' && character === '\\') {
      const next = text[index + 1]
      if (next === undefined) return null
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))) {
        value += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 6), 16))
        index += 5
        continue
      }
      if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(text.slice(index + 2, index + 4))) {
        value += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 4), 16))
        index += 3
        continue
      }
      value += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next === 'b' ? '\b' : next === 'f' ? '\f' : next
      index++
      continue
    }
    value += character
  }
  return null
}

/** Minimal YAML scalar parser: quoted or plain `key: value`. */
function parseScalar(raw: string): string {
  const text = raw.trim()
  if (text.startsWith('"')) return parseQuoted(text, '"') ?? text
  if (text.startsWith("'")) return parseQuoted(text, "'") ?? text
  const comment = text.search(/\s#/)
  return (comment === -1 ? text : text.slice(0, comment)).trim()
}

function fold(lines: string[]): string {
  let value = ''
  for (const line of lines) {
    if (line === '') {
      value += '\n'
      continue
    }
    if (value && !value.endsWith('\n')) value += ' '
    value += line
  }
  return value.replace(/[ \t]+\n/g, '\n').replace(/\n+$/, '')
}

function parseBlock(lines: string[], start: number, style: '>' | '|', keyIndent: number): { value: string; next: number } {
  const content: string[] = []
  let indent: number | null = null
  let index = start + 1
  for (; index < lines.length; index++) {
    const line = lines[index]!
    if (line.trim() === '') {
      content.push('')
      continue
    }
    const leading = line.length - line.trimStart().length
    if (indent === null) {
      // YAML requires block content to be indented more than its key. A
      // dedented line belongs to the next key, never to this scalar.
      if (leading <= keyIndent) break
      indent = leading
    }
    if (leading < indent) break
    content.push(line.slice(indent))
  }
  while (content.length > 0 && content[content.length - 1] === '') content.pop()
  return {
    value: style === '|' ? content.join('\n').replace(/\n+$/, '') : fold(content),
    next: index,
  }
}

/**
 * Parses the small YAML subset used by Agent Skills. Explicit indentation
 * indicators (`|2`, `>2`) and plain multi-line continuation are unsupported:
 * an indented line after a plain scalar is ignored, not appended.
 */
export function parseSkillFrontMatter(raw: string): Record<string, string> {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n')
  const values: Record<string, string> = Object.create(null)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (line.startsWith(' ') || line.startsWith('\t')) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) continue
    const rest = line.slice(colon + 1).trim()
    if (/^[>|][+-]?$/.test(rest)) {
      const block = parseBlock(lines, index, rest[0] as '>' | '|', 0)
      values[key] = block.value
      index = block.next - 1
      continue
    }
    values[key] = parseScalar(rest)
  }
  return values
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

function truncate(text: string, max: number | undefined): string {
  if (max === undefined || !Number.isFinite(max)) return text
  const limit = Math.max(0, Math.floor(max))
  const points = [...text]
  if (points.length <= limit) return text
  if (limit === 0) return ''
  return `${points.slice(0, limit - 1).join('')}…`
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visited = new Set<string>()
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let real: string
    try { real = await realpath(directory) } catch { return }
    if (!inside(root, real) || visited.has(real)) return
    visited.add(real)
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    entries.sort((left, right) => compareText(left.name, right.name))
    for (const entry of entries) {
      if (!prefix && entry.name === 'SKILL.md') continue
      const path = join(directory, entry.name)
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      let realEntry: string
      try { realEntry = await realpath(path) } catch { continue }
      if (!inside(root, realEntry)) continue
      const info = await stat(path).catch(() => null)
      if (info?.isDirectory()) {
        await walk(path, name)
        continue
      }
      if (info?.isFile()) files.push(name)
    }
  }
  await walk(root, '')
  return files.sort(compareText)
}

/**
 * Discovers Agent Skills from the project and user roots. Only the front matter
 * is read; bodies stay on disk until `loadSkill`.
 */
export async function discoverSkills(input: {
  projectRoot: string
  userSkillDirs: string[]
  maxSkills?: number
  maxDescriptionChars?: number
  /** Test seam; defaults to the bounded filesystem reader. */
  readHead?: SkillHeadReader
  /** Test seam; defaults to `readdir` with file types. */
  readDirectory?: SkillDirectoryReader
}): Promise<SkillIndex> {
  const projectRoot = await realpath(input.projectRoot)
  const readHead = input.readHead ?? readSkillHead
  const readDirectory: SkillDirectoryReader = input.readDirectory
    ?? (async path => readdir(path, { withFileTypes: true }))
  const maxSkills = input.maxSkills === undefined
    ? undefined
    : Math.floor(assertBudget(input.maxSkills, 'max_skills_invalid'))
  if (input.maxDescriptionChars !== undefined) assertBudget(input.maxDescriptionChars, 'max_description_chars_invalid')
  const sources: ScanSource[] = [
    { kind: 'project', root: join(projectRoot, '.agents/skills'), boundary: projectRoot, scan: join(projectRoot, '.agents/skills') },
    { kind: 'project', root: join(projectRoot, '.claude/skills'), boundary: projectRoot, scan: join(projectRoot, '.claude/skills') },
  ]
  for (const directory of input.userSkillDirs) {
    let root: string
    try { root = await realpath(directory) } catch { continue }
    sources.push({ kind: 'user', root, boundary: root, scan: root })
  }

  const warnings: SkillIndex['warnings'] = []
  const projectCandidates: Candidate[] = []
  const userCandidates: Candidate[] = []
  const scans = new Set<string>()
  for (const source of sources) {
    let scan: string
    try { scan = await realpath(source.scan) } catch { continue }
    const key = `${source.kind}:${scan}`
    if (scans.has(key)) continue
    scans.add(key)
    if (!inside(source.boundary, scan)) {
      warnings.push({ path: source.root, code: 'outside_root' })
      continue
    }
    let entries
    try { entries = await readDirectory(scan) } catch { continue }
    entries.sort((left, right) => compareText(left.name, right.name))
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const dir = join(scan, entry.name)
      let realDir: string
      try { realDir = await realpath(dir) } catch { continue }
      if (!inside(source.boundary, realDir)) {
        warnings.push({ path: dir, code: 'outside_root' })
        continue
      }
      const file = join(dir, 'SKILL.md')
      let realFile: string
      try { realFile = await realpath(file) } catch { continue }
      if (!inside(source.boundary, realFile)) {
        warnings.push({ path: file, code: 'outside_root' })
        continue
      }
      const info = await stat(realFile).catch(() => null)
      if (!info) continue
      if (!info.isFile()) {
        warnings.push({ path: file, code: 'not_regular_file' })
        continue
      }
      const candidate: Candidate = { source, dir: realDir, file: realFile }
      if (source.kind === 'project') projectCandidates.push(candidate)
      else userCandidates.push(candidate)
    }
  }
  projectCandidates.sort((left, right) => compareText(left.file, right.file))
  userCandidates.sort((left, right) => compareText(left.file, right.file))

  const found = new Map<string, { summary: SkillSummary; boundary: string }>()
  const realFiles = new Set<string>()
  for (const candidate of [...projectCandidates, ...userCandidates]) {
    if (realFiles.has(candidate.file)) continue
    realFiles.add(candidate.file)
    let head: FrontMatterFile | null
    try {
      head = await readHead(candidate.file, FRONT_MATTER_LIMIT)
    } catch (error) {
      warnings.push({ path: candidate.file, code: readFailureCode(error) ?? 'invalid_front_matter' })
      continue
    }
    const values = head ? parseSkillFrontMatter(head.text) : null
    const name = (values?.name ?? '').trim()
    const description = (values?.description ?? '').trim()
    if (!head || !SKILL_NAME.test(name) || !description) {
      warnings.push({ path: candidate.file, code: 'invalid_front_matter' })
      continue
    }
    const existing = found.get(name)
    if (existing) {
      const shadowed = candidate.source.kind === 'user' && existing.summary.source === 'project'
      warnings.push({ path: candidate.file, code: shadowed ? 'shadowed' : 'duplicate' })
      continue
    }
    found.set(name, {
      summary: {
        id: `${candidate.source.kind}:${name}`,
        name,
        description: truncate(description, input.maxDescriptionChars),
        source: candidate.source.kind,
        dir: candidate.dir,
        bytes: head.size,
      },
      boundary: candidate.source.boundary,
    })
  }

  const ordered = [...found.values()].sort((left, right) =>
    compareText(left.summary.name, right.summary.name) ||
    compareText(left.summary.source, right.summary.source) ||
    compareText(left.summary.dir, right.summary.dir))
  const limit = maxSkills ?? Number.POSITIVE_INFINITY
  const kept = Number.isFinite(limit) ? ordered.slice(0, limit) : ordered
  for (const entry of ordered.slice(kept.length)) {
    warnings.push({ path: join(entry.summary.dir, 'SKILL.md'), code: 'max_skills' })
  }
  const index: SkillIndex = { skills: kept.map(entry => entry.summary), warnings }
  boundaries.set(index, new Map(kept.map(entry => [entry.summary.id, entry.boundary])))
  return index
}

/**
 * Renders only summaries. The result is deterministic and never exceeds the
 * caller's budget; when even the omission notice does not fit, text is empty.
 */
export function skillContext(index: SkillIndex, count: (text: string) => number, budget: number): { text: string; included: number; omitted: number } {
  const summaries = [...index.skills].sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id))
  const lines = summaries.map(skill => `- ${skill.name}: ${skill.description.replace(/\s+/g, ' ').trim()}`)
  const available = assertBudget(budget, 'skill_context_budget_invalid')
  const all = lines.join('\n')
  if (count(all) <= available) return { text: all, included: lines.length, omitted: 0 }
  for (let included = lines.length - 1; included >= 0; included--) {
    const omitted = lines.length - included
    const notice = `- ${omitted} more ${omitted === 1 ? 'skill' : 'skills'} omitted (context budget)`
    const text = [...lines.slice(0, included), notice].join('\n')
    if (count(text) <= available) return { text, included, omitted }
  }
  return { text: '', included: 0, omitted: lines.length }
}

/** Reads an invoked skill body and lists its files; never truncates a body. */
export async function loadSkill(
  index: SkillIndex,
  id: string,
  opts: { maxBodyBytes: number },
): Promise<
  { id: string; body: string; files: string[]; truncated: false } |
  { id: string; error: 'not_found' | 'too_large' | 'outside_root' | 'unreadable' | 'not_regular_file' }
> {
  const maxBodyBytes = assertBudget(opts.maxBodyBytes, 'max_body_bytes_invalid')
  const summary = index.skills.find(skill => skill.id === id)
  if (!summary) return { id, error: 'not_found' }
  let dir: string
  let file: string
  try {
    dir = await realpath(summary.dir)
    file = await realpath(join(summary.dir, 'SKILL.md'))
  } catch {
    return { id, error: 'not_found' }
  }
  const boundary = boundaries.get(index)?.get(id)
  if (!boundary) return { id, error: 'outside_root' }
  if (!inside(boundary, dir) || !inside(boundary, file)) return { id, error: 'outside_root' }
  let head: FrontMatterFile | null
  try {
    head = await readSkillHead(file, FRONT_MATTER_LIMIT)
  } catch (error) {
    return { id, error: readFailureCode(error) ?? 'not_found' }
  }
  if (!head) return { id, error: 'not_found' }
  const bodyBytes = head.size - head.bodyOffset
  if (bodyBytes < 0) return { id, error: 'not_found' }
  if (bodyBytes > maxBodyBytes) return { id, error: 'too_large' }
  let body: Buffer
  try {
    const handle = await openRegularFile(file)
    try {
      const read = await readToEnd(handle, head.bodyOffset, maxBodyBytes)
      if (read.overflow) return { id, error: 'too_large' }
      body = read.bytes
    } finally {
      await handle.close()
    }
  } catch (error) {
    return { id, error: readFailureCode(error) ?? 'not_found' }
  }
  return { id, body: body.toString('utf8'), files: await listFiles(dir), truncated: false }
}
