/**
 * D-138 catalog review route: approvals are written only from a source checkout, signed with
 * the owner key (here a throwaway key generated into a temp directory, never the keychain),
 * bound to the hashes the owner saw and rejected by G12 once edited.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ROUTES,
  uiCatalogReviewCapabilityResponse,
  uiComponentReviewResponse,
  type UiComponentReviewBody,
} from '@guanxi/contract'
import {
  componentSnapshotHashes,
  componentSourceHash,
  decisionDigest,
  exportPublicKey,
  parseReviewRecord,
  uiPaths,
  verifyRecordApproval,
  type TrustedKey,
} from '@guanxi/ui/approval'
import { createApp } from '../src/app.ts'
import type { AppContext } from '../src/context.ts'
import { UiCatalogReviewService } from '../src/ui-catalog/service.ts'
import {
  keyObjectSigner,
  keychainSigner,
  unavailableSigner,
  type ApprovalSigner,
} from '../src/ui-catalog/signer.ts'
import { findSourceCheckoutUiRoot } from '../src/ui-catalog/source-checkout.ts'
import { g12 } from '../../ui/gates/catalog/g12-approval-integrity.ts'
import { defaultUsageScope } from '../../ui/catalog/tooling/usage.ts'

const realUiRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui')
const DEV_ORIGIN = 'http://127.0.0.1:5183'
const NOW = new Date('2026-10-20T12:00:00.000Z')

interface Fixture {
  repoRoot: string
  uiRoot: string
  keyDir: string
  privateKey: KeyObject
  trusted: TrustedKey
}

const cleanups: Array<() => void> = []
after(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** A throwaway Ed25519 key written to, and read back from, its own temp directory. */
function throwawayKey(): { keyDir: string; privateKey: KeyObject; trusted: TrustedKey } {
  const keyDir = mkdtempSync(join(tmpdir(), 'guanxi-approval-key-'))
  cleanups.push(() => rmSync(keyDir, { recursive: true, force: true }))
  const pair = generateKeyPairSync('ed25519')
  writeFileSync(join(keyDir, 'key.pem'), pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  const privateKey = createPrivateKey(readFileSync(join(keyDir, 'key.pem'), 'utf8'))
  const { keyId, publicKey } = exportPublicKey(pair.publicKey)
  return { keyDir, privateKey, trusted: { keyId, algorithm: 'ed25519', publicKey, addedAt: NOW.toISOString() } }
}

/** A scratch checkout with two real component folders, trusted keys and one baseline. */
function fixture(trust = true): Fixture {
  const repoRoot = mkdtempSync(join(tmpdir(), 'guanxi-review-repo-'))
  cleanups.push(() => rmSync(repoRoot, { recursive: true, force: true }))
  const uiRoot = join(repoRoot, 'packages', 'ui')
  // The whole src tree: source hashes follow each component's imports and fail closed.
  cpSync(join(realUiRoot, 'src'), join(uiRoot, 'src'), { recursive: true })
  mkdirSync(join(uiRoot, 'catalog', 'snapshots', 'button'), { recursive: true })
  writeFileSync(join(uiRoot, 'catalog', 'snapshots', 'button', 'default.light.png'), 'baseline-bytes')
  mkdirSync(join(repoRoot, '.git'))
  const key = throwawayKey()
  writeFileSync(
    uiPaths(uiRoot).trustedKeys,
    `${JSON.stringify({ keys: trust ? [key.trusted] : [], rotation: null }, null, 2)}\n`,
  )
  return { repoRoot, uiRoot, ...key }
}

function countingSigner(inner: ApprovalSigner): ApprovalSigner & { signs: number } {
  const signer = {
    signs: 0,
    status: () => inner.status(),
    sign: async (bytes: Buffer) => {
      signer.signs += 1
      return inner.sign(bytes)
    },
  }
  return signer
}

function app(service: UiCatalogReviewService) {
  return createApp({} as AppContext, { uiCatalog: service, devOrigins: [DEV_ORIGIN] })
}

function current(uiRoot: string, id: string) {
  const paths = uiPaths(uiRoot)
  return {
    expectedSourceHash: componentSourceHash(paths.componentDir(id)),
    expectedSnapshotHashes: componentSnapshotHashes(paths.snapshots, id),
  }
}

function post(server: ReturnType<typeof app>, id: string, body: unknown, headers: Record<string, string> = {}) {
  return server.request(`http://127.0.0.1:4383${ROUTES.uiCatalogComponentReview(id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: DEV_ORIGIN, 'sec-fetch-site': 'same-origin', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function readRecord(uiRoot: string, id: string) {
  const parsed = parseReviewRecord(JSON.parse(readFileSync(uiPaths(uiRoot).reviewFile(id), 'utf8')), id)
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.errors.join('; '))
  return parsed.record
}

async function runG12(repoRoot: string, uiRoot: string) {
  return g12.run({ repoRoot, uiRoot, usageScope: defaultUsageScope(repoRoot), release: false, base: null })
}

describe('catalog review capability', () => {
  it('is writable only from a source checkout, outside release builds, with a trusted key', async () => {
    const fx = fixture()
    const signer = keyObjectSigner(fx.privateKey)
    const capability = async (options: Partial<ConstructorParameters<typeof UiCatalogReviewService>[0]>) => {
      const service = new UiCatalogReviewService({ uiRoot: fx.uiRoot, release: false, signer, now: () => NOW, ...options })
      const response = await app(service).request(ROUTES.uiCatalogReviewCapability())
      assert.equal(response.status, 200)
      return uiCatalogReviewCapabilityResponse.parse(await response.json())
    }
    assert.deepEqual(await capability({}), { writable: true, reason: null, keyId: fx.trusted.keyId, observedAt: NOW.toISOString() })
    assert.equal((await capability({ release: true })).reason, 'release_build')
    assert.equal((await capability({ uiRoot: null })).reason, 'not_source_checkout')
    assert.equal((await capability({ signer: unavailableSigner('signing_key_missing') })).reason, 'signing_key_missing')
    assert.equal((await capability({ signer: unavailableSigner('platform_unsupported') })).reason, 'platform_unsupported')
    const untrusted = throwawayKey()
    const result = await capability({ signer: keyObjectSigner(untrusted.privateKey) })
    assert.equal(result.writable, false)
    assert.equal(result.reason, 'signing_key_untrusted')
    assert.equal(result.keyId, untrusted.trusted.keyId)
  })

  it('is read-only when createApp gets no review service', async () => {
    const response = await createApp({} as AppContext).request(ROUTES.uiCatalogReviewCapability())
    const body = uiCatalogReviewCapabilityResponse.parse(await response.json())
    assert.equal(body.writable, false)
    assert.equal(body.reason, 'not_source_checkout')
  })

  it('finds the source checkout of this repository and nothing for a plain directory', () => {
    assert.equal(findSourceCheckoutUiRoot(join(realUiRoot, '..', 'server', 'src')), realUiRoot)
    const plain = mkdtempSync(join(tmpdir(), 'guanxi-not-a-checkout-'))
    cleanups.push(() => rmSync(plain, { recursive: true, force: true }))
    assert.equal(findSourceCheckoutUiRoot(plain), null)
  })
})

describe('approving a component', () => {
  let fx: Fixture
  let signer: ReturnType<typeof countingSigner>
  let service: UiCatalogReviewService

  before(() => {
    fx = fixture()
    signer = countingSigner(keyObjectSigner(fx.privateKey))
    service = new UiCatalogReviewService({ uiRoot: fx.uiRoot, release: false, signer, now: () => NOW })
  })

  it('writes a signed record bound to the shown hashes, and G12 accepts it', async () => {
    const before = readFileSync(uiPaths(fx.uiRoot).reviewFile('button'), 'utf8')
    assert.equal(JSON.parse(before).status, 'draft')
    const response = await post(app(service), 'button', {
      decision: 'approve',
      comment: '  Reads well in all four themes.  ',
      ...current(fx.uiRoot, 'button'),
    } satisfies UiComponentReviewBody)
    assert.equal(response.status, 200)
    const body = uiComponentReviewResponse.parse(await response.json())
    assert.equal(body.status, 'approved')
    assert.equal(body.signature, 'valid')
    assert.equal(signer.signs, 1)

    const record = readRecord(fx.uiRoot, 'button')
    assert.equal(record.status, 'approved')
    assert.equal(record.approval?.comment, 'Reads well in all four themes.')
    assert.equal(record.approval?.keyId, fx.trusted.keyId)
    assert.equal(record.approval?.at, NOW.toISOString())
    assert.deepEqual(record.approval?.snapshotHashes, componentSnapshotHashes(uiPaths(fx.uiRoot).snapshots, 'button'))
    assert.equal(Object.keys(record.approval?.snapshotHashes ?? {}).length, 1)
    assert.deepEqual(verifyRecordApproval(record, [fx.trusted]), { state: 'valid', keyId: fx.trusted.keyId })

    const gate = await runG12(fx.repoRoot, fx.uiRoot)
    assert.equal(gate.status, 'pass', JSON.stringify(gate.findings))
  })

  it('fails G12 once any signed field of the record is edited', async () => {
    const path = uiPaths(fx.uiRoot).reviewFile('button')
    const original = readFileSync(path, 'utf8')
    const edits: Array<(record: Record<string, any>) => void> = [
      (record) => { record.approval.comment = 'Approved, and also the new variant.' },
      (record) => { record.approval.sourceHash = `sha256:${'1'.repeat(64)}` },
      (record) => { record.approval.snapshotHashes = {} },
      (record) => { record.approval.at = '2026-10-21T12:00:00.000Z' },
      (record) => { record.id = 'badge' },
    ]
    try {
      for (const edit of edits) {
        const record = JSON.parse(original)
        edit(record)
        writeFileSync(path, JSON.stringify(record, null, 2))
        const gate = await runG12(fx.repoRoot, fx.uiRoot)
        assert.equal(gate.status, 'fail', `edit was not caught: ${edit.toString()}`)
      }
    } finally {
      writeFileSync(path, original)
    }
    assert.equal((await runG12(fx.repoRoot, fx.uiRoot)).status, 'pass')
  })

  it('reports a changed component as stale instead of approved', async () => {
    const tsx = join(uiPaths(fx.uiRoot).componentDir('button'), 'button.tsx')
    const original = readFileSync(tsx, 'utf8')
    try {
      writeFileSync(tsx, `${original}\n// changed after approval\n`)
      const body = uiComponentReviewResponse.parse(await (await app(service).request(ROUTES.uiCatalogComponentReview('button'))).json())
      assert.equal(body.signature, 'valid')
      assert.equal(body.status, 'stale')
    } finally {
      writeFileSync(tsx, original)
    }
  })

  it('goes stale when a transitive helper or the shared styles change after approval (GPT H3)', async () => {
    for (const shared of ['src/lib/cx.ts', 'src/styles/base.css', 'src/story-kit/index.tsx']) {
      const path = join(fx.uiRoot, shared)
      const original = readFileSync(path, 'utf8')
      try {
        writeFileSync(path, `${original}\n/* behaviour changed after approval */\n`)
        const body = uiComponentReviewResponse.parse(await (await app(service).request(ROUTES.uiCatalogComponentReview('button'))).json())
        assert.equal(body.status, 'stale', shared)
      } finally {
        writeFileSync(path, original)
      }
    }
  })

  it('goes stale when a dependency reached by compact or template-literal import syntax changes (GPT N2)', async () => {
    const component = join(fx.uiRoot, 'src/components/badge/badge.tsx')
    const record = uiPaths(fx.uiRoot).reviewFile('badge')
    const helpers = { compact: join(fx.uiRoot, 'src/lib/n2-compact.ts'), lazy: join(fx.uiRoot, 'src/lib/n2-lazy.ts') }
    const [componentBefore, recordBefore] = [readFileSync(component, 'utf8'), readFileSync(record, 'utf8')]
    try {
      writeFileSync(helpers.compact, 'export const compact = 1\n')
      writeFileSync(helpers.lazy, 'export const lazy = 1\n')
      writeFileSync(
        component,
        `${componentBefore}\nimport{ compact }from'../../lib/n2-compact'\nexport const n2Compact = compact\nexport const n2Lazy = () => import(\`../../lib/n2-lazy\`)\n`,
      )
      const approved = await post(app(service), 'badge', { decision: 'approve', comment: 'ok', ...current(fx.uiRoot, 'badge') })
      assert.equal(approved.status, 200)
      for (const helper of Object.values(helpers)) {
        const before = readFileSync(helper, 'utf8')
        writeFileSync(helper, before.replace('= 1', '= 2'))
        const body = uiComponentReviewResponse.parse(await (await app(service).request(ROUTES.uiCatalogComponentReview('badge'))).json())
        assert.equal(body.status, 'stale', helper)
        writeFileSync(helper, before)
      }
    } finally {
      writeFileSync(component, componentBefore)
      writeFileSync(record, recordBefore)
      for (const helper of Object.values(helpers)) rmSync(helper, { force: true })
    }
  })

  it('refuses with 409 and writes nothing when the source or baselines changed since they were shown', async () => {
    const path = uiPaths(fx.uiRoot).reviewFile('badge')
    const before = readFileSync(path, 'utf8')
    const stale = await post(app(service), 'badge', {
      decision: 'approve',
      comment: '',
      expectedSourceHash: `sha256:${'0'.repeat(64)}`,
      expectedSnapshotHashes: {},
    })
    assert.equal(stale.status, 409)
    assert.deepEqual(await stale.json(), {
      code: 'review_conflict',
      message: 'The component changed since it was shown',
      details: { reason: 'source_changed' },
    })
    const snapshots = await post(app(service), 'badge', {
      decision: 'approve',
      comment: '',
      expectedSourceHash: current(fx.uiRoot, 'badge').expectedSourceHash,
      expectedSnapshotHashes: { 'default.light': `sha256:${'2'.repeat(64)}` },
    })
    assert.equal(snapshots.status, 409)
    assert.equal(((await snapshots.json()) as { details: { reason: string } }).details.reason, 'snapshots_changed')
    assert.equal(readFileSync(path, 'utf8'), before)
  })

  it('records a signed change request on an approved record, and G12 rejects restoring the old approval', async () => {
    const approvedText = readFileSync(uiPaths(fx.uiRoot).reviewFile('button'), 'utf8')
    assert.equal(JSON.parse(approvedText).status, 'approved')
    const empty = await post(app(service), 'button', { decision: 'request_changes', comment: '   ', ...current(fx.uiRoot, 'button') })
    assert.equal(empty.status, 400)
    const signsBefore = signer.signs
    const response = await post(app(service), 'button', {
      decision: 'request_changes',
      comment: 'Comfortable density padding feels loose.',
      ...current(fx.uiRoot, 'button'),
    })
    assert.equal(response.status, 200)
    assert.equal(signer.signs, signsBefore + 1, 'the change request on an approved record is signed')
    const record = readRecord(fx.uiRoot, 'button')
    assert.equal(record.status, 'review')
    assert.equal(record.approval, null)
    assert.equal(record.revocation?.keyId, fx.trusted.keyId)
    // N1: the revocation chains to the approval it supersedes.
    assert.equal(record.revocation?.previous, decisionDigest('button', 'approval', JSON.parse(approvedText).approval))
    assert.equal(record.requests.length, 1)
    assert.equal(record.requests[0]?.state, 'open')
    assert.equal(record.requests[0]?.text, 'Comfortable density padding feels loose.')
    assert.equal((await runG12(fx.repoRoot, fx.uiRoot)).status, 'pass')

    // The owner's decision is on main; a branch restores the earlier approval verbatim.
    const path = uiPaths(fx.uiRoot).reviewFile('button')
    const onMain = readFileSync(path, 'utf8')
    writeFileSync(path, approvedText)
    try {
      const restored = await g12.run({
        repoRoot: fx.repoRoot,
        uiRoot: fx.uiRoot,
        usageScope: defaultUsageScope(fx.repoRoot),
        release: false,
        base: { label: 'main', trustedKeys: { keys: [fx.trusted] }, records: { button: JSON.parse(onMain) } },
      })
      assert.equal(restored.status, 'fail')
      assert.match(
        restored.findings.map((finding) => finding.message).join('\n'),
        /the working tree drops the signed revocation of .* \(main\) without a signed decision that chains to it/,
      )
    } finally {
      writeFileSync(path, onMain)
    }
    // Approving again chains the new approval to the revocation, and G12 accepts it.
    const again = await post(app(service), 'button', { decision: 'approve', comment: 'Fixed.', ...current(fx.uiRoot, 'button') })
    assert.equal(again.status, 200)
    const reapproved = readRecord(fx.uiRoot, 'button')
    assert.equal(reapproved.approval?.previous, decisionDigest('button', 'revocation', record.revocation!))
    const accepted = await g12.run({
      repoRoot: fx.repoRoot,
      uiRoot: fx.uiRoot,
      usageScope: defaultUsageScope(fx.repoRoot),
      release: false,
      base: { label: 'main', trustedKeys: { keys: [fx.trusted] }, records: { button: JSON.parse(onMain) } },
    })
    assert.equal(accepted.status, 'pass', accepted.findings.map((finding) => finding.message).join('\n'))
  })

  it('serialises an approval and a change request racing on one component', async () => {
    const race = fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const inner = keyObjectSigner(race.privateKey)
    let first = true
    const slowSigner: ApprovalSigner = {
      status: () => inner.status(),
      sign: async (bytes) => {
        if (first) {
          first = false
          await gate
        }
        return inner.sign(bytes)
      },
    }
    const raceService = new UiCatalogReviewService({ uiRoot: race.uiRoot, release: false, signer: slowSigner, now: () => NOW })
    const approving = post(app(raceService), 'badge', { decision: 'approve', comment: '', ...current(race.uiRoot, 'badge') })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const requesting = post(app(raceService), 'badge', { decision: 'request_changes', comment: 'Wider padding.', ...current(race.uiRoot, 'badge') })
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    assert.deepEqual([(await approving).status, (await requesting).status], [200, 200])
    const record = readRecord(race.uiRoot, 'badge')
    // Without the per-component lock the request reads the draft, and the approval then
    // overwrites it: the request would be lost and the record would read approved.
    assert.equal(record.status, 'review')
    assert.equal(record.approval, null)
    assert.ok(record.revocation)
    assert.deepEqual(record.requests.map((request) => request.text), ['Wider padding.'])
  })

  it('serialises concurrent decisions on one component and keeps the record valid', async () => {
    const results = await Promise.all(
      ['First note.', 'Second note.', 'Third note.'].map((comment) =>
        post(app(service), 'badge', { decision: 'request_changes', comment, ...current(fx.uiRoot, 'badge') }),
      ),
    )
    assert.deepEqual(results.map((response) => response.status), [200, 200, 200])
    const record = readRecord(fx.uiRoot, 'badge')
    assert.deepEqual(record.requests.map((request) => request.text).sort(), ['First note.', 'Second note.', 'Third note.'])
  })
})

