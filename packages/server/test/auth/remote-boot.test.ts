import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { start } from '../../src/index.ts'
import { ROUTE_POLICIES } from '../../src/auth/route-policy.ts'
import { RemoteBindError, type RemoteBindRequirement } from '../../src/auth/remote-guard.ts'
import { REMOTE_BIND_EXIT_CODE, remoteBindRefusalMessage } from '../../src/auth/remote-profile.ts'
import type { AccountsAdapter } from '../../src/auth/route-authz.ts'
import type { Principal } from '../../src/auth/types.ts'
import { identity } from '../federation/harness.ts'
import { TLS_TEST_HOSTNAME, httpsGet, makeTlsFixture, type TlsFixture } from './tls-fixture.ts'

const SERVER_BIN = fileURLToPath(new URL('../../src/bin.ts', import.meta.url))
const CLI_BIN = fileURLToPath(new URL('../../../cli/src/bin.ts', import.meta.url))
const GUARD = fileURLToPath(new URL('../setup/no-ambient-key-file.mjs', import.meta.url))

const OWNER: Principal = { kind: 'user', userId: 'owner-1', role: 'member', groups: [] }
const STRANGER: Principal = { kind: 'user', userId: 'stranger-1', role: 'member', groups: [] }
const ADMIN: Principal = { kind: 'user', userId: 'admin-1', role: 'admin', groups: [] }

/** Principals by the `x-user` header; the stand-in for what Better Auth supplies in the next slice. */
const accounts: AccountsAdapter = {
  nodeOwnerId: 'owner-1',
  principal: (context) => {
    const user = context.req.header('x-user')
    return user === 'owner' ? OWNER : user === 'stranger' ? STRANGER : user === 'admin' ? ADMIN : { kind: 'anonymous' }
  },
}

function nodeCredential() {
  const { identity: node, privateKey } = identity('remote-boot-node')
  return { identity: node, privateKey }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
}

async function portAccepts(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

/** The error a refused `start()` raises. A boot that wrongly succeeds is closed first, so a regression fails instead of hanging. */
async function refusal(options: Parameters<typeof start>[0]): Promise<RemoteBindError> {
  const outcome = await start(options).then((server) => ({ server }), (error: unknown) => ({ error }))
  if ('server' in outcome) {
    await outcome.server.close()
    assert.fail('start() must refuse this bind')
  }
  assert.ok(outcome.error instanceof RemoteBindError, String(outcome.error))
  return outcome.error
}

interface ProcessResult { code: number | null; stdout: string; stderr: string }

async function run(file: string, args: string[], env: Record<string, string>): Promise<ProcessResult> {
  const child = spawn(process.execPath, ['--import', GUARD, file, ...args], {
    env: { ...process.env, GUANXI_MS1_LIVE_CONFIG: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve))
  clearTimeout(timer)
  return { code, stdout, stderr }
}

function plainGet(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
    req.once('error', reject)
    req.end()
  })
}

