/**
 * G12 Approval integrity (D-138):
 * - an `approved` record needs a valid owner signature over its hashes, made with a trusted key,
 *   and must be exactly what the node wrote (no duplicate keys or hand edits);
 * - the trusted key set may change only on the base branch, or with a versioned rotation signed
 *   by a key the base branch already trusts; a first key added off the base fails;
 * - signed decisions form a hash chain (`previous`), and every committed version of a record
 *   (first-parent history of the base and of HEAD, then the working tree) keeps the owner's
 *   current decision or replaces it with one that chains to it, and keeps a deprecation unless
 *   a newer signed decision supersedes it; an unsigned edit or a removed record cannot reset
 *   the lifecycle so that an old approval passes again (N1);
 * - when `GUANXI_UI_APPROVAL_KEY_IDS` pins the owner key ids (CI), only pinned keys count.
 * The base is the merge base with `refs/heads/main`, else `refs/remotes/origin/main`
 * (`GUANXI_UI_G12_BASE` names another ref, or `none` to skip visibly). Unknown base = failure.
 */
import { execFileSync } from 'node:child_process'
import { sign, type KeyObject } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  approvalPayload,
  approvalSigningBytes,
  componentSnapshotHashes,
  componentSourceHash,
  decisionDigest,
  lifecycleTransition,
  loadTrustedKeys,
  parseReviewRecord,
  parseTrustedKeys,
  revocationPayload,
  serialiseRecord,
  uiPaths,
  verifyKeySetChange,
  verifyRecordApproval,
  verifyRecordRevocation,
  type LifecycleVersion,
  type ReviewRecord,
  type TrustedKey,
} from '../../catalog/approval/index.ts'
import { readInventory } from '../../catalog/tooling/inventory.ts'
import { overlay } from './lib/scratch.ts'
import { createTestKey } from './lib/test-key.ts'
import { result, type BaseSnapshot, type CatalogGate, type GateContext, type GateFinding, type HistoryVersion } from './types.ts'

const fixtures = join(import.meta.dirname, 'fixtures', 'g12')
const KEYS_PATH = 'packages/ui/catalog/approval-keys.json'