describe('refusals', () => {
  it('never prompts the owner for an untrusted key or a release build', async () => {
    const fx = fixture(false)
    const signer = countingSigner(keyObjectSigner(fx.privateKey))
    const untrusted = await post(
      app(new UiCatalogReviewService({ uiRoot: fx.uiRoot, release: false, signer })),
      'button',
      { decision: 'approve', comment: '', ...current(fx.uiRoot, 'button') },
    )
    assert.equal(untrusted.status, 503)
    assert.equal(((await untrusted.json()) as { details: { reason: string } }).details.reason, 'signing_key_untrusted')
    const release = await post(
      app(new UiCatalogReviewService({ uiRoot: fx.uiRoot, release: true, signer })),
      'button',
      { decision: 'approve', comment: '', ...current(fx.uiRoot, 'button') },
    )
    assert.equal(release.status, 403)
    assert.equal(((await release.json()) as { details: { reason: string } }).details.reason, 'release_build')
    assert.equal(signer.signs, 0)
    assert.equal(readRecord(fx.uiRoot, 'button').status, 'draft')
  })

  it('rejects unknown, traversing and malformed component ids', async () => {
    const fx = fixture()
    const server = app(new UiCatalogReviewService({ uiRoot: fx.uiRoot, release: false, signer: keyObjectSigner(fx.privateKey) }))
    for (const id of ['missing', 'Button', 'button%2F..', '..%2F..%2Fetc', 'button.']) {
      const response = await post(server, id, { decision: 'approve', comment: '', ...current(fx.uiRoot, 'button') })
      assert.equal(response.status, 404, id)
      assert.equal(((await response.json()) as { code: string }).code, 'component_not_found', id)
    }
    // A bare `..` segment is resolved by URL normalisation before routing and never reaches the id.
    assert.equal((await post(server, '..', {})).status, 404)
  })

  it('refuses writes from other origins, non-loopback hosts and non-JSON bodies', async () => {
    const fx = fixture()
    const signer = countingSigner(keyObjectSigner(fx.privateKey))
    const server = app(new UiCatalogReviewService({ uiRoot: fx.uiRoot, release: false, signer }))
    const body = { decision: 'approve', comment: '', ...current(fx.uiRoot, 'button') }
    const cases: Array<[Record<string, string>, string]> = [
      [{ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, 'cross_site_request'],
      [{ origin: 'http://localhost:3000', 'sec-fetch-site': 'same-site' }, 'cross_site_request'],
      [{ origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' }, 'foreign_origin'],
      [{ host: 'evil.example:4383' }, 'non_loopback_host'],
      [{ 'content-type': 'text/plain' }, 'json_required'],
    ]
    for (const [headers, reason] of cases) {
      const response = await post(server, 'button', body, headers)
      assert.equal(response.status, 403, reason)
      assert.equal(((await response.json()) as { details: { reason: string } }).details.reason, reason)
    }
    // With HOST=0.0.0.0 a LAN client can send Host: 127.0.0.1; the peer address still decides.
    const lan = await server.request(
      `http://127.0.0.1:4383${ROUTES.uiCatalogComponentReview('button')}`,
      { method: 'POST', headers: { 'content-type': 'application/json', origin: DEV_ORIGIN }, body: JSON.stringify(body) },
      { incoming: { socket: { remoteAddress: '192.168.1.20' } } },
    )
    assert.equal(lan.status, 403)
    assert.equal(((await lan.json()) as { details: { reason: string } }).details.reason, 'non_loopback_peer')
    const lanRead = await server.request(`http://127.0.0.1:4383${ROUTES.uiCatalogReviewCapability()}`, {}, {
      incoming: { socket: { remoteAddress: '10.0.0.7' } },
    })
    assert.equal(lanRead.status, 403)
    assert.equal(signer.signs, 0)
    assert.equal(readRecord(fx.uiRoot, 'button').status, 'draft')
  })
})

describe('filesystem boundary (GPT M2)', () => {
  it('refuses a component directory that is a symlink out of the checkout', async () => {
    const fx = fixture()
    const outside = mkdtempSync(join(tmpdir(), 'guanxi-outside-'))
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }))
    writeFileSync(join(outside, 'escape.tsx'), 'export const Escape = 1\n')
    symlinkSync(outside, join(fx.uiRoot, 'src', 'components', 'escape'), 'dir')
    const server = app(new UiCatalogReviewService({ uiRoot: fx.uiRoot, release: false, signer: keyObjectSigner(fx.privateKey) }))
    const response = await post(server, 'escape', {
      decision: 'approve',
      comment: '',
      expectedSourceHash: `sha256:${'0'.repeat(64)}`,
      expectedSnapshotHashes: {},
    })
    assert.equal(response.status, 404)
    assert.equal(((await response.json()) as { code: string }).code, 'component_not_found')
    assert.equal(existsSync(join(outside, 'escape.review.json')), false)
    assert.equal((await server.request(ROUTES.uiCatalogComponentReview('escape'))).status, 404)
  })

  it('refuses a review record that is a symlink', async () => {
    const fx = fixture()
    const outside = mkdtempSync(join(tmpdir(), 'guanxi-outside-'))
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }))
    const record = uiPaths(fx.uiRoot).reviewFile('badge')
    writeFileSync(join(outside, 'target.json'), readFileSync(record, 'utf8'))
    rmSync(record)
    symlinkSync(join(outside, 'target.json'), record)
    const server = app(new UiCatalogReviewService({ uiRoot: fx.uiRoot, release: false, signer: keyObjectSigner(fx.privateKey) }))
    const response = await post(server, 'badge', { decision: 'request_changes', comment: 'x', ...current(fx.uiRoot, 'badge') })
    assert.equal(response.status, 404)
    assert.equal(JSON.parse(readFileSync(join(outside, 'target.json'), 'utf8')).requests.length, 0)
  })

  it('refuses when the component directory is swapped for a symlink during the keychain prompt', async () => {
    const fx = fixture()
    const outside = mkdtempSync(join(tmpdir(), 'guanxi-outside-'))
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }))
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const inner = keyObjectSigner(fx.privateKey)
    const slow: ApprovalSigner = { status: () => inner.status(), sign: async (bytes) => (await gate, inner.sign(bytes)) }
    const service = new UiCatalogReviewService({ uiRoot: fx.uiRoot, release: false, signer: slow })
    const pending = post(app(service), 'badge', { decision: 'approve', comment: '', ...current(fx.uiRoot, 'badge') })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const dir = uiPaths(fx.uiRoot).componentDir('badge')
    cpSync(dir, outside, { recursive: true })
    rmSync(dir, { recursive: true })
    symlinkSync(outside, dir, 'dir')
    release()
    const response = await pending
    assert.ok([404, 409].includes(response.status), String(response.status))
    assert.equal(JSON.parse(readFileSync(join(outside, 'badge.review.json'), 'utf8')).status, 'draft')
  })

  it('refuses when the components root itself is a symlink out of the checkout (GPT N4)', async () => {
    const fx = fixture()
    const outside = mkdtempSync(join(tmpdir(), 'guanxi-outside-'))
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }))
    const shown = current(fx.uiRoot, 'badge')
    const root = uiPaths(fx.uiRoot).components
    cpSync(root, outside, { recursive: true })
    rmSync(root, { recursive: true })
    symlinkSync(outside, root, 'dir')
    const server = app(new UiCatalogReviewService({ uiRoot: fx.uiRoot, release: false, signer: keyObjectSigner(fx.privateKey) }))
    const response = await post(server, 'badge', { decision: 'approve', comment: '', ...shown })
    assert.equal(response.status, 404)
    assert.equal(JSON.parse(readFileSync(join(outside, 'badge', 'badge.review.json'), 'utf8')).status, 'draft')
  })

  it('refuses when the components root is swapped for a symlink during the keychain prompt (GPT N4)', async () => {
    const fx = fixture()
    const outside = mkdtempSync(join(tmpdir(), 'guanxi-outside-'))
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }))
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const inner = keyObjectSigner(fx.privateKey)
    const slow: ApprovalSigner = { status: () => inner.status(), sign: async (bytes) => (await gate, inner.sign(bytes)) }
    const service = new UiCatalogReviewService({ uiRoot: fx.uiRoot, release: false, signer: slow })
    const pending = post(app(service), 'badge', { decision: 'approve', comment: '', ...current(fx.uiRoot, 'badge') })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const root = uiPaths(fx.uiRoot).components
    cpSync(root, outside, { recursive: true })
    rmSync(root, { recursive: true })
    symlinkSync(outside, root, 'dir')
    release()
    const response = await pending
    assert.ok([404, 409].includes(response.status), String(response.status))
    assert.equal(JSON.parse(readFileSync(join(outside, 'badge', 'badge.review.json'), 'utf8')).status, 'draft')
  })
})

