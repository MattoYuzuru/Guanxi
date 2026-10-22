/**
 * The approval signing helper's protocol, exercised through the test build: a software P-256
 * key in a temp directory and a fake authenticator. The production helper's init and sign are
 * never called here, and no owner keychain item is touched.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createPublicKey, verify } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { APPROVAL_SCHEMA, canonicalJson } from '@guanxi/ui/approval'
import { p256TestKey } from '../../ui/gates/catalog/lib/test-key.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const helperDir = join(repoRoot, 'native', 'approval-signer')
const buildScript = join(helperDir, 'build.sh')
const testBinary = join(helperDir, '.build', 'approval-signer-test')
const SERVICE = 'test.service'
const ACCOUNT = 'test.account'
const swiftc = spawnSync('swiftc', ['--version'], { encoding: 'utf8' })
const skip = process.platform !== 'darwin' ? 'the helper needs macOS Security and CryptoKit' : swiftc.status === 0 ? false : 'swiftc is not available'

interface HelperResult {
  status: number | null
  stdout: string
  stderr: string
  json: Record<string, any> | null
}

interface Fixture {
  key: ReturnType<typeof p256TestKey>
  env: NodeJS.ProcessEnv
  itemPath: string
  authLog: string
  dispose(): void
}

const cleanups: Array<() => void> = []
after(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function fixture(): Fixture {
  const key = p256TestKey('helper test key')
  cleanups.push(key.dispose)
  const authLog = join(key.dir, 'auth.log')
  return {
    key,
    authLog,
    itemPath: `${key.rawPath}.item`,
    env: { ...process.env, SIGNER_TEST_KEY: key.rawPath, SIGNER_TEST_AUTH_LOG: authLog },
    dispose: key.dispose,
  }
}

function run(binary: string, request: unknown, env: NodeJS.ProcessEnv): HelperResult {
  const result = spawnSync(binary, [], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    env,
    timeout: 30_000,
  })
  let json: Record<string, any> | null = null
  try {
    json = result.stdout.trim() === '' ? null : (JSON.parse(result.stdout) as Record<string, any>)
  } catch {
    json = null
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json }
}

function authLines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
}

function approvalPayload(keyId: string, id = 'button') {
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

function verifies(publicKey: string, payload: string, signature: string): boolean {
  return verify(
    'sha256',
    Buffer.from(payload, 'utf8'),
    { key: createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }), dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64'),
  )
}

describe('approval signing helper protocol', { skip }, () => {
  before(() => {
    const built = spawnSync('sh', [buildScript, '--test'], { cwd: repoRoot, encoding: 'utf8' })
    assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`)
    assert.ok(existsSync(testBinary))
  })

  it('reports missing before init, creates the key once and reports it without prompting', () => {
    const fx = fixture()
    const status = run(testBinary, { op: 'status', service: SERVICE, account: ACCOUNT }, fx.env)
    assert.equal(status.status, 0)
    assert.deepEqual(status.json, { ok: true, state: 'missing' })
    assert.equal(authLines(fx.authLog).length, 0, 'status must never prompt')

    const init = run(testBinary, { op: 'init', service: SERVICE, account: ACCOUNT }, fx.env)
    assert.equal(init.status, 0)
    assert.equal(init.json?.['ok'], true)
    assert.equal(init.json?.['state'], 'available')
    assert.equal(init.json?.['algorithm'], 'p256')
    assert.match(init.json?.['keyId'] ?? '', /^p256:[0-9a-f]{32}$/)
    assert.equal(init.json?.['publicKey'], fx.key.trusted.publicKey)

    const again = run(testBinary, { op: 'init', service: SERVICE, account: ACCOUNT }, fx.env)
    assert.equal(again.status, 1)
    assert.equal(again.json?.['ok'], false)
    assert.equal(again.json?.['code'], 'key_exists')
    assert.equal(authLines(fx.authLog).length, 0)
  })

  it('signs the exact canonical payload bytes and the signature verifies', () => {
    const fx = fixture()
    const init = run(testBinary, { op: 'init', service: SERVICE, account: ACCOUNT }, fx.env)
    assert.equal(init.status, 0)
    const payload = canonicalJson(approvalPayload(init.json!['keyId'] as string))
    const signed = run(testBinary, { op: 'sign', service: SERVICE, account: ACCOUNT, payload }, fx.env)
    assert.equal(signed.status, 0, signed.stderr)
    assert.equal(signed.json?.['ok'], true)
    assert.equal(signed.json?.['keyId'], init.json?.['keyId'])
    assert.equal(Buffer.from(signed.json?.['signature'] as string, 'base64').length, 64)
    assert.equal(verifies(init.json!['publicKey'] as string, payload, signed.json!['signature'] as string), true)
  })

  it('writes the exact approval reason to the fake authenticator log', () => {
    const fx = fixture()
    const init = run(testBinary, { op: 'init', service: SERVICE, account: ACCOUNT }, fx.env)
    const payload = canonicalJson(approvalPayload(init.json!['keyId'] as string))
    const signed = run(testBinary, { op: 'sign', service: SERVICE, account: ACCOUNT, payload }, fx.env)
    assert.equal(signed.status, 0)
    assert.deepEqual(authLines(fx.authLog), [
      `approve the "button" component, source sha256:${'a'.repeat(64)}`,
    ])
  })

  it('refuses a non-canonical payload, the removed /2 schema and an invalid id', () => {
    const fx = fixture()
    const init = run(testBinary, { op: 'init', service: SERVICE, account: ACCOUNT }, fx.env)
    const payload = approvalPayload(init.json!['keyId'] as string)
    const cases: Array<[string, string]> = [
      [JSON.stringify(payload, null, 2), 'payload_not_canonical'],
      [canonicalJson({ ...payload, schema: 'guanxi.ui-approval/2' }), 'payload_schema'],
      [canonicalJson({ ...payload, id: 'Button' }), 'payload_id'],
    ]
    for (const [text, code] of cases) {
      const refused = run(testBinary, { op: 'sign', service: SERVICE, account: ACCOUNT, payload: text }, fx.env)
      assert.equal(refused.status, 1, code)
      assert.equal(refused.json?.['ok'], false, code)
      assert.equal(refused.json?.['code'], code)
      assert.equal(refused.json?.['signature'], undefined)
    }
    assert.equal(authLines(fx.authLog).length, 0, 'no failed validation may prompt')
  })

  it('refuses to sign when the fake authenticator denies, returning signing_denied only', () => {
    const fx = fixture()
    const init = run(testBinary, { op: 'init', service: SERVICE, account: ACCOUNT }, fx.env)
    const payload = canonicalJson(approvalPayload(init.json!['keyId'] as string))
    const denied = run(testBinary, { op: 'sign', service: SERVICE, account: ACCOUNT, payload }, { ...fx.env, SIGNER_TEST_AUTH_DENY: '1' })
    assert.equal(denied.status, 1)
    assert.deepEqual(denied.json, {
      ok: false,
      code: 'signing_denied',
      message: 'The owner cancelled or failed authentication',
    })
    assert.equal(authLines(fx.authLog).length, 1, 'the fake authenticator was asked once')
  })
})
