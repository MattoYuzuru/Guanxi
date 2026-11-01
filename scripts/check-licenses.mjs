#!/usr/bin/env node
// Dependency license gate (ADR-0016). Walks installed packages and fails on any license
// expression that the allowlist does not satisfy. Usage: node scripts/check-licenses.mjs [--list]
import { readdirSync, readFileSync, existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'

// Keep in sync with docs/decisions/0016-licensing-and-third-party-reuse.md.
const ALLOWED = new Set([
  'MIT', 'MIT-0', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'Zlib',
  'CC0-1.0', 'Unlicense', 'MPL-2.0', 'BlueOak-1.0.0', 'Python-2.0', 'CC-BY-4.0',
])
// Packages whose metadata is missing or non-SPDX but whose license was checked by hand.
const REVIEWED = new Map([
  // WTFPL (permissive, no conditions). Build-time only: electron-builder -> builder-util -> sanitize-filename.
  // It is never bundled into the shipped app. Approved by D-223 (2026-11-01); ADR-0016 allows this exact build-only exception.
  ['truncate-utf8-bytes@1.0.2', 'WTFPL, dev tooling only'],
])
const DENIED_PACKAGES = new Set(['dockview-enterprise'])

const root = process.cwd()
const seen = new Map()

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map(l => l.type ?? l).join(' OR ')
  return null
}

// Minimal SPDX expression check: OR needs one allowed side, AND/WITH need all.
function satisfies(expr) {
  const s = expr.replace(/[()]/g, ' ').trim()
  if (/\bOR\b/.test(s)) return s.split(/\bOR\b/).some(part => satisfies(part))
  if (/\bAND\b/.test(s)) return s.split(/\bAND\b/).every(part => satisfies(part))
  return ALLOWED.has(s.split(/\s+WITH\s+/)[0].trim())
}

function walk(dir) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    if (name.startsWith('@')) { walk(full); continue }
    const manifest = join(full, 'package.json')
    if (!existsSync(manifest)) continue
    if (lstatSync(full).isSymbolicLink()) continue // workspace packages are ours
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    const key = `${pkg.name}@${pkg.version}`
    if (!seen.has(key)) seen.set(key, licenseOf(pkg))
    walk(join(full, 'node_modules'))
  }
}

walk(join(root, 'node_modules'))
for (const ws of readdirSync(join(root, 'packages'))) walk(join(root, 'packages', ws, 'node_modules'))

const bad = []
const counts = new Map()
for (const [key, license] of seen) {
  const label = license ?? 'NONE'
  counts.set(label, (counts.get(label) ?? 0) + 1)
  if (DENIED_PACKAGES.has(key.slice(0, key.lastIndexOf('@')))) { bad.push(`${key}: denied package`); continue }
  if (REVIEWED.has(key)) continue
  if (!license || !satisfies(license)) bad.push(`${key}: ${label}`)
}
if (process.argv.includes('--list')) {
  for (const [label, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${n}\t${label}`)
}
console.log(`checked ${seen.size} packages, ${bad.length} not allowed`)
for (const line of bad.sort()) console.log(`  ${line}`)
process.exit(bad.length ? 1 : 0)