describe('failure behaviour', () => {
  it('does not overwrite a record that changed while the owner answered the keychain prompt', async () => {
    const fx = fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const inner = keyObjectSigner(fx.privateKey)
    const slow: ApprovalSigner = { status: () => inner.status(), sign: async (bytes) => (await gate, inner.sign(bytes)) }
    const service = new UiCatalogReviewService({ uiRoot: fx.uiRoot, release: false, signer: slow })
    const pending = post(app(service), 'badge', { decision: 'approve', comment: '', ...current(fx.uiRoot, 'badge') })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const path = uiPaths(fx.uiRoot).reviewFile('badge')
    const edited = readFileSync(path, 'utf8').replace('"requests": []', '"requests": [{ "id": "r-1", "at": "2026-10-20T12:00:00.000Z", "text": "agent note", "state": "open" }]')
    writeFileSync(path, edited)
    release()
    const response = await pending
    assert.equal(response.status, 409)
    assert.equal(((await response.json()) as { details: { reason: string } }).details.reason, 'record_changed')
    assert.equal(readFileSync(path, 'utf8'), edited)
  })

  it('reports a keychain tool that cannot run as a missing key, not a server error', async () => {
    const fx = fixture()
    const broken: ApprovalSigner = {
      status: () => Promise.reject(new Error('spawn /usr/bin/security ENOENT')),
      sign: () => Promise.reject(new Error('unreachable')),
    }
    const response = await app(new UiCatalogReviewService({ uiRoot: fx.uiRoot, release: false, signer: broken })).request(
      ROUTES.uiCatalogReviewCapability(),
    )
    assert.equal(response.status, 200)
    assert.equal(uiCatalogReviewCapabilityResponse.parse(await response.json()).reason, 'signing_key_missing')
  })
})

