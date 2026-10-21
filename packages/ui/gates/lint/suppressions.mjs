import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'

export const suppressionPath = 'eslint-suppressions.json'
const object = value => value && typeof value === 'object' && !Array.isArray(value)
export function validateSuppressions(data) {
  const errors = []
  if (!object(data)) return ['Invalid ESLint suppression file']
  for (const [file, rules] of Object.entries(data)) {
    if (!/^packages\/web\/src\/.+\.(?:[cm]?[jt]sx?|css|svg|html)$/.test(file) || file.includes('..') || !object(rules) || !Object.keys(rules).length) errors.push(`Invalid legacy suppression path: ${file}`)
    for (const [rule, entry] of Object.entries(rules ?? {})) if (!rule.startsWith('guanxi/') || !object(entry) || Object.keys(entry).join() !== 'count' || !Number.isInteger(entry.count) || entry.count < 1) errors.push(`Invalid suppression: ${file} ${rule}`)
  }
  return errors
}
export function growthErrors(before, after, where = '') {
  return Object.entries(after).flatMap(([file, rules]) => Object.entries(rules).flatMap(([rule, entry]) => entry.count > (before[file]?.[rule]?.count ?? 0) ? [`ESLint suppression grew${where}: ${file} ${rule}`] : []))
}
// Audit every actual parent edge. A removed/restored file or a grow-then-shrink commit
// cannot reset the budget; merges must preserve the reductions of both parents.
export function auditSuppressions(root, current) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  if (git(['rev-parse', '--is-shallow-repository']) === 'true') return ['Cannot audit ESLint suppressions in a shallow repository; git fetch --unshallow first.']
  const errors = validateSuppressions(current), cache = new Map()
  function version(rev) {
    if (!cache.has(rev)) {
      try { cache.set(rev, JSON.parse(git(['show', `${rev}:${suppressionPath}`]))) }
      catch (error) { if (/does not exist|exists on disk, but not in/.test(String(error.stderr))) cache.set(rev, null); else throw error }
    }
    return cache.get(rev)
  }
  const origins = new Set()
  for (const revision of git(['rev-list', '--full-history', '--reverse', 'HEAD', '--', suppressionPath]).split('\n').filter(Boolean)) {
    const parents = git(['show', '-s', '--format=%P', revision]).split(' ').filter(Boolean)
    const after = version(revision)
    if (after) errors.push(...validateSuppressions(after))
    if (after && parents.every(parent => version(parent) === null)) origins.add(revision)
    for (const parent of parents) {
      const before = version(parent)
      if (before && !after) errors.push(`ESLint suppression file removed in ${revision}`)
      if (before && after) errors.push(...growthErrors(before, after, ` in ${revision} against ${parent}`))
    }
  }
  if (origins.size > 1) errors.push('ESLint suppressions introduced more than once')
  const before = version('HEAD')
  if (before) errors.push(...growthErrors(before, current, ' in working tree'))
  return errors
}
export function suppressionErrors(data, results) {
  const actual = {}
  for (const [file, messages] of results) for (const message of messages) {
    const id = message.ruleId ?? '(parse error)'
    actual[file] ??= {}
    actual[file][id] = (actual[file][id] ?? 0) + 1
  }
  const errors = []
  for (const [file, rules] of Object.entries(data)) for (const [id, entry] of Object.entries(rules)) if (entry.count > (actual[file]?.[id] ?? 0)) errors.push(`Unused ESLint suppression must shrink: ${file} ${id}`)
  for (const [file, messages] of results) for (const message of messages) {
    const id = message.ruleId ?? '(parse error)'
    if ((actual[file]?.[id] ?? 0) > (data[file]?.[id]?.count ?? 0)) errors.push(`${file}:${message.line}:${message.column} ${id} ${message.message}`)
  }
  return errors
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const errors = auditSuppressions(process.cwd(), JSON.parse(await readFile(suppressionPath, 'utf8')))
    process.stdout.write(JSON.stringify({ ok: !errors.length, errors }, null, 2) + '\n')
    process.exitCode = errors.length ? 1 : 0
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1 }
}
