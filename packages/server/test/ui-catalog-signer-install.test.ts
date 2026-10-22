/**
 * The installed approval signer boundary: the installer layout, the node adapter's protocol
 * mapping and the owner key script. Helper calls use the test build with a software key in a
 * temp directory; the production helper's init and sign are never invoked.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createPublicKey, verify } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { PRODUCT_FILE_PREFIX, PRODUCT_NAME } from '@guanxi/contract'
import { APPROVAL_SCHEMA, canonicalJson } from '@guanxi/ui/approval'
import { SignerError, approvalSignerPath, helperSigner } from '../src/ui-catalog/signer.ts'
import { p256TestKey } from '../../ui/gates/catalog/lib/test-key.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const helperDir = join(repoRoot, 'native', 'approval-signer')
const buildScript = join(helperDir, 'build.sh')
const testBinary = join(helperDir, '.build', 'approval-signer-test')
const installer = join(repoRoot, 'packages', 'server', 'scripts', 'install-approval-signer.ts')
const keyScript = join(repoRoot, 'packages', 'ui', 'catalog', 'scripts', 'approval-key.ts')
const swiftc = spawnSync('swiftc', ['--version'], { encoding: 'utf8' })
const skip = process.platform !== 'darwin' ? 'the helper needs macOS Security and CryptoKit' : swiftc.status === 0 ? false : 'swiftc is not available'
const SERVICE = 'test.service'
const ACCOUNT = 'test.account'

const cleanups: Array<() => void> = []
after(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function temporary(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

interface Fixture {
  key: ReturnType<typeof p256TestKey>
  env: NodeJS.ProcessEnv
  itemPath: string
  dispose(): void
}

function fixture(): Fixture {
  const key = p256TestKey('helper adapter test key')
  cleanups.push(key.dispose)
  return {
    key,
    itemPath: `${key.rawPath}.item`,
    env: { ...process.env, SIGNER_TEST_KEY: key.rawPath, SIGNER_TEST_AUTH_LOG: join(key.dir, 'auth.log') },
    dispose: key.dispose,
  }
}

function runHelper(binary: string, request: unknown, env: NodeJS.ProcessEnv) {
  return spawnSync(binary, [], { input: JSON.stringify(request), encoding: 'utf8', env, timeout: 30_000 })
}

function approvePayload(keyId: string, id = 'button') {
  return {
    schema: APPROVAL_SCHEMA,
    id,
    status: 'approved',
    at: '2026-10-20T12:00:00.000Z',
    sourceHash: `sha256:${'a'.repeat(64)}`,
    snapshotHashes: {},
    comment: 'Looks right.',
    keyId,
    previous: null,
  }
}

function verifies(publicKey: string, payload: Buffer, signature: string): boolean {
  return verify(
    'sha256',
    payload,
    { key: createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }), dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64'),
  )
}

describe('installed approval signer', { skip }, () => {
  before(() => {
    const built = spawnSync('sh', [buildScript, '--test'], { cwd: repoRoot, encoding: 'utf8' })
    assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`)
    assert.ok(existsSync(testBinary))
  })

  it('installs the helper under the brand path, executable and ad-hoc signed', () => {
    const home = temporary('guanxi-signer-home-')
    const result = spawnSync(process.execPath, [installer, '--home', home], { encoding: 'utf8', env: { ...process.env, SIGNER_IDENTIFIER: 'local.guanxi.test' } })
    assert.equal(result.status, 0, result.stderr)
    const installed = result.stdout.trim().split('\n').at(-1)!
    assert.equal(
      installed,
      join(home, 'Library', 'Application Support', PRODUCT_NAME, 'approval-signer', `${PRODUCT_FILE_PREFIX}-approval-signer`),
    )
    assert.equal(statSync(installed).mode & 0o777, 0o755)
    const codesign = spawnSync('codesign', ['--verify', '--strict', installed], { encoding: 'utf8' })
    assert.equal(codesign.status, 0, codesign.stderr)
    assert.equal(approvalSignerPath(home), installed)
  })

  it('maps a missing helper to signer_helper_missing without running anything', async () => {
    const missing = join(temporary('guanxi-missing-helper-'), 'approval-signer')
    const signer = helperSigner({ helperPath: missing, service: SERVICE, account: ACCOUNT, timeoutMs: 1_000 })
    assert.deepEqual(await signer.status(), { state: 'unavailable', reason: 'signer_helper_missing' })
    await assert.rejects(signer.sign(Buffer.from('{"a":1}')), { reason: 'signer_helper_missing' })
  })

  it('exposes only keyId, publicKey and signature, and signs the exact bytes it receives', async () => {
    const fx = fixture()
    const init = runHelper(testBinary, { op: 'init', service: SERVICE, account: ACCOUNT }, fx.env)
    assert.equal(init.status, 0, init.stderr)
    const signer = helperSigner({ helperPath: testBinary, service: SERVICE, account: ACCOUNT, timeoutMs: 30_000, env: fx.env })
    const status = await signer.status()
    assert.deepEqual(Object.keys(status).sort(), ['keyId', 'publicKey', 'state'])
    assert.equal(status.state, 'available')
    if (status.state !== 'available') return
    assert.equal(status.keyId, fx.key.trusted.keyId)
    assert.equal(status.publicKey, fx.key.trusted.publicKey)

    const bytes = Buffer.from(canonicalJson(approvePayload(status.keyId)), 'utf8')
    const signed = await signer.sign(bytes)
    assert.deepEqual(Object.keys(signed).sort(), ['keyId', 'signature'])
    assert.equal(signed.keyId, status.keyId)
    assert.equal(verifies(status.publicKey, bytes, signed.signature), true)
  })

  it('maps a non-canonical payload to payload_not_canonical', async () => {
    const fx = fixture()
    assert.equal(runHelper(testBinary, { op: 'init', service: SERVICE, account: ACCOUNT }, fx.env).status, 0)
    const signer = helperSigner({ helperPath: testBinary, service: SERVICE, account: ACCOUNT, timeoutMs: 30_000, env: fx.env })
    await assert.rejects(signer.sign(Buffer.from('{\n  "schema": "guanxi.ui-approval/3"\n}')), {
      reason: 'payload_not_canonical',
    })
  })

  it('times out a helper that does not answer, and refuses unbounded output', async () => {
    const dir = temporary('guanxi-fake-helper-')
    const slow = join(dir, 'slow')
    writeFileSync(slow, '#!/bin/sh\nsleep 2\n', { mode: 0o755 })
    const slowSigner = helperSigner({ helperPath: slow, service: SERVICE, account: ACCOUNT, timeoutMs: 100 })
    await assert.rejects(slowSigner.sign(Buffer.from('{"ok":true}')), { reason: 'signing_timeout' })

    const loud = join(dir, 'loud')
    writeFileSync(loud, "#!/bin/sh\nhead -c 70000 /dev/zero | tr '\\0' x\n", { mode: 0o755 })
    const loudSigner = helperSigner({ helperPath: loud, service: SERVICE, account: ACCOUNT, timeoutMs: 5_000 })
    await assert.rejects(loudSigner.sign(Buffer.from('{"ok":true}')), { reason: 'signing_key_invalid' })
  })

  it('creates the owner entry through the installed helper and prints it in P-256 form', () => {
    const fx = fixture()
    const result = spawnSync(process.execPath, [keyScript, 'init', '--helper', testBinary, '--service', SERVICE, '--account', ACCOUNT], {
      encoding: 'utf8',
      env: fx.env,
    })
    assert.equal(result.status, 0, result.stderr)
    const entry = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'), result.stdout.lastIndexOf('}') + 1)) as {
      keyId: string
      algorithm: string
      publicKey: string
    }
    assert.equal(entry.algorithm, 'p256')
    assert.equal(entry.keyId, fx.key.trusted.keyId)
    assert.equal(entry.publicKey, fx.key.trusted.publicKey)
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE|BEGIN|SIGNER_TEST_KEY/)
    assert.equal(existsSync(fx.itemPath), true)
    assert.equal(readFileSync(fx.itemPath, 'utf8'), 'signer-test-item\n')

    const shown = spawnSync(process.execPath, [keyScript, 'show', '--helper', testBinary, '--service', SERVICE, '--account', ACCOUNT], {
      encoding: 'utf8',
      env: fx.env,
    })
    assert.equal(shown.status, 0, shown.stderr)
    assert.match(shown.stdout, new RegExp(fx.key.trusted.keyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
})

describe('approval signer platform guard', () => {
  it('reports platform_unsupported on a Linux injection without spawning the helper', async () => {
    const dir = temporary('guanxi-signer-platform-')
    const marker = join(dir, 'spawned')
    const helper = join(dir, 'helper')
    writeFileSync(
      helper,
      '#!/bin/sh\ncat >/dev/null\nprintf spawned > "$SIGNER_TEST_SPAWN_MARKER"\nprintf \'%s\\n\' \'{"ok":true,"state":"missing"}\'\n',
      { mode: 0o755 },
    )
    const missing = join(dir, 'missing-helper')
    const missingSigner = helperSigner({
      helperPath: missing,
      service: SERVICE,
      account: ACCOUNT,
      timeoutMs: 1_000,
      platform: 'linux',
    })
    const platformError = (error: unknown) => {
      assert.ok(error instanceof SignerError)
      assert.equal(error.reason, 'platform_unsupported')
      assert.doesNotMatch(error.message, /install-approval-signer/)
      return true
    }

    // The missing-helper case is the one that used to report signer_helper_missing and an
    // install command on Linux.
    assert.deepEqual(await missingSigner.status(), { state: 'unavailable', reason: 'platform_unsupported' })
    await assert.rejects(missingSigner.sign(Buffer.from('{"a":1}')), platformError)

    const signer = helperSigner({
      helperPath: helper,
      service: SERVICE,
      account: ACCOUNT,
      timeoutMs: 1_000,
      platform: 'linux',
      env: { ...process.env, SIGNER_TEST_SPAWN_MARKER: marker },
    })
    assert.deepEqual(await signer.status(), { state: 'unavailable', reason: 'platform_unsupported' })
    assert.equal(existsSync(marker), false, 'status must not spawn the helper')
    await assert.rejects(signer.sign(Buffer.from('{"a":1}')), platformError)
    assert.equal(existsSync(marker), false, 'sign must not spawn the helper')
  })
})
