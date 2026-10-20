/**
 * G12 Approval integrity (D-138):
 * - an `approved` record needs a valid owner signature over its hashes, made with a trusted key,
 *   and must be exactly what the node wrote (no duplicate keys or hand edits);
 * - the trusted key set may change only on the base branch, or with a versioned rotation signed
 *   by a key the base branch already trusts; a first key added off the base fails;
 * - no approval may be older than a signed decision the base branch already holds for that
 *   component (an owner's "request changes" cannot be undone by restoring an old record);
 * - when `GUANXI_UI_APPROVAL_KEY_IDS` pins the owner key ids (CI), only pinned keys count.
 * The base is the merge base with `refs/heads/main`, else `refs/remotes/origin/main`
 * (`GUANXI_UI_G12_BASE` names another ref, or `none` to skip visibly). Unknown base = failure.
 */
import { execFileSync } from 'node:child_process'
import { sign, type KeyObject } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  approvalPayload,
  approvalPrecedes,
  approvalSigningBytes,
  componentSnapshotHashes,
  componentSourceHash,
  latestSignedDecision,
  loadTrustedKeys,
  parseReviewRecord,
  parseTrustedKeys,
  revocationPayload,
  serialiseRecord,
  uiPaths,
  verifyKeySetChange,
  verifyRecordApproval,
  verifyRecordRevocation,
  type ReviewRecord,
  type TrustedKey,
} from '../../catalog/approval/index.ts'
import { readInventory } from '../../catalog/tooling/inventory.ts'
import { overlay } from './lib/scratch.ts'
import { createTestKey } from './lib/test-key.ts'
import { result, type BaseSnapshot, type CatalogGate, type GateContext, type GateFinding } from './types.ts'

const fixtures = join(import.meta.dirname, 'fixtures', 'g12')
const KEYS_PATH = 'packages/ui/catalog/approval-keys.json'

function git(repoRoot: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

/** Base snapshot from git, or a reason it cannot be read. Full ref names: a tag cannot shadow main. */
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
  return { label, trustedKeys, records }
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

    for (const folder of inventory.folders) {
      if (folder.reviewJson === null) continue
      const file = `packages/ui/src/components/${folder.id}/${folder.id}.review.json`
      const parsed = parseReviewRecord(folder.reviewJson, folder.id)
      if (!parsed.ok) {
        const json = folder.reviewJson as { status?: unknown; approval?: unknown }
        if (json?.status === 'approved' || (json?.approval ?? null) !== null) {
          error('malformed record claims an approval', { component: folder.id, file })
        }
        continue
      }
      const record = parsed.record
      const verdict = verifyRecordApproval(record, trusted)
      if (verdict.state === 'invalid') error(`approval is invalid: ${verdict.reason}`, { component: folder.id, file })
      if (verifyRecordRevocation(record, trusted).state === 'invalid') {
        error('revocation is invalid: bad_signature or untrusted_key', { component: folder.id, file })
      }
      const signed = record.approval !== null || (record.revocation ?? null) !== null
      if (signed && readFileSync(join(folder.dir, `${folder.id}.review.json`), 'utf8') !== serialiseRecord(record)) {
        error('a signed record differs from what the node writes (hand edit or duplicate keys)', { component: folder.id, file })
      }
      if (base && record.approval && verdict.state === 'valid') {
        const baseParsed = parseReviewRecord(base.records[folder.id], folder.id)
        const baseKeys = base.trustedKeys.keys
        const newest = baseParsed.ok ? latestSignedDecision(baseParsed.record, baseKeys) : null
        if (newest !== null && approvalPrecedes(record.approval.at, newest)) {
          error(`approval of ${record.approval.at} does not follow the signed ${newest.kind} of ${newest.at} on ${base.label}`, {
            component: folder.id,
            file,
          })
        }
      }
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
      name: 'old-approval-restored',
      description: 'The owner requested changes (signed, on main); a branch restores the earlier approval',
      expect: /does not follow the signed revocation/,
      apply({ uiRoot, context }) {
        const key = createTestKey('owner test key')
        try {
          const approved = signTestApproval(uiRoot, 'badge', key.trusted, key.privateKey, 'First look.', '2026-10-20T12:00:00.000Z')
          const at = '2026-10-21T09:00:00.000Z'
          const revocation = {
            at,
            keyId: key.trusted.keyId,
            signature: sign(null, approvalSigningBytes(revocationPayload('badge', { at, keyId: key.trusted.keyId })), key.privateKey).toString('base64'),
          }
          const onMain: ReviewRecord = { ...approved, status: 'review', approval: null, revocation }
          return { ...context, base: { label: 'main', trustedKeys: { keys: [key.trusted] }, records: { badge: onMain } } }
        } finally {
          key.dispose()
        }
      },
    },
  ],
}

/** Writes a validly signed approval for `id` (current hashes) and trusts the key; tests use it too. */
export function signTestApproval(
  uiRoot: string,
  id: string,
  trusted: TrustedKey,
  privateKey: KeyObject,
  comment = 'Looks right in every theme.',
  at = '2026-10-20T12:00:00.000Z',
): ReviewRecord & { approval: NonNullable<ReviewRecord['approval']> } {
  const paths = uiPaths(uiRoot)
  writeFileSync(paths.trustedKeys, `${JSON.stringify({ version: 1, keys: [trusted], rotation: null }, null, 2)}\n`)
  const unsigned = {
    at,
    sourceHash: componentSourceHash(paths.componentDir(id)),
    snapshotHashes: componentSnapshotHashes(paths.snapshots, id),
    comment,
    keyId: trusted.keyId,
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
