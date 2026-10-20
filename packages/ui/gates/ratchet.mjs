import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

export const ledgerPath = 'packages/ui/gates/legacy-allowlist.json'
export const policyPath = 'packages/ui/gates/legacy-ratchet-policy.json'
export const snapshotHash = data => createHash('sha256').update(JSON.stringify(Object.entries(data).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex')
const stable = data => JSON.stringify(data, (_, value) => value && !Array.isArray(value) && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value)
export function corrections(policy) {
  const entries = policy?.corrections ?? (policy?.initialCorrection ? [policy.initialCorrection] : [])
  return entries.map((entry, index) => ({ ...entry, id: entry.id ?? index + 1 }))
}

function policyErrors(before, after, where) {
  const old = corrections(before), next = corrections(after)
  const errors = []
  // Exactly two owner-authorized bootstrap corrections exist. A third requires a new
  // reviewed authorization/change; rewriting a hash cannot grant an exception.
  if (next.length > 2 || next.some((entry, index) => entry.id !== index + 1 || !/^[a-f0-9]{64}$/.test(entry.fromSHA256) || !/^[a-f0-9]{64}$/.test(entry.toSHA256))) errors.push(`Invalid legacy correction policy${where}`)
  if (old.length > next.length || old.some((entry, index) => stable(entry) !== stable(next[index]))) errors.push(`Legacy correction policy changed${where}`)
  return errors
}

export function ledgerErrors(before, after, where = '') {
  const available = new Map()
  const identity = key => { const [gate, , ...value] = key.split('|'); return `${gate}|${value.join('|')}` }
  // A relocation/split preserves the exact violation value and its total count. Only
  // completely disappeared source keys can fund destination keys, never partial shrinks.
  for (const [key, count] of Object.entries(before)) if (!(key in after)) available.set(identity(key), (available.get(identity(key)) ?? 0) + count)
  const errors = []
  for (const [key, count] of Object.entries(after)) {
    const increase = count - (before[key] ?? 0)
    if (increase <= 0) continue
    const id = identity(key), budget = available.get(id) ?? 0
    if (increase > budget) errors.push(`Legacy allowance grew${where}: ${key}`)
    else available.set(id, budget - increase)
  }
  return errors
}

function edgeErrors(before, after, oldPolicy, policy, where) {
  const errors = policyErrors(oldPolicy, policy, where)
  // Exceptions belong to the edge introducing their policy entry. Existing entries
  // cannot be replayed after a shrink returns to the old snapshot. A merge can still
  // propagate the authorized transition to a parent that has not received it yet.
  const added = corrections(policy).slice(corrections(oldPolicy).length)
  const corrected = !errors.length && added.some(c => snapshotHash(before) === c.fromSHA256 && snapshotHash(after) === c.toSHA256)
  return [...errors, ...(corrected ? [] : ledgerErrors(before, after, where))]
}

export function auditRatchet(root, allowances, policy) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const cache = new Map()
  const version = (revision, path) => {
    const key = `${revision}:${path}`
    if (!cache.has(key)) {
      let contents
      try { contents = git(['show', key]) } catch (error) {
        // Only an absent path is legitimate; other Git failures must remain visible.
        if (!/does not exist|exists on disk, but not in|does not exist in/.test(String(error.stderr))) throw error
        cache.set(key, null)
        return null
      }
      cache.set(key, JSON.parse(contents))
    }
    return cache.get(key)
  }
  const errors = []
  const origins = new Map()
  for (const line of git(['rev-list', '--full-history', '--reverse', '--parents', 'HEAD', '--', ledgerPath, policyPath]).split('\n').filter(Boolean)) {
    const revision = line.split(' ')[0]
    // Path-limited rev-list can simplify parent links. Read the actual commit parents.
    const parents = git(['show', '-s', '--format=%P', revision]).split(' ').filter(Boolean)
    const currentLedger = version(revision, ledgerPath), currentPolicy = version(revision, policyPath)
    for (const correction of corrections(currentPolicy)) {
      if (parents.some(parent => corrections(version(parent, policyPath)).some(c => c.id === correction.id))) continue
      if (origins.has(correction.id)) errors.push(`Legacy correction ${correction.id} introduced more than once in ${revision} and ${origins.get(correction.id)}`)
      else origins.set(correction.id, revision)
    }
    for (const parent of parents) {
      const oldLedger = version(parent, ledgerPath), oldPolicy = version(parent, policyPath)
      if (oldLedger && !currentLedger) errors.push(`Legacy ledger removed in ${revision} against ${parent}`)
      if (oldLedger) errors.push(...edgeErrors(oldLedger, currentLedger ?? {}, oldPolicy, currentPolicy, ` in ${revision} against ${parent}`))
      else errors.push(...policyErrors(oldPolicy, currentPolicy, ` in ${revision} against ${parent}`))
    }
  }
  const head = version('HEAD', ledgerPath)
  if (head) errors.push(...edgeErrors(head, allowances, version('HEAD', policyPath), policy, ' in working tree'))
  else errors.push(...policyErrors(version('HEAD', policyPath), policy, ' in working tree'))
  return errors
}