describe('remote bind refusal at boot', () => {
  let root: string
  before(() => { root = mkdtempSync(join(tmpdir(), 'guanxi-remote-boot-')) })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  const noProfile: RemoteBindRequirement[] = ['tls_required', 'accounts_required', 'allowed_roots_required', 'node_credential_required']

  for (const host of ['0.0.0.0', '::', '192.168.1.20', 'node.example.test']) {
    it(`start() refuses ${host} without the profile and creates nothing`, { timeout: 30_000 }, async () => {
      const dataDir = join(root, `data-${host.replace(/[^a-z0-9]/gu, '_')}`)
      const error = await refusal({ port: 0, host, dataDir, webDir: root, devOrigins: [] })
      assert.equal(error.code, 'remote_bind_forbidden')
      assert.equal(error.host, host)
      assert.deepEqual(error.missing, noProfile)
      assert.equal(existsSync(dataDir), false, 'a refused bind must not create the data directory')
    })
  }

  it('reports each unmet part of a partial profile', { timeout: 30_000 }, async () => {
    const fixture = makeTlsFixture()
    try {
      const error = await refusal({
        port: 0, host: '0.0.0.0', dataDir: join(root, 'partial'), webDir: root, devOrigins: [],
        remote: { tls: { certPath: fixture.certPath, keyPath: fixture.keyPath, hostname: '10.0.0.5' }, allowedRoots: [], accounts },
      })
      assert.deepEqual(error.missing, ['tls_hostname_ip_forbidden', 'allowed_roots_required', 'node_credential_required'])
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses an unreadable TLS pair even on loopback, and names it', { timeout: 30_000 }, async () => {
    const error = await refusal({
      port: 0, host: '127.0.0.1', dataDir: join(root, 'unreadable'), webDir: root, devOrigins: [],
      federation: nodeCredential(),
      remote: { tls: { certPath: join(root, 'missing-cert.pem'), keyPath: join(root, 'missing-key.pem'), hostname: TLS_TEST_HOSTNAME }, allowedRoots: [join(root, 'srv')], accounts },
    })
    assert.deepEqual(error.missing, ['tls_files_unreadable'])
  })

  it('refuses accounts that cannot authenticate and a federation option without a private key', { timeout: 30_000 }, async () => {
    const fixture = makeTlsFixture()
    try {
      const tls = { certPath: fixture.certPath, keyPath: fixture.keyPath, hostname: TLS_TEST_HOSTNAME }
      const noAuth = { nodeOwnerId: 'owner-1' } as unknown as AccountsAdapter
      const noAccounts = await refusal({ port: 0, host: '0.0.0.0', dataDir: join(root, 'noauth'), webDir: root, devOrigins: [], federation: nodeCredential(), remote: { tls, allowedRoots: [join(root, 'srv')], accounts: noAuth } })
      assert.deepEqual(noAccounts.missing, ['accounts_required'])
      const noKey = await refusal({ port: 0, host: '0.0.0.0', dataDir: join(root, 'nokey'), webDir: root, devOrigins: [], federation: { ...nodeCredential(), privateKey: '' }, remote: { tls, allowedRoots: [join(root, 'srv')], accounts } })
      assert.deepEqual(noKey.missing, ['node_credential_required'])
    } finally {
      fixture.cleanup()
    }
  })

  it('the real server entry point exits 78 with one message and binds nothing', { timeout: 60_000 }, async () => {
    const port = await freePort()
    const dataDir = join(root, 'bin-data')
    const result = await run(SERVER_BIN, [], { HOST: '0.0.0.0', GUANXI_API_PORT: String(port), GUANXI_DATA_DIR: dataDir })
    assert.equal(result.code, REMOTE_BIND_EXIT_CODE)
    assert.equal(REMOTE_BIND_EXIT_CODE, 78)
    const expected = remoteBindRefusalMessage(new RemoteBindError('0.0.0.0', noProfile))
    assert.equal(result.stderr.trim(), expected)
    assert.match(result.stderr, /refusing to listen on 0\.0\.0\.0/u)
    assert.equal(result.stderr.trim().split('\n').length, 1, 'one line, no stack')
    assert.equal(result.stdout, '')
    assert.equal(existsSync(dataDir), false)
    assert.equal(await portAccepts(port), false)
  })

  it('the CLI entry point exits 78 with the same message and binds nothing', { timeout: 60_000 }, async () => {
    const port = await freePort()
    const dataDir = join(root, 'cli-data')
    const result = await run(CLI_BIN, ['--host', '0.0.0.0', '--port', String(port), '--data-dir', dataDir, '--no-open'], {})
    assert.equal(result.code, REMOTE_BIND_EXIT_CODE)
    assert.equal(result.stderr.trim(), remoteBindRefusalMessage(new RemoteBindError('0.0.0.0', noProfile)))
    assert.equal(existsSync(dataDir), false)
    assert.equal(await portAccepts(port), false)
  })

  it('the real server entry point still boots on loopback', { timeout: 60_000 }, async () => {
    const port = await freePort()
    const dataDir = join(root, 'bin-loopback')
    const child = spawn(process.execPath, ['--import', GUARD, SERVER_BIN], {
      env: { ...process.env, GUANXI_MS1_LIVE_CONFIG: '', HOST: '127.0.0.1', GUANXI_API_PORT: String(port), GUANXI_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      const listening = await new Promise<boolean>((resolve) => {
        child.stdout.on('data', (chunk: Buffer) => { if (chunk.toString().includes(`http://127.0.0.1:${port}`)) resolve(true) })
        child.once('close', () => resolve(false))
      })
      assert.equal(listening, true)
      assert.equal(await plainGet(port, '/api/health'), 200)
    } finally {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('close', resolve))
    }
  })
})

describe('remote bind acceptance with the full profile', () => {
  let root: string
  let tls: TlsFixture
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'guanxi-remote-ok-'))
    tls = makeTlsFixture()
  })
  after(() => {
    tls.cleanup()
    rmSync(root, { recursive: true, force: true })
  })

  it('listens on all interfaces over HTTPS only and enforces the principal', { timeout: 60_000 }, async () => {
    const dataDir = join(root, 'data')
    const server = await start({
      port: 0, host: '0.0.0.0', dataDir, webDir: root, devOrigins: [],
      federation: nodeCredential(),
      remote: { tls: { certPath: tls.certPath, keyPath: tls.keyPath, hostname: TLS_TEST_HOSTNAME.toUpperCase() }, allowedRoots: [join(root, 'srv')], accounts },
    })
    try {
      assert.equal(server.url, `https://${TLS_TEST_HOSTNAME}:${server.port}`)
      const host = { host: `${TLS_TEST_HOSTNAME}:${server.port}` }
      // Plain HTTP to the TLS port gets no application answer.
      await assert.rejects(plainGet(server.port, '/api/health'))

      const anonymous = await httpsGet(server.port, '/api/health', host)
      assert.equal(anonymous.status, 401)
      assert.equal((JSON.parse(anonymous.body) as { code: string }).code, 'unauthenticated')

      assert.equal((await httpsGet(server.port, '/api/health', { ...host, 'x-user': 'stranger' })).status, 200)
      assert.equal((await httpsGet(server.port, '/api/settings', { ...host, 'x-user': 'stranger' })).status, 403)
      assert.equal((await httpsGet(server.port, '/api/threads', { ...host, 'x-user': 'stranger' })).status, 403)
      assert.equal((await httpsGet(server.port, '/api/settings', { ...host, 'x-user': 'owner' })).status, 200)
      assert.equal((await httpsGet(server.port, '/api/threads', { ...host, 'x-user': 'owner' })).status, 200)

      // The admin role administers the node but is not the owner: no settings, no filesystem browser.
      assert.equal((await httpsGet(server.port, '/api/settings', { ...host, 'x-user': 'admin' })).status, 403)
      assert.equal((await httpsGet(server.port, '/api/workspaces/browse?path=/', { ...host, 'x-user': 'admin' })).status, 403)
      assert.equal((await httpsGet(server.port, '/api/threads', { ...host, 'x-user': 'admin' })).status, 403)

      // Health detail (hardware, Ollama) is for the owner and the admin role; any other user gets liveness.
      const memberHealth = await httpsGet(server.port, '/api/health', { ...host, 'x-user': 'stranger' })
      assert.deepEqual(JSON.parse(memberHealth.body), { ok: true })
      for (const user of ['owner', 'admin']) {
        const detail = JSON.parse((await httpsGet(server.port, '/api/health', { ...host, 'x-user': user })).body) as Record<string, unknown>
        assert.ok('hardware' in detail && 'ollama' in detail && 'appVersion' in detail, `${user} sees the full report`)
      }

      // The signed node API is authenticated by its own signature, not by a user principal.
      const unsigned = await httpsGet(server.port, '/api/federation/handshake', host)
      assert.equal(unsigned.status, 401)
      assert.equal('message' in (JSON.parse(unsigned.body) as object), false, 'answered by the federation handler')

      // Another authority is not this node.
      assert.equal((await httpsGet(server.port, '/api/health', { host: 'evil.example:1', 'x-user': 'owner' })).status, 403)
    } finally {
      await server.close()
    }
    assert.ok(readdirSync(dataDir).length > 0)
  })

  it('H1: HEAD and unknown methods get the same decision as GET on every route of the real server', { timeout: 120_000 }, async () => {
    const server = await start({
      port: 0, host: '127.0.0.1', dataDir: join(root, 'data-head'), webDir: root, devOrigins: [],
      federation: nodeCredential(),
      remote: { tls: { certPath: tls.certPath, keyPath: tls.keyPath, hostname: TLS_TEST_HOSTNAME }, allowedRoots: [join(root, 'srv')], accounts },
    })
    try {
      const origin = `https://${TLS_TEST_HOSTNAME}:${server.port}`
      const probe = async (method: string, path: string, user?: string) =>
        (await server.app.request(`${origin}${path}`, { method, headers: user ? { 'x-user': user } : {} })).status
      const concrete = (pattern: string) => pattern.replace(/:\w+(\{[^}]*\})?/gu, 'r1')
      let swept = 0
      for (const [key, policy] of ROUTE_POLICIES) {
        if (!key.startsWith('GET ')) continue
        const path = concrete(key.slice(4))
        for (const user of [undefined, 'stranger']) {
          const get = await probe('GET', path, user)
          const head = await probe('HEAD', path, user)
          assert.equal(head, get, `HEAD ${path} as ${user ?? 'anonymous'}`)
          if (user === undefined && policy.kind !== 'public' && policy.kind !== 'node-signed') {
            assert.equal(head, 401, `anonymous HEAD ${path}`)
          }
        }
        swept++
      }
      assert.ok(swept >= 60, `only ${swept} GET rows swept`)
      // Unknown methods and OPTIONS run no handler and reveal nothing.
      for (const method of ['OPTIONS', 'PURGE']) {
        assert.equal(await probe(method, '/api/settings'), 404, method)
        assert.equal(await probe(method, '/api/workspaces/browse?path=/etc'), 404, method)
      }
      // The reviewer's oracle: an unauthenticated HEAD must not tell /etc from a missing path.
      assert.equal(await probe('HEAD', '/api/workspaces/browse?path=/etc'), 401)
      assert.equal(await probe('HEAD', '/api/workspaces/browse?path=/nonexistent-guanxi-path'), 401)
    } finally {
      await server.close()
    }
  })

  it('a loopback bind with a profile also serves HTTPS with accounts, not the implicit owner', { timeout: 60_000 }, async () => {
    const server = await start({
      port: 0, host: '127.0.0.1', dataDir: join(root, 'data-loopback'), webDir: root, devOrigins: [],
      federation: nodeCredential(),
      remote: { tls: { certPath: tls.certPath, keyPath: tls.keyPath, hostname: TLS_TEST_HOSTNAME }, allowedRoots: [join(root, 'srv')], accounts },
    })
    try {
      assert.equal((await httpsGet(server.port, '/api/health', { host: `127.0.0.1:${server.port}` })).status, 401)
    } finally {
      await server.close()
    }
  })
})
