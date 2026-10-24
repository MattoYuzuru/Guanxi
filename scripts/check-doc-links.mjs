#!/usr/bin/env node
// Relative link and anchor checker for Markdown docs. Node built-ins only.
// Usage: node scripts/check-doc-links.mjs [--json] [root]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'build', '.lane-data', '.ci-results', 'test-results'])
const EXCLUDED_PATHS = [
  'docs/research/2026-10-19-landscape',
  'docs/research/2026-10-20-design',
  'docs/research/2026-10-21-fleet',
]

export function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-')
}

function blank(line) {
  return ' '.repeat(line.length)
}

// Blank an HTML comment segment while keeping every character position intact.
function maskCommentsLine(line, startInComment) {
  let inComment = startInComment
  let out = ''
  let i = 0
  while (i < line.length) {
    if (inComment) {
      const end = line.indexOf('-->', i)
      if (end === -1) {
        out += ' '.repeat(line.length - i)
        i = line.length
      } else {
        out += ' '.repeat(end + 3 - i)
        i = end + 3
        inComment = false
      }
      continue
    }
    const start = line.indexOf('<!--', i)
    if (start === -1) {
      out += line.slice(i)
      i = line.length
    } else {
      out += line.slice(i, start) + '    '
      i = start + 4
      inComment = true
    }
  }
  return { text: out, inComment }
}

// Replace fenced code blocks and HTML comments with spaces, preserving offsets.
function maskBlocks(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let fence = null
  let inComment = false
  for (const line of lines) {
    if (fence) {
      out.push(blank(line))
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null
      continue
    }
    if (inComment) {
      const masked = maskCommentsLine(line, true)
      out.push(masked.text)
      inComment = masked.inComment
      continue
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (open) {
      fence = { char: open[1][0], length: open[1].length }
      out.push(blank(line))
      continue
    }
    const masked = maskCommentsLine(line, false)
    out.push(masked.text)
    inComment = masked.inComment
  }
  return out.join('\n')
}

// Blank inline code spans on one line so links inside them are not extracted.
function maskInlineCode(line) {
  const chars = line.split('')
  let i = 0
  while (i < line.length) {
    if (line[i] !== '`') {
      i++
      continue
    }
    let size = 0
    while (line[i + size] === '`') size++
    let close = -1
    let j = i + size
    while (j < line.length) {
      if (line[j] === '`') {
        let run = 0
        while (line[j + run] === '`') run++
        if (run === size) {
          close = j
          break
        }
        j += run
      } else {
        j++
      }
    }
    if (close === -1) {
      i += size
      continue
    }
    for (let k = i; k < close + size; k++) chars[k] = ' '
    i = close + size
  }
  return chars.join('')
}

function headingText(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/<[^>]*>/g, '')
}

function addHeading(text, anchors, seen) {
  const base = slugify(text)
  const count = seen.get(base) ?? 0
  anchors.add(count === 0 ? base : `${base}-${count}`)
  seen.set(base, count + 1)
}

function isSetextText(line) {
  if (line.trim() === '') return false
  if (/^ {4}/.test(line)) return false
  if (/^ {0,3}(=+|-+)[ \t]*$/.test(line)) return false
  if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) return false
  if (line.includes('|')) return false
  return true
}

function addExplicitAnchors(text, anchors) {
  const tag = /<[A-Za-z][^>\n]*>/g
  let match
  while ((match = tag.exec(text)) !== null) {
    const raw = match[0]
    const id = /(?:^|\s)id\s*=\s*("([^"]*)"|'([^']*)')/i.exec(raw)
    if (id) anchors.add(id[2] ?? id[3])
    if (/^<a\b/i.test(raw)) {
      const name = /(?:^|\s)name\s*=\s*("([^"]*)"|'([^']*)')/i.exec(raw)
      if (name) anchors.add(name[2] ?? name[3])
    }
  }
}

export function collectAnchors(markdownText) {
  const masked = maskBlocks(markdownText)
  const lines = masked.split('\n')
  const anchors = new Set()
  const seen = new Map()
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const atx = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(line)
    if (atx) {
      addHeading(headingText(atx[2].replace(/\s+#+\s*$/, '')), anchors, seen)
      i++
      continue
    }
    if (i + 1 < lines.length && isSetextText(line) && /^ {0,3}(=+|-+)[ \t]*$/.test(lines[i + 1])) {
      addHeading(headingText(line), anchors, seen)
      i += 2
      continue
    }
    i++
  }
  addExplicitAnchors(masked, anchors)
  return anchors
}

function readParens(line, open) {
  let depth = 0
  for (let i = open; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return { inner: line.slice(open + 1, i), end: i + 1 }
    }
  }
  return null
}

function parseTarget(raw) {
  const text = raw.trim()
  if (text.startsWith('<')) {
    const close = text.indexOf('>')
    if (close === -1) return ''
    return text.slice(1, close).trim()
  }
  return text.split(/[ \t]/)[0] ?? ''
}

function extractInlineLinks(line, lineNumber) {
  const masked = maskInlineCode(line)
  const links = []
  let i = 0
  while (i < masked.length) {
    if (masked[i] === '\\') {
      i += 2
      continue
    }
    let bracket = -1
    if (masked[i] === '!' && masked[i + 1] === '[') bracket = i + 1
    else if (masked[i] === '[') bracket = i
    if (bracket === -1) {
      i++
      continue
    }
    let depth = 0
    let close = -1
    for (let j = bracket; j < masked.length; j++) {
      if (masked[j] === '\\') {
        j++
        continue
      }
      if (masked[j] === '[') depth++
      else if (masked[j] === ']') {
        depth--
        if (depth === 0) {
          close = j
          break
        }
      }
    }
    if (close === -1 || masked[close + 1] !== '(') {
      i = bracket + 1
      continue
    }
    const parens = readParens(masked, close + 1)
    if (!parens) {
      i = bracket + 1
      continue
    }
    const target = parseTarget(parens.inner)
    if (target) links.push({ target, line: lineNumber, column: bracket + 1 })
    i = parens.end
  }
  return links
}

function extractLinks(text) {
  const lines = maskBlocks(text).split('\n')
  const links = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const def = /^ {0,3}\[([^\]]+)\]:[ \t]*(.*)$/.exec(line)
    if (def) {
      const target = parseTarget(def[2])
      if (target) links.push({ target, line: i + 1, column: line.indexOf('[') + 1 })
      continue
    }
    links.push(...extractInlineLinks(line, i + 1))
  }
  return links
}

