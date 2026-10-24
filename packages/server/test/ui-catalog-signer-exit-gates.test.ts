/**
 * Exit gates for the approval signer (DS2 item 4). Every test uses the test build with a
 * software P-256 key in a temp directory and a fake authenticator; the production helper's
 * init and sign are never called, and no owner keychain item is touched.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createPublicKey } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  approvalPayload,
  canonicalJson,
  componentSnapshotHashes,
  componentSourceHash,
  serialiseRecord,
  uiPaths,
  verifyRecordApproval,
  type ReviewRecord,
  type TrustedKey,
} from '@guanxi/ui/approval'
import { g12 } from '../../ui/gates/catalog/g12-approval-integrity.ts'
import { createScratch } from '../../ui/gates/catalog/lib/scratch.ts'
import { p256TestKey } from '../../ui/gates/catalog/lib/test-key.ts'
import { defaultUsageScope } from '../../ui/catalog/tooling/usage.ts'
import { helperSigner } from '../src/ui-catalog/signer.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const helperDir = join(repoRoot, 'native', 'approval-signer')
const buildScript = join(helperDir, 'build.sh')
const source = join(helperDir, 'Sources', 'main.swift')
const moduleCache = join(helperDir, '.build', 'mc')
const testBinary = join(helperDir, '.build', 'approval-signer-test')
const productionBinary = join(helperDir, '.build', 'approval-signer')
const SERVICE = 'exit-gate.service'
const ACCOUNT = 'exit-gate.account'
const swiftc = spawnSync('swiftc', ['--version'], { encoding: 'utf8' })
const security = spawnSync('security', ['help'], { encoding: 'utf8' })
const swiftSkip = process.platform !== 'darwin' ? 'the helper needs macOS Security and CryptoKit' : swiftc.status === 0 ? false : 'swiftc is not available'
const keychainSkip = process.platform !== 'darwin' ? 'the keychain test needs macOS' : security.status === 0 ? false : `security is unusable: ${security.stderr.trim()}`

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
  authLog: string
  itemPath: string
}

function fixture(): Fixture {
  const key = p256TestKey('exit gate key')
  cleanups.push(key.dispose)
  const authLog = join(key.dir, 'auth.log')
  return {
    key,
    authLog,
    itemPath: `${key.rawPath}.item`,
    env: { ...process.env, SIGNER_TEST_KEY: key.rawPath, SIGNER_TEST_AUTH_LOG: authLog },
  }
}

interface Result {
  status: number | null
  stdout: Buffer
  stderr: Buffer
  json: Record<string, any> | null
  signal: NodeJS.Signals | null
  error?: string
}

function run(request: unknown, env: NodeJS.ProcessEnv): Result {
  const result = spawnSync(testBinary, [], { input: JSON.stringify(request), timeout: 30_000, env })
  let diagnostic: string | undefined
  if (result.signal && process.env['GITHUB_ACTIONS'] === 'true') {
    // A hosted crash must keep failing, with the native stack rather than a guessed cause.
    // This replays only the synthetic test request using the test build/fake authenticator.
    const dir = temporary('signer-crash-')
    const input = join(dir, 'request.json')
    writeFileSync(input, JSON.stringify(request))
    const debug = spawnSync('lldb', ['--batch', '-o', 'settings set target.disable-aslr false',
      '-o', `process launch --stdin ${JSON.stringify(input)}`, '-k', 'thread backtrace all', '--', testBinary],
    { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024 })
    diagnostic = `${debug.stdout ?? ''}\n${debug.stderr ?? ''}\n${debug.error?.message ?? ''}`
  }
  const parsed = (() => {
    try {
      return JSON.parse(result.stdout.toString('utf8').trim()) as Record<string, any>
    } catch {
      return null
    }
  })()
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json: parsed,
    signal: result.signal, error: result.error?.message ?? diagnostic }
}

function authLines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
}

/** The test build compiles the production branches out, so this scoped structural check proves
 * that the remaining production call sites still use the behaviourally tested shared builders. */
