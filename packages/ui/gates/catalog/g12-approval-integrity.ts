/**
 * G12 Approval integrity (D-138): an `approved` record needs a valid owner signature over its
 * hashes, made with a key the repository trusts; the trusted key set may change only on the
 * base branch or with a rotation signed by a key the base branch already trusts.
 */
import { execFileSync } from 'node:child_process'
import { sign, type KeyObject } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  approvalPayload,
  approvalSigningBytes,
  componentSnapshotHashes,
  componentSourceHash,
  loadTrustedKeys,
  parseReviewRecord,
  parseTrustedKeys,
  uiPaths,
  verifyKeySetChange,
  verifyRecordApproval,
  type ReviewRecord,
  type TrustedKey,
  type TrustedKeyFile,
} from '../../catalog/approval/index.ts'
import { readInventory } from '../../catalog/tooling/inventory.ts'
import { overlay } from './lib/scratch.ts'
import { createTestKey } from './lib/test-key.ts'
import { result, type CatalogGate, type GateContext, type GateFinding } from './types.ts'

const fixtures = join(import.meta.dirname, 'fixtures', 'g12')
const KEYS_PATH = 'packages/ui/catalog/approval-keys.json'

/** Trusted keys at the merge base with main, or null when git cannot tell. */
export function baseTrustedKeysFromGit(repoRoot: string): { keys: TrustedKeyFile | null; note: string } {
  try {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const base = git('merge-base', 'HEAD', 'main')
    let text: string
    try {
      text = git('show', `${base}:${KEYS_PATH}`)
    } catch {
      return { keys: { keys: [] }, note: `no trusted keys at ${base.slice(0, 7)}` }
    }
    const parsed = parseTrustedKeys(JSON.parse(text))
    return parsed.ok ? { keys: parsed.file, note: `base ${base.slice(0, 7)}` } : { keys: null, note: 'base keys invalid' }
  } catch {
    return { keys: null, note: 'git merge-base with main unavailable' }
  }
}

export const g12: CatalogGate = {
  id: 'G12',
  title: 'Approval integrity',
  mode: 'fast',
  async run(context) {
    const findings: GateFinding[] = []
    const paths = uiPaths(context.uiRoot)
    const keys = loadTrustedKeys(paths.trustedKeys)
    if (!keys.ok) {
      for (const problem of keys.errors) findings.push({ severity: 'error', file: KEYS_PATH, message: `trusted keys: ${problem}` })
      return result(this, findings)
    }

    let base = context.baseTrustedKeys
    if (base === undefined) {
      const fromGit = baseTrustedKeysFromGit(context.repoRoot)
      base = fromGit.keys
      if (base === null) findings.push({ severity: 'warning', file: KEYS_PATH, message: `key-set check skipped: ${fromGit.note}` })
    }
    if (base) {
      const verdict = verifyKeySetChange(keys.file, base)
      if (verdict.state === 'bootstrap') {
        findings.push({
          severity: 'error',
          file: KEYS_PATH,
          message: 'the first trusted key was added outside the base branch; only the owner adds it, on main',
        })
      } else if (verdict.state === 'invalid') {
        findings.push({ severity: 'error', file: KEYS_PATH, message: `trusted keys changed without a valid rotation (${verdict.reason})` })
      }
    }

    for (const folder of readInventory(context.uiRoot).folders) {
      if (folder.reviewJson === null) continue
      const parsed = parseReviewRecord(folder.reviewJson, folder.id)
      if (!parsed.ok) {
        const json = folder.reviewJson as { status?: unknown; approval?: unknown }
        if (json?.status === 'approved' || (json?.approval ?? null) !== null) {
          findings.push({ severity: 'error', component: folder.id, message: 'malformed record claims an approval' })
        }
        continue
      }
      const verdict = verifyRecordApproval(parsed.record, keys.file.keys)
      if (verdict.state === 'invalid') {
        findings.push({
          severity: 'error',
          component: folder.id,
          file: `packages/ui/src/components/${folder.id}/${folder.id}.review.json`,
          message: `approval is invalid: ${verdict.reason}`,
        })
      }
    }
    return result(this, findings)
  },
  seeded: [
    {
      name: 'agent-written-approved',
      description: 'An agent writes status "approved" with a made-up key id and signature',
      apply({ repoRoot, context }) {
        overlay(join(fixtures, 'agent-written-approved'), repoRoot)
        return context
      },
    },
    {
      name: 'agent-written-approved-unsigned',
      description: 'An agent sets status "approved" and leaves the approval empty',
      apply({ repoRoot, context }) {
        overlay(join(fixtures, 'agent-written-approved-unsigned'), repoRoot)
        return context
      },
    },
    {
      name: 'signed-then-edited',
      description: 'A record signed with a throwaway test key, trusted in the scratch copy, then edited',
      apply({ uiRoot, context }) {
        const key = createTestKey()
        try {
          const record = signTestApproval(uiRoot, 'badge', key.trusted, key.privateKey)
          record.approval = { ...record.approval!, comment: `${record.approval!.comment} (edited by an agent)` }
          writeRecord(uiRoot, record)
        } finally {
          key.dispose()
        }
        return { ...context, baseTrustedKeys: null } satisfies GateContext
      },
    },
    {
      name: 'key-added-without-rotation',
      description: 'A branch adds a second trusted key without a rotation signed by the base key',
      apply({ uiRoot, context }) {
        const first = createTestKey('base key')
        const second = createTestKey('agent key')
        try {
          writeFileSync(
            uiPaths(uiRoot).trustedKeys,
            `${JSON.stringify({ keys: [first.trusted, second.trusted], rotation: null }, null, 2)}\n`,
          )
          return { ...context, baseTrustedKeys: { keys: [first.trusted] } }
        } finally {
          first.dispose()
          second.dispose()
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
): ReviewRecord & { approval: NonNullable<ReviewRecord['approval']> } {
  const paths = uiPaths(uiRoot)
  writeFileSync(paths.trustedKeys, `${JSON.stringify({ keys: [trusted], rotation: null }, null, 2)}\n`)
  const unsigned = {
    at: '2026-10-20T12:00:00.000Z',
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
  writeFileSync(uiPaths(uiRoot).reviewFile(record.id), `${JSON.stringify(record, null, 2)}\n`)
}