function anchorsFor(file, cache) {
  if (!cache.has(file)) cache.set(file, collectAnchors(readFileSync(file, 'utf8')))
  return cache.get(file)
}

function inspectTarget({ rootAbs, absFile, target, anchorCache }) {
  const hash = target.indexOf('#')
  const pathPart = hash === -1 ? target : target.slice(0, hash)
  const fragmentPart = hash === -1 ? null : target.slice(hash + 1)
  let decodedPath
  try {
    decodedPath = decodeURIComponent(pathPart)
  } catch {
    return { kind: 'bad-encoding', target, message: 'invalid percent-encoding in path' }
  }

  let resolved
  if (decodedPath.startsWith('/')) {
    if (decodedPath.startsWith('/Users/') || decodedPath.startsWith('/home/')) {
      return { kind: 'absolute-path', target, message: 'machine-specific absolute path' }
    }
    resolved = resolve(rootAbs, `.${decodedPath}`)
  } else if (decodedPath === '') {
    resolved = absFile
  } else {
    resolved = resolve(dirname(absFile), decodedPath)
  }

  // A link that leaves the repository works only on the machine that wrote it.
  const fromRoot = relative(rootAbs, resolved)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    return { kind: 'outside-root', target, message: 'target is outside the repository' }
  }
  if (!existsSync(resolved)) return { kind: 'missing-file', target, message: 'target does not exist' }
  if (fragmentPart === null) return null

  const isMarkdown = decodedPath === '' || resolved.toLowerCase().endsWith('.md')
  if (!isMarkdown) return null
  try {
    if (statSync(resolved).isDirectory()) return null
  } catch {
    return null
  }

  let fragment
  try {
    fragment = decodeURIComponent(fragmentPart)
  } catch {
    return { kind: 'bad-encoding', target, message: 'invalid percent-encoding in fragment' }
  }
  if (fragment === '') return { kind: 'missing-anchor', target, message: 'empty anchor' }
  if (!anchorsFor(resolved, anchorCache).has(fragment)) {
    return { kind: 'missing-anchor', target, message: `anchor "#${fragment}" not found` }
  }
  return null
}

function runCheck(root, files) {
  const rootAbs = resolve(root)
  const anchorCache = new Map()
  const problems = []
  let links = 0
  for (const file of files) {
    const absFile = isAbsolute(file) ? resolve(file) : resolve(rootAbs, file)
    const relFile = relative(rootAbs, absFile).split(sep).join('/')
    const text = readFileSync(absFile, 'utf8')
    for (const link of extractLinks(text)) {
      const target = link.target.trim()
      if (target === '' || target.startsWith('//') || SCHEME.test(target)) continue
      links++
      const problem = inspectTarget({ rootAbs, absFile, target, anchorCache })
      if (problem) {
        problems.push({
          file: relFile,
          line: link.line,
          column: link.column,
          kind: problem.kind,
          target: problem.target,
          message: problem.message,
        })
      }
    }
  }
  return { files: files.length, links, problems }
}

export function checkLinks({ root, files }) {
  return runCheck(root, files).problems
}

function isExcludedPath(rel) {
  return EXCLUDED_PATHS.some(p => rel === p || rel.startsWith(`${p}/`))
}

export function listMarkdownFiles(root) {
  const rootAbs = resolve(root)
  const found = []
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const rel = relative(rootAbs, abs).split(sep).join('/')
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue
        if (rel === '.claude/worktrees' || rel.endsWith('/.claude/worktrees')) continue
        if (EXCLUDED_PATHS.includes(rel)) continue
        walk(abs)
      } else if (entry.isFile() && entry.name.endsWith('.md') && !isExcludedPath(rel)) {
        found.push(rel)
      }
    }
  }
  walk(rootAbs)
  return found.sort()
}

function cli(argv) {
  let json = false
  const positional = []
  for (const arg of argv) {
    if (arg === '--json') json = true
    else if (arg.startsWith('-')) {
      console.error(`unknown option: ${arg}`)
      return 2
    } else {
      positional.push(arg)
    }
  }
  if (positional.length > 1) {
    console.error('expected at most one root')
    return 2
  }
  const root = positional[0] ?? process.cwd()
  let stats
  try {
    stats = statSync(root)
  } catch {
    console.error(`root does not exist: ${root}`)
    return 2
  }
  if (!stats.isDirectory()) {
    console.error(`root is not a directory: ${root}`)
    return 2
  }

  const files = listMarkdownFiles(root)
  const result = runCheck(root, files)
  if (json) {
    console.log(JSON.stringify({ files: result.files, links: result.links, problems: result.problems }, null, 2))
  } else {
    for (const p of result.problems) {
      console.log(`${p.file}:${p.line}:${p.column}  ${p.kind}  ${p.target}  ${p.message}`)
    }
    console.log(`checked ${result.files} files, ${result.links} links, ${result.problems.length} problems`)
  }
  return result.problems.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = cli(process.argv.slice(2))
}