function functionBody(name: string): string {
  const text = readFileSync(source, 'utf8')
  const start = text.indexOf(`func ${name}(`)
  assert.notEqual(start, -1, `missing Swift function ${name}`)
  const end = text.indexOf('\nfunc ', start + 1)
  return text.slice(start, end === -1 ? undefined : end)
}

function productionBranch(name: string): string {
  const body = functionBody(name)
  const start = body.indexOf('#else')
  assert.notEqual(start, -1, `${name} has no production #else branch`)
  const end = body.indexOf('#endif', start)
  assert.notEqual(end, -1, `${name} production branch is unterminated`)
  return body.slice(start, end)
}

function approval(keyId: string, id = 'button') {
  return {
    schema: 'guanxi.ui-approval/3',
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

function initialise(fx: Fixture): Record<string, any> {
  const init = run({ op: 'init', service: SERVICE, account: ACCOUNT }, fx.env)
  assert.equal(init.status, 0, init.stderr.toString())
  assert.equal(init.json?.['ok'], true)
  return init.json!
}

function trusted(fx: Fixture): TrustedKey {
  return { ...fx.key.trusted, addedAt: '2026-10-20T00:00:00.000Z' }
}

describe('approval signer exit gates', { skip: swiftSkip }, () => {
  before(() => {
    const built = spawnSync('sh', [buildScript, '--test'], { cwd: repoRoot, encoding: 'utf8' })
    assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`)
    assert.ok(existsSync(testBinary))
  })

  it('never lets key bytes or the test item escape through stdout or stderr', async () => {
    const fx = fixture()
    const raw = readFileSync(fx.key.rawPath)
    const outputs: Buffer[] = []
    const requests: unknown[] = [
      { op: 'status', service: SERVICE, account: ACCOUNT },
      { op: 'init', service: SERVICE, account: ACCOUNT },
    ]
    const status = run(requests[0], fx.env)
    outputs.push(status.stdout, status.stderr)
    const init = run(requests[1], fx.env)
    outputs.push(init.stdout, init.stderr)
    const keyId = init.json!['keyId'] as string
    for (let index = 0; index < 3; index += 1) {
      const signed = run({ op: 'sign', service: SERVICE, account: ACCOUNT, payload: canonicalJson(approval(keyId, index === 0 ? 'button' : `component-${index}`)) }, fx.env)
      assert.equal(signed.status, 0, signed.stderr.toString())
      outputs.push(signed.stdout, signed.stderr)
    }
    const item = readFileSync(fx.itemPath)
    const forms = [
      raw.toString('base64'),
      raw.toString('base64url'),
      raw.toString('hex'),
      raw.toString('hex').toUpperCase(),
      raw.toString('latin1'),
    ]
    for (const output of outputs) {
      const text = output.toString('utf8')
      assert.equal(output.includes(raw), false, 'raw key bytes appeared in helper output')
      for (const form of forms) assert.equal(text.includes(form), false, `key form ${form.slice(0, 8)}… appeared in helper output`)
      assert.equal(output.includes(item), false, 'the test item contents appeared in helper output')
    }

    const signer = helperSigner({ helperPath: testBinary, service: SERVICE, account: ACCOUNT, timeoutMs: 30_000, env: fx.env })
    const nodeStatus = await signer.status()
    assert.deepEqual(Object.keys(nodeStatus).sort(), ['keyId', 'publicKey', 'state'])
    const signed = await signer.sign(Buffer.from(canonicalJson(approval(keyId))))
    assert.deepEqual(Object.keys(signed).sort(), ['keyId', 'signature'])
  })

  it('names the component and the full source hash in the one prompt', () => {
    const fx = fixture()
    const init = initialise(fx)
    const payload = canonicalJson(approval(init['keyId'] as string))
    const signed = run({ op: 'sign', service: SERVICE, account: ACCOUNT, payload }, fx.env)
    assert.equal(signed.status, 0)
    assert.deepEqual(authLines(fx.authLog), [`approve the "button" component, source sha256:${'a'.repeat(64)}`])
  })

  it('requires one confirmation per signature and none for a denial', () => {
    const fx = fixture()
    const init = initialise(fx)
    const payload = canonicalJson(approval(init['keyId'] as string))
    for (let index = 0; index < 3; index += 1) {
      const signed = run({ op: 'sign', service: SERVICE, account: ACCOUNT, payload }, fx.env)
      assert.equal(signed.status, 0)
      assert.equal(typeof signed.json?.['signature'], 'string')
    }
    assert.equal(authLines(fx.authLog).length, 3)

    const denied = run({ op: 'sign', service: SERVICE, account: ACCOUNT, payload }, { ...fx.env, SIGNER_TEST_AUTH_DENY: '1' })
    assert.equal(denied.status, 1)
    assert.equal(denied.json?.['ok'], false)
    assert.equal(denied.json?.['code'], 'signing_denied')
    assert.equal(denied.json?.['signature'], undefined)
    assert.equal(authLines(fx.authLog).length, 4)
  })

  it('wires the production access-control and confirmation policy through the shared builders', () => {
    const fx = fixture()
    const payload = canonicalJson(approval(fx.key.trusted.keyId))
    const reason = `approve the "button" component, source sha256:${'a'.repeat(64)}`
    const probe = run({ op: 'test-policy', service: SERVICE, account: ACCOUNT, payload }, fx.env)
    assert.equal(probe.status, 0, JSON.stringify({ signal: probe.signal, error: probe.error, stderr: probe.stderr.toString() }))
    assert.equal(probe.json?.['signature'], undefined, 'the policy probe must not sign')
    assert.deepEqual(probe.json, {
      ok: true,
      accessControlCalls: 1,
      accessControlCreated: true,
      accessibilityDeviceOnly: true,
      privateKeyUsage: true,
      userPresence: true,
      contextFactoryCalls: 2,
      contextsAreFreshInstances: true,
      contextsAreFactoryResults: true,
      confirmationReuseDurations: [0, 0],
      localizedReasons: [reason, reason],
    })
    assert.equal(authLines(fx.authLog).length, 0, 'the policy probe must not prompt')
  })

  it('keeps production init on the shared access-control builder', () => {
    const accessControlBuilder = functionBody('makeApprovalAccessControl')
    assert.match(accessControlBuilder, /create:\s*AccessControlFactory\s*=\s*SecAccessControlCreateWithFlags/)

    const initProduction = productionBranch('operationInit')
    assert.match(initProduction, /let accessControl = try makeApprovalAccessControl\(\)/)
    assert.doesNotMatch(initProduction, /SecAccessControlCreateWithFlags\s*\(/)
  })

  it('keeps production sign on the shared confirmation-context builder', () => {
    const contextBuilder = functionBody('makeConfirmationContext')
    assert.match(contextBuilder, /contextFactory:\s*ConfirmationContextFactory\s*=\s*productionConfirmationContext/)
    assert.match(functionBody('productionConfirmationContext'), /LAContext\(\)/)

    const signProduction = productionBranch('operationSign')
    assert.match(signProduction, /let context = makeConfirmationContext\(reason: reason\)/)
    assert.doesNotMatch(signProduction, /LAContext\s*\(/)
  })

  it('refuses non-canonical payloads, the removed /2 schema and invalid ids', () => {
    const fx = fixture()
    const init = initialise(fx)
    const payload = approval(init['keyId'] as string)
    const cases: Array<[string, string]> = [
      [JSON.stringify(payload, null, 2), 'payload_not_canonical'],
      [canonicalJson({ ...payload, schema: 'guanxi.ui-approval/2' }), 'payload_schema'],
      [canonicalJson({ ...payload, id: 'Button' }), 'payload_id'],
      [canonicalJson({ ...payload, id: 'button-' }), 'payload_id'],
    ]
    for (const [text, code] of cases) {
      const refused = run({ op: 'sign', service: SERVICE, account: ACCOUNT, payload: text }, fx.env)
      assert.equal(refused.status, 1, code)
      assert.equal(refused.json?.['ok'], false, code)
      assert.equal(refused.json?.['code'], code)
      assert.equal(refused.json?.['signature'], undefined)
    }
    assert.equal(authLines(fx.authLog).length, 0)
  })

  it('verifies a helper signature and G12 accepts only a trusted key', async () => {
    const fx = fixture()
    const init = initialise(fx)
    const helperKey = trusted(fx)
    assert.equal(helperKey.keyId, init['keyId'])
    const nodeKey = createPublicKey({ key: Buffer.from(init['publicKey'] as string, 'base64'), format: 'der', type: 'spki' })
    assert.equal(nodeKey.asymmetricKeyType, 'ec')

    const scratch = createScratch(repoRoot)
    try {
      const paths = uiPaths(scratch.uiRoot)
      const unsigned = {
        at: '2026-10-20T12:00:00.000Z',
        sourceHash: componentSourceHash(paths.componentDir('button')),
        snapshotHashes: componentSnapshotHashes(paths.snapshots, 'button'),
        comment: 'Signed by the helper.',
        keyId: helperKey.keyId,
        previous: null,
      }
      const signed = run(
        { op: 'sign', service: SERVICE, account: ACCOUNT, payload: canonicalJson(approvalPayload('button', unsigned)) },
        fx.env,
      )
      assert.equal(signed.status, 0, signed.stderr.toString())
      const draft = JSON.parse(readFileSync(paths.reviewFile('button'), 'utf8')) as ReviewRecord
      const record: ReviewRecord = {
        ...draft,
        status: 'approved',
        approval: { ...unsigned, signature: signed.json!['signature'] as string },
      }
      assert.deepEqual(verifyRecordApproval(record, [helperKey]), { state: 'valid', keyId: helperKey.keyId })
      writeFileSync(paths.trustedKeys, `${JSON.stringify({ version: 1, keys: [helperKey], rotation: null }, null, 2)}\n`)
      writeFileSync(paths.reviewFile('button'), serialiseRecord(record))
      const accepted = await g12.run({
        repoRoot: scratch.repoRoot,
        uiRoot: scratch.uiRoot,
        usageScope: defaultUsageScope(scratch.repoRoot),
        release: false,
        base: null,
      })
      assert.equal(accepted.status, 'pass', accepted.findings.map((finding) => finding.message).join('\n'))

      const other = p256TestKey('untrusted P-256 key')
      try {
        const otherUnsigned = { ...unsigned, keyId: other.trusted.keyId }
        const otherSignature = other.sign(Buffer.from(canonicalJson(approvalPayload('button', otherUnsigned)), 'utf8'))
        writeFileSync(
          paths.reviewFile('button'),
          serialiseRecord({ ...record, approval: { ...otherUnsigned, signature: otherSignature } }),
        )
        const rejected = await g12.run({
          repoRoot: scratch.repoRoot,
          uiRoot: scratch.uiRoot,
          usageScope: defaultUsageScope(scratch.repoRoot),
          release: false,
          base: null,
        })
        assert.equal(rejected.status, 'fail')
        assert.match(rejected.findings.map((finding) => finding.message).join('\n'), /approval is invalid: untrusted_key/)
      } finally {
        other.dispose()
      }
    } finally {
      scratch.dispose()
    }
  })

  it('fails the production hook check when a test build leaks SIGNER_TEST_', () => {
    const production = spawnSync('sh', [buildScript], { cwd: repoRoot, encoding: 'utf8' })
    assert.equal(production.status, 0, production.stderr)
    const checkProduction = spawnSync('sh', [buildScript, '--check', productionBinary], { encoding: 'utf8' })
    assert.equal(checkProduction.status, 0, checkProduction.stderr)

    const leaked = join(temporary('guanxi-leaked-helper-'), 'approval-signer')
    const built = spawnSync(
      'swiftc',
      ['-O', '-module-cache-path', moduleCache, '-D', 'GUANXI_SIGNER_TESTING', source, '-o', leaked],
      { encoding: 'utf8' },
    )
    assert.equal(built.status, 0, built.stderr)
    const checkLeak = spawnSync('sh', [buildScript, '--check', leaked], { encoding: 'utf8' })
    assert.notEqual(checkLeak.status, 0)
    assert.match(checkLeak.stderr, /contains test hooks \(SIGNER_TEST_\)/)
    assert.equal(spawnSync('strings', [leaked], { encoding: 'utf8' }).stdout.includes('SIGNER_TEST_'), true)

    const productionStrings = spawnSync('strings', [productionBinary], { encoding: 'utf8' }).stdout
    assert.equal(productionStrings.includes('test-policy'), false, 'production must not contain the test-only probe')
    const testStrings = spawnSync('strings', [testBinary], { encoding: 'utf8' }).stdout
    assert.equal(testStrings.includes('test-policy'), true, 'the test build must contain the probe')
  })

  it(
    'trusts only the helper path in a throwaway keychain access list',
    { skip: keychainSkip },
    (t) => {
      const dir = temporary('guanxi-signer-keychain-')
      const keychain = join(dir, 'approval-test.keychain-db')
      const before = spawnSync('security', ['list-keychains', '-d', 'user'], { encoding: 'utf8' })
      const created = spawnSync('security', ['create-keychain', '-p', 'test', keychain], { encoding: 'utf8' })
      if (created.status !== 0) {
        t.skip(`security create-keychain failed: ${created.stderr.trim()}`)
        return
      }
      try {
        const unlocked = spawnSync('security', ['unlock-keychain', '-p', 'test', keychain], { encoding: 'utf8' })
        if (unlocked.status !== 0) {
          t.skip(`security unlock-keychain failed: ${unlocked.stderr.trim()}`)
          return
        }
        const fx = fixture()
        const init = run({ op: 'init', service: SERVICE, account: ACCOUNT, keychain }, fx.env)
        if (init.status !== 0) {
          t.skip(`the keychain daemon is unusable here: ${init.json?.['code'] ?? 'unknown'}: ${init.json?.['message'] ?? init.stderr.toString().trim()}`)
          return
        }
        assert.equal(init.json?.['ok'], true)
        const status = run({ op: 'status', service: SERVICE, account: ACCOUNT, keychain }, fx.env)
        assert.equal(status.status, 0)
        assert.equal(status.json?.['state'], 'available')
        assert.equal(status.json?.['keyId'], init.json?.['keyId'])

        const dump = spawnSync('security', ['dump-keychain', '-a', keychain], { encoding: 'utf8' })
        assert.equal(dump.status, 0, dump.stderr)
        const applications = dump.stdout
          .split('\n')
          .map((line) => /^\s+\d+:\s+(\/.+?)(?:\s+\(OK\))?\s*$/.exec(line)?.[1])
          .filter((path): path is string => typeof path === 'string')
        assert.equal(applications.length, 1, dump.stdout)
        assert.ok([testBinary, realpathSync(testBinary)].includes(applications[0]!), applications[0])
        assert.equal(dump.stdout.includes('applications (1)'), true)
      } finally {
        spawnSync('security', ['delete-keychain', keychain])
        rmSync(dir, { recursive: true, force: true })
        const afterList = spawnSync('security', ['list-keychains', '-d', 'user'], { encoding: 'utf8' })
        assert.equal(afterList.stdout, before.stdout, 'the throwaway keychain must never join the search list')
      }
    },
  )
})