describe('release builds', () => {
  it('both bundles define __GUANXI_RELEASE_BUILD__, which turns RELEASE_BUILD on', async () => {
    const { build } = await import('esbuild')
    const root = join(realUiRoot, '..')
    for (const script of ['server/scripts/build.mjs', 'cli/scripts/build.mjs']) {
      assert.match(readFileSync(join(root, script), 'utf8'), /define:\s*\{\s*__GUANXI_RELEASE_BUILD__:\s*'true'\s*\}/, script)
    }
    const bundle = async (define: Record<string, string>) => {
      const out = await build({
        entryPoints: [join(root, 'server', 'src', 'release.ts')],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'node',
        define,
      })
      const code = out.outputFiles[0]!.text
      return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).RELEASE_BUILD as boolean
    }
    assert.equal(await bundle({ __GUANXI_RELEASE_BUILD__: 'true' }), true)
    assert.equal(await bundle({}), false)
  })
})

describe('keychain signer', () => {
  function fakeSecurity(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'guanxi-fake-security-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'security')
    writeFileSync(path, `#!/bin/sh\n${script}\n`)
    chmodSync(path, 0o755)
    return path
  }

  it('reads the key id from item metadata without asking for the secret', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'guanxi-security-log-')), 'args')
    const security = fakeSecurity(
      `echo "$@" >> '${log}'\necho 'attributes:'\necho '    "icmt"<blob>="ed25519:0123456789abcdef0123456789abcdef"'`,
    )
    const status = await keychainSigner({ securityPath: security, platform: 'darwin' }).status()
    assert.deepEqual(status, { state: 'available', keyId: 'ed25519:0123456789abcdef0123456789abcdef' })
    const args = readFileSync(log, 'utf8')
    assert.match(args, /find-generic-password -s guanxi.ui-approval -a owner-approval-key/)
    assert.doesNotMatch(args, /-w/)
  })

  it('maps a missing item, a denied prompt and other platforms', async () => {
    const missing = fakeSecurity('exit 44')
    assert.deepEqual(await keychainSigner({ securityPath: missing, platform: 'darwin' }).status(), {
      state: 'unavailable',
      reason: 'signing_key_missing',
    })
    await assert.rejects(keychainSigner({ securityPath: missing, platform: 'darwin' }).sign(Buffer.from('x')), {
      reason: 'signing_key_missing',
    })
    const denied = fakeSecurity('exit 51')
    await assert.rejects(keychainSigner({ securityPath: denied, platform: 'darwin' }).sign(Buffer.from('x')), {
      reason: 'signing_denied',
    })
    const unanswered = fakeSecurity('sleep 5')
    await assert.rejects(
      keychainSigner({ securityPath: unanswered, platform: 'darwin', promptTimeoutMs: 200 }).sign(Buffer.from('x')),
      { reason: 'signing_timeout' },
    )
    assert.deepEqual(await keychainSigner({ platform: 'linux' }).status(), {
      state: 'unavailable',
      reason: 'platform_unsupported',
    })
  })

  it('signs with the key the fake keychain returns and derives its id', async () => {
    const key = throwawayKey()
    const der = key.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
    const security = fakeSecurity(`echo '${der}'`)
    const signed = await keychainSigner({ securityPath: security, platform: 'darwin' }).sign(Buffer.from('payload'))
    assert.equal(signed.keyId, key.trusted.keyId)
    assert.ok(signed.signature.length > 40)
  })

  // Opt-in: creates and deletes a throwaway keychain file; never touches the login keychain.
  it(
    'round-trips through a throwaway macOS keychain created by approval-key.ts',
    { skip: process.platform !== 'darwin' || process.env['GUANXI_TEST_MACOS_KEYCHAIN'] !== '1' },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'guanxi-keychain-'))
      const keychain = join(dir, 'approval-test.keychain-db')
      const before = spawnSync('security', ['list-keychains', '-d', 'user'], { encoding: 'utf8' }).stdout
      try {
        assert.equal(spawnSync('security', ['create-keychain', '-p', 'throwaway', keychain]).status, 0)
        assert.equal(spawnSync('security', ['unlock-keychain', '-p', 'throwaway', keychain]).status, 0)
        const init = spawnSync(
          process.execPath,
          [join(realUiRoot, 'catalog', 'scripts', 'approval-key.ts'), 'init', '--keychain', keychain, '--service', 'guanxi.ui-approval', '--trust-security-tool'],
          { encoding: 'utf8' },
        )
        assert.equal(init.status, 0, init.stderr)
        const entry = JSON.parse(init.stdout.slice(init.stdout.indexOf('{'), init.stdout.lastIndexOf('}') + 1)) as TrustedKey
        assert.doesNotMatch(init.stdout + init.stderr, /PRIVATE|BEGIN/)
        const signer = keychainSigner({ keychain, platform: 'darwin' })
        assert.deepEqual(await signer.status(), { state: 'available', keyId: entry.keyId })
        const signed = await signer.sign(Buffer.from('payload'))
        assert.equal(signed.keyId, entry.keyId)
      } finally {
        spawnSync('security', ['delete-keychain', keychain])
        rmSync(dir, { recursive: true, force: true })
        assert.equal(spawnSync('security', ['list-keychains', '-d', 'user'], { encoding: 'utf8' }).stdout, before)
      }
    },
  )
})