function git(repoRoot: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

/** Base snapshot from git, or a reason it cannot be read. Full ref names: a tag cannot shadow main. */
const recordPath = (id: string) => `packages/ui/src/components/${id}/${id}.review.json`

function keysAt(repoRoot: string, commit: string): TrustedKey[] {
  try {
    const parsed = parseTrustedKeys(JSON.parse(git(repoRoot, 'show', `${commit}:${KEYS_PATH}`)))
    return parsed.ok ? parsed.file.keys : []
  } catch {
    return []
  }
}

/** Every first-parent commit of `ref` that changed the record, oldest first. */
function firstParentVersions(repoRoot: string, ref: string, id: string): HistoryVersion[] {
  const commits = git(repoRoot, 'log', '--first-parent', '--format=%H', ref, '--', recordPath(id)).split('\n').filter(Boolean).reverse()
  return commits.map((commit) => {
    let json: unknown
    try {
      const text = git(repoRoot, 'show', `${commit}:${recordPath(id)}`)
      try {
        json = JSON.parse(text)
      } catch {
        json = 'unreadable'
      }
    } catch {
      json = undefined
    }
    return { label: `commit ${commit.slice(0, 7)}`, json, trustedKeys: keysAt(repoRoot, commit) }
  })
}

/**
 * The committed history G12 walks: the base branch's first-parent history and HEAD's. Shallow
 * clones fail closed, like DS1-a's ratchet: a missing commit could hide an erased decision.
 */
export function historyFromGit(repoRoot: string, baseCommit: string, ids: string[]): Record<string, HistoryVersion[][]> | { error: string } {
  try {
    if (git(repoRoot, 'rev-parse', '--is-shallow-repository') === 'true') return { error: 'the repository is shallow; run git fetch --unshallow' }
    return Object.fromEntries(ids.map((id) => [id, [firstParentVersions(repoRoot, baseCommit, id), firstParentVersions(repoRoot, 'HEAD', id)]]))
  } catch (cause) {
    return { error: `cannot read the record history: ${(cause as Error).message.split('\n')[0]}` }
  }
}

export function baseFromGit(repoRoot: string, ids: string[]): BaseSnapshot | { error: string } | 'skipped' {
  const override = process.env['GUANXI_UI_G12_BASE']
  if (override === 'none') return 'skipped'
  const candidates = override ? [override] : ['refs/heads/main', 'refs/remotes/origin/main']
  let base: string | null = null
  let label = ''
  for (const ref of candidates) {
    try {
      const commit = git(repoRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
      base = git(repoRoot, 'merge-base', 'HEAD', commit)
      label = `${ref} @ ${base.slice(0, 7)}`
      break
    } catch {
      // try the next candidate
    }
  }
  if (base === null) return { error: `no base branch (${candidates.join(', ')}) to compare with` }
  const show = (path: string): string | null => {
    try {
      return git(repoRoot, 'show', `${base}:${path}`)
    } catch {
      return null
    }
  }
  const keysText = show(KEYS_PATH)
  let trustedKeys = { keys: [] as TrustedKey[] } as BaseSnapshot['trustedKeys']
  if (keysText !== null) {
    const parsed = parseTrustedKeys(JSON.parse(keysText))
    if (!parsed.ok) return { error: `trusted keys on ${label} are invalid` }
    trustedKeys = parsed.file
  }
  const records: Record<string, unknown> = {}
  for (const id of ids) {
    const text = show(`packages/ui/src/components/${id}/${id}.review.json`)
    if (text !== null) {
      try {
        records[id] = JSON.parse(text)
      } catch {
        // an unreadable base record holds no signed decision
      }
    }
  }
  return { label, trustedKeys, records, commit: base }
}

function asVersion(version: HistoryVersion): LifecycleVersion | 'unreadable' {
  if (version.json === undefined) return { label: version.label, record: null, trustedKeys: version.trustedKeys }
  if (version.json === 'unreadable') return 'unreadable'
  const parsed = parseReviewRecord(version.json)
  return parsed.ok ? { label: version.label, record: parsed.record, trustedKeys: version.trustedKeys } : 'unreadable'
}

/**
 * Walks one sequence of committed versions, oldest first, and checks the working tree against
 * the lifecycle barrier they establish. The barrier is the last version holding a decision or a
 * deprecation that did not itself break the previous barrier: a commit that erased a decision
 * never resets it, so an old approval restored later still fails, while re-adding the erased
 * decision repairs the history. Absent and unreadable versions hold no state.
 */
export function walkLifecycle(sequence: HistoryVersion[], current: LifecycleVersion | 'unreadable'): string[] {
  let barrier: LifecycleVersion | null = null
  for (const version of sequence) {
    const next = asVersion(version)
    if (next === 'unreadable' || next.record === null) continue
    if (barrier && lifecycleTransition(barrier, next).length > 0) continue
    const holds = (next.record.deprecated ?? null) !== null || next.record.approval !== null || (next.record.revocation ?? null) !== null
    if (holds || barrier === null) barrier = next
  }
  if (!barrier) return []
  if (current === 'unreadable') {
    return lifecycleTransition(barrier, { label: 'the working tree', record: null, trustedKeys: [] }).map((problem) => `${problem} (the record is unreadable)`)
  }
  return lifecycleTransition(barrier, current)
}

function pinnedKeyIds(): string[] | null {
  const raw = process.env['GUANXI_UI_APPROVAL_KEY_IDS']
  return raw ? raw.split(',').map((id) => id.trim()).filter(Boolean) : null
}

export const g12: CatalogGate = {
  id: 'G12',
  title: 'Approval integrity',
  mode: 'fast',
  async run(context) {
    const findings: GateFinding[] = []
    const error = (message: string, extra: Partial<GateFinding> = {}) => findings.push({ severity: 'error', message, ...extra })
    const paths = uiPaths(context.uiRoot)
    const keys = loadTrustedKeys(paths.trustedKeys)
    if (!keys.ok) {
      for (const problem of keys.errors) error(`trusted keys: ${problem}`, { file: KEYS_PATH })
      return result(this, findings)
    }
    let trusted = keys.file.keys
    const pinned = pinnedKeyIds()
    if (pinned) {
      for (const key of trusted) {
        if (!pinned.includes(key.keyId)) error(`trusted key ${key.keyId} is not pinned by GUANXI_UI_APPROVAL_KEY_IDS`, { file: KEYS_PATH })
      }
      trusted = trusted.filter((key) => pinned.includes(key.keyId))
    } else if (trusted.length > 0) {
      findings.push({ severity: 'warning', file: KEYS_PATH, message: 'owner key ids are not pinned; set GUANXI_UI_APPROVAL_KEY_IDS in CI' })
    }

    const inventory = readInventory(context.uiRoot)
    let base: BaseSnapshot | null = null
    if (context.base === undefined) {
      const fromGit = baseFromGit(context.repoRoot, inventory.folders.map((folder) => folder.id))
      if (fromGit === 'skipped') findings.push({ severity: 'warning', message: 'base comparison skipped by GUANXI_UI_G12_BASE=none' })
      else if ('error' in fromGit) error(`cannot verify the trusted key set: ${fromGit.error}`, { file: KEYS_PATH })
      else base = fromGit
    } else {
      base = context.base
    }

    if (base) {
      const verdict = verifyKeySetChange(keys.file, base.trustedKeys)
      if (verdict.state === 'bootstrap') {
        error('the first trusted key was added outside the base branch; only the owner adds it, on main', { file: KEYS_PATH })
      } else if (verdict.state === 'invalid') {
        error(`trusted keys changed without a valid rotation (${verdict.reason})`, { file: KEYS_PATH })
      }
    }

    // N1: the committed history of every record, plus the base version itself.
    let history: Record<string, HistoryVersion[][]> | null = context.history ?? null
    if (context.history === undefined && context.base === undefined && base?.commit) {
      const fromGit = historyFromGit(context.repoRoot, base.commit, inventory.folders.map((folder) => folder.id))
      if ('error' in fromGit) error(`cannot walk the review history: ${fromGit.error}`)
      else history = fromGit
    }

    for (const folder of inventory.folders) {
      const file = `packages/ui/src/components/${folder.id}/${folder.id}.review.json`
      let current: LifecycleVersion | 'unreadable' = { label: 'the working tree', record: null, trustedKeys: trusted }
      if (folder.reviewJson !== null) {
        const parsed = parseReviewRecord(folder.reviewJson, folder.id)
        if (!parsed.ok) {
          const json = folder.reviewJson as { status?: unknown; approval?: unknown }
          if (json?.status === 'approved' || (json?.approval ?? null) !== null) {
            error('malformed record claims an approval', { component: folder.id, file })
          }
          current = 'unreadable'
        } else {
          const record = parsed.record
          current = { label: 'the working tree', record, trustedKeys: trusted }
          const verdict = verifyRecordApproval(record, trusted)
          if (verdict.state === 'invalid') error(`approval is invalid: ${verdict.reason}`, { component: folder.id, file })
          if (verifyRecordRevocation(record, trusted).state === 'invalid') {
            error('revocation is invalid: bad_signature or untrusted_key', { component: folder.id, file })
          }
          const signed = record.approval !== null || (record.revocation ?? null) !== null
          if (signed && readFileSync(join(folder.dir, `${folder.id}.review.json`), 'utf8') !== serialiseRecord(record)) {
            error('a signed record differs from what the node writes (hand edit or duplicate keys)', { component: folder.id, file })
          }
          // Reactivation removes the deprecation, which needs a newer signed decision (below).
          if ((record.deprecated ?? null) !== null && record.status !== 'deprecated') {
            error(`a deprecated record must keep status "deprecated" (found "${record.status}")`, { component: folder.id, file })
          }
        }
      }
      const sequences: HistoryVersion[][] = [...(history?.[folder.id] ?? [])]
      if (base) sequences.push([{ label: base.label, json: base.records[folder.id], trustedKeys: base.trustedKeys.keys }])
      const problems = new Set(sequences.flatMap((sequence) => walkLifecycle(sequence, current)))
      for (const problem of problems) error(problem, { component: folder.id, file })
    }
    return result(this, findings)
  },
  seeded: [
    {
      name: 'agent-written-approved',
      description: 'An agent writes status "approved" with a made-up key id and signature',
      expect: /approval is invalid: untrusted_key/,
      apply({ repoRoot, context }) {
        overlay(join(fixtures, 'agent-written-approved'), repoRoot)
        return context
      },
    },
    {
      name: 'agent-written-approved-unsigned',
      description: 'An agent sets status "approved" and leaves the approval empty',
      expect: /approval is invalid: unsigned_approval/,
      apply({ repoRoot, context }) {
        overlay(join(fixtures, 'agent-written-approved-unsigned'), repoRoot)
        return context
      },
    },
    {
      name: 'signed-then-edited',
      description: 'A record signed with a throwaway test key, trusted in the scratch copy, then edited',
      expect: /approval is invalid: bad_signature/,
      apply({ uiRoot, context }) {
        const key = createTestKey()
        try {
          const record = signTestApproval(uiRoot, 'badge', key.trusted, key.privateKey)
          writeRecord(uiRoot, { ...record, approval: { ...record.approval, comment: `${record.approval.comment} (edited by an agent)` } })
        } finally {
          key.dispose()
        }
        return { ...context, base: null } satisfies GateContext
      },
    },
    {
      name: 'agent-key-bootstrapped-on-branch',
      description: 'A branch adds its own first trusted key and self-signs an approval',
      expect: /first trusted key was added outside the base branch/,
      apply({ uiRoot, context }) {
        const key = createTestKey('agent key')
        try {
          signTestApproval(uiRoot, 'badge', key.trusted, key.privateKey)
        } finally {
          key.dispose()
        }
        return { ...context, base: { label: 'main', trustedKeys: { keys: [] }, records: {} } }
      },
    },
    {
      name: 'base-branch-unknown',
      description: 'No main ref to compare the trusted key set with (shallow CI, detached copy)',
      expect: /cannot verify the trusted key set: no base branch/,
      apply: ({ context }) => {
        const { base: _ignored, ...rest } = context
        return rest
      },
    },
    {
      name: 'key-added-without-rotation',
      description: 'A branch adds a second trusted key without a rotation signed by the base key',
      expect: /trusted keys changed without a valid rotation \(unsigned_change\)/,
      apply({ uiRoot, context }) {
        const first = createTestKey('base key')
        const second = createTestKey('agent key')
        try {
          writeFileSync(
            uiPaths(uiRoot).trustedKeys,
            `${JSON.stringify({ version: 2, keys: [first.trusted, second.trusted], rotation: null }, null, 2)}\n`,
          )
          return { ...context, base: { label: 'main', trustedKeys: { version: 1, keys: [first.trusted] }, records: {} } }
        } finally {
          first.dispose()
          second.dispose()
        }
      },
    },
    {
      name: 'approval-over-base-deprecation',
      description: 'Main deprecated the component; a branch drops the deprecation and restores the approval',
      expect: /removes the deprecation of 2026-10-22T09:00:00.000Z \(main\) without a newer signed decision/,
      apply({ uiRoot, context }) {
        const key = createTestKey('owner test key')
        try {
          const approved = signTestApproval(uiRoot, 'badge', key.trusted, key.privateKey)
          return { ...context, base: { label: 'main', trustedKeys: { version: 1, keys: [key.trusted] }, records: { badge: deprecate(approved) } } }
        } finally {
          key.dispose()
        }
      },
    },
    {
      name: 'approval-revoked-in-record',
      description: 'The record carries the approval and the owner\'s revocation chained to it',
      expect: /approval is invalid: revoked/,
      apply({ uiRoot, context }) {
        const key = createTestKey('owner test key')
        try {
          const approved = signTestApproval(uiRoot, 'badge', key.trusted, key.privateKey, 'First look.', '2026-10-20T12:00:00.000Z')
          writeRecord(uiRoot, { ...approved, revocation: signTestRevocation(approved, key.privateKey, '2026-10-21T09:00:00.000Z') })
          return { ...context, base: { label: 'main', trustedKeys: { version: 1, keys: [key.trusted] }, records: {} } }
        } finally {
          key.dispose()
        }
      },
    },
    {
      name: 'key-version-reset',
      description: 'A branch resets the key-set version without a rotation, to replay an old rotation later',
      expect: /trusted keys changed without a valid rotation \(version_changed_without_rotation\)/,
      apply({ uiRoot, context }) {
        const key = createTestKey('owner test key')
        try {
          writeFileSync(uiPaths(uiRoot).trustedKeys, `${JSON.stringify({ version: 0, keys: [key.trusted], rotation: null }, null, 2)}\n`)
          return { ...context, base: { label: 'main', trustedKeys: { version: 3, keys: [key.trusted] }, records: {} } }
        } finally {
          key.dispose()
        }
      },
    },
    {
      name: 'old-approval-restored',
      description: 'The owner requested changes (signed, on main); a branch restores the earlier approval',
      expect: /the working tree drops the signed revocation of 2026-10-21T09:00:00.000Z \(main\) without a signed decision that chains to it/,
      apply({ uiRoot, context }) {
        const key = createTestKey('owner test key')
        try {
          const approved = signTestApproval(uiRoot, 'badge', key.trusted, key.privateKey, 'First look.', '2026-10-20T12:00:00.000Z')
          const onMain = revoke(approved, key.privateKey)
          return { ...context, base: { label: 'main', trustedKeys: { keys: [key.trusted] }, records: { badge: onMain } } }
        } finally {
          key.dispose()
        }
      },
    },
    {
      name: 'deprecation-erased-by-unsigned-intermediate',
      description: 'Main deprecated an approved component; an unsigned change on main drops the deprecation; a branch restores the approval',
      expect: /the working tree removes the deprecation of 2026-10-22T09:00:00.000Z \(main~1\) without a newer signed decision/,
      apply({ uiRoot, context }) {
        const key = createTestKey('owner test key')
        try {
          const approved = signTestApproval(uiRoot, 'badge', key.trusted, key.privateKey)
          const deprecated = deprecate(approved)
          const erased: ReviewRecord = { ...approved, status: 'review', approval: null, requests: [] }
          delete erased.deprecated
          return withHistory(context, key.trusted, [['main~2', approved], ['main~1', deprecated], ['main', erased]])
        } finally {
          key.dispose()
        }
      },
    },
    {
      name: 'revocation-erased-by-unsigned-intermediate',
      description: 'Main holds the owner\'s signed revocation; an unsigned change on main drops it; a branch restores the approval',
      expect: /the working tree drops the signed revocation of 2026-10-21T09:00:00.000Z \(main~1\) without a signed decision that chains to it/,
      apply({ uiRoot, context }) {
        const key = createTestKey('owner test key')
        try {
          const approved = signTestApproval(uiRoot, 'badge', key.trusted, key.privateKey, 'First look.', '2026-10-20T12:00:00.000Z')
          const revoked = revoke(approved, key.privateKey)
          const erased: ReviewRecord = { ...revoked, revocation: null }
          return withHistory(context, key.trusted, [['main~2', approved], ['main~1', revoked], ['main', erased]])
        } finally {
          key.dispose()
        }
      },
    },
    {
      name: 'review-record-removed',
      description: 'A branch deletes a record that holds the owner\'s signed revocation',
      expect: /the working tree removes the review record, which holds the signed revocation of 2026-10-21T09:00:00.000Z \(main\)/,
      apply({ uiRoot, context }) {
        const key = createTestKey('owner test key')
        try {
          const approved = signTestApproval(uiRoot, 'badge', key.trusted, key.privateKey, 'First look.', '2026-10-20T12:00:00.000Z')
          const revoked = revoke(approved, key.privateKey)
          rmSync(uiPaths(uiRoot).reviewFile('badge'))
          return withHistory(context, key.trusted, [['main~1', approved], ['main', revoked]])
        } finally {
          key.dispose()
        }
      },
    },
  ],
}

const DEPRECATED_AT = '2026-10-22T09:00:00.000Z'

/** The record an agent writes to deprecate: the approval stays, so the chain stays intact. */
function deprecate(record: ReviewRecord): ReviewRecord {
  return { ...record, status: 'deprecated', deprecated: { at: DEPRECATED_AT, replacement: null, note: 'Replaced by StatusPill.' } }
}

/** What the node writes when the owner requests changes on an approved record. */
function revoke(record: ReviewRecord & { approval: NonNullable<ReviewRecord['approval']> }, privateKey: KeyObject): ReviewRecord {
  return { ...record, status: 'review', approval: null, revocation: signTestRevocation(record, privateKey, '2026-10-21T09:00:00.000Z') }
}

/** A revocation signed with the test key, chained to the record's approval. */
export function signTestRevocation(
  record: ReviewRecord & { approval: NonNullable<ReviewRecord['approval']> },
  privateKey: KeyObject,
  at: string,
): NonNullable<ReviewRecord['revocation']> {
  const unsigned = { at, keyId: record.approval.keyId, previous: decisionDigest(record.id, 'approval', record.approval) }
  return { ...unsigned, signature: sign(null, approvalSigningBytes(revocationPayload(record.id, unsigned)), privateKey).toString('base64') }
}

/** A fixture history: the last step is the base branch. */
function withHistory(context: GateContext, trusted: TrustedKey, steps: Array<[string, ReviewRecord]>): GateContext {
  const versions = steps.map(([label, record]) => ({ label, json: JSON.parse(serialiseRecord(record)) as unknown, trustedKeys: [trusted] }))
  const [label, last] = steps.at(-1)!
  return {
    ...context,
    base: { label, trustedKeys: { version: 1, keys: [trusted] }, records: { [last.id]: JSON.parse(serialiseRecord(last)) as unknown } },
    history: { [last.id]: [versions] },
  }
}

/** Writes a validly signed approval for `id` (current hashes) and trusts the key; tests use it too. */
export function signTestApproval(
  uiRoot: string,
  id: string,
  trusted: TrustedKey,
  privateKey: KeyObject,
  comment = 'Looks right in every theme.',
  at = '2026-10-20T12:00:00.000Z',
  previous: string | null = null,
): ReviewRecord & { approval: NonNullable<ReviewRecord['approval']> } {
  const paths = uiPaths(uiRoot)
  writeFileSync(paths.trustedKeys, `${JSON.stringify({ version: 1, keys: [trusted], rotation: null }, null, 2)}\n`)
  const unsigned = {
    at,
    sourceHash: componentSourceHash(paths.componentDir(id)),
    snapshotHashes: componentSnapshotHashes(paths.snapshots, id),
    comment,
    keyId: trusted.keyId,
    previous,
  }
  const signature = sign(null, approvalSigningBytes(approvalPayload(id, unsigned)), privateKey).toString('base64')
  const current = JSON.parse(readFileSync(paths.reviewFile(id), 'utf8')) as ReviewRecord
  const record = { ...current, status: 'approved' as const, approval: { ...unsigned, signature } }
  writeRecord(uiRoot, record)
  return record
}

function writeRecord(uiRoot: string, record: ReviewRecord): void {
  writeFileSync(uiPaths(uiRoot).reviewFile(record.id), serialiseRecord(record))
}
