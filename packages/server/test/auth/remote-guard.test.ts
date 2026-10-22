import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertBindAllowed,
  RemoteBindError,
  type RemoteBindConfig,
  type RemoteBindRequirement,
} from '../../src/auth/remote-guard.ts'

const valid: RemoteBindConfig = {
  host: '0.0.0.0',
  tls: { certPath: '/etc/guanxi/tls/cert.pem', keyPath: '/etc/guanxi/tls/key.pem', hostname: 'guanxi.example' },
  accountsEnabled: true,
  allowedRoots: ['/srv/guanxi'],
  nodeCredentialConfigured: true,
}

function withoutProfile(host: string): RemoteBindConfig {
  return { ...valid, host, tls: null, accountsEnabled: false, allowedRoots: [], nodeCredentialConfigured: false }
}

function assertMissing(config: RemoteBindConfig, expected: RemoteBindRequirement[]): void {
  assert.throws(() => assertBindAllowed(config), (error: unknown) => {
    assert.ok(error instanceof RemoteBindError)
    assert.equal(error.code, 'remote_bind_forbidden')
    assert.equal(error.host, config.host)
    assert.deepEqual(error.missing, expected)
    for (const code of expected) assert.match(error.message, new RegExp(code, 'u'))
    assert.match(error.message, /refused/u)
    return true
  })
}

test('loopback hosts always pass, with or without the remote profile', () => {
  for (const host of ['127.0.0.1', '127.0.0.2', '127.255.255.254', '::1', '[::1]', 'localhost', 'LOCALHOST']) {
    assert.doesNotThrow(() => assertBindAllowed(withoutProfile(host)), host)
  }
})

test('non-loopback binds without a profile report every missing requirement', () => {
  const expected: RemoteBindRequirement[] = [
    'tls_required',
    'accounts_required',
    'allowed_roots_required',
    'node_credential_required',
  ]
  for (const host of ['0.0.0.0', '::', '192.168.1.20', 'node.lan', 'guanxi.example']) {
    assertMissing(withoutProfile(host), expected)
  }
})

test('each missing requirement is reported with its stable code', () => {
  const cases: Array<{ name: string; config: RemoteBindConfig; expected: RemoteBindRequirement[] }> = [
    { name: 'no TLS', config: { ...valid, tls: null }, expected: ['tls_required'] },
    {
      name: 'empty certificate path',
      config: { ...valid, tls: { certPath: '', keyPath: '/key.pem', hostname: 'guanxi.example' } },
      expected: ['tls_required'],
    },
    {
      name: 'empty key path',
      config: { ...valid, tls: { certPath: '/cert.pem', keyPath: '  ', hostname: 'guanxi.example' } },
      expected: ['tls_required'],
    },
    {
      name: 'no TLS hostname',
      config: { ...valid, tls: { certPath: '/cert.pem', keyPath: '/key.pem', hostname: '' } },
      expected: ['tls_hostname_required'],
    },
    {
      name: 'IPv4 TLS hostname',
      config: { ...valid, tls: { certPath: '/cert.pem', keyPath: '/key.pem', hostname: '10.0.0.5' } },
      expected: ['tls_hostname_ip_forbidden'],
    },
    {
      name: 'IPv6 TLS hostname',
      config: { ...valid, tls: { certPath: '/cert.pem', keyPath: '/key.pem', hostname: '[::1]' } },
      expected: ['tls_hostname_ip_forbidden'],
    },
    { name: 'accounts disabled', config: { ...valid, accountsEnabled: false }, expected: ['accounts_required'] },
    { name: 'no allowed roots', config: { ...valid, allowedRoots: [] }, expected: ['allowed_roots_required'] },
    {
      name: 'relative allowed root',
      config: { ...valid, allowedRoots: ['srv/guanxi'] },
      expected: ['allowed_roots_must_be_absolute'],
    },
    {
      name: 'empty allowed root',
      config: { ...valid, allowedRoots: [''] },
      expected: ['allowed_roots_must_be_absolute'],
    },
    {
      name: 'duplicate allowed root',
      config: { ...valid, allowedRoots: ['/srv/guanxi', '/srv/guanxi'] },
      expected: ['allowed_roots_duplicate'],
    },
    {
      name: 'duplicate allowed root after normalization',
      config: { ...valid, allowedRoots: ['/srv/guanxi', '/srv/guanxi/'] },
      expected: ['allowed_roots_duplicate'],
    },
    {
      name: 'no node credential',
      config: { ...valid, nodeCredentialConfigured: false },
      expected: ['node_credential_required'],
    },
  ]

  for (const entry of cases) assertMissing(entry.config, entry.expected)
})

test('multiple violations are listed together rather than stopping at the first', () => {
  assertMissing({
    ...valid,
    tls: { certPath: '/cert.pem', keyPath: '/key.pem', hostname: '192.168.1.1' },
    accountsEnabled: false,
    allowedRoots: ['relative', 'relative'],
    nodeCredentialConfigured: false,
  }, [
    'tls_hostname_ip_forbidden',
    'accounts_required',
    'allowed_roots_must_be_absolute',
    'allowed_roots_duplicate',
    'node_credential_required',
  ])
})

test('IP TLS hostnames are rejected explicitly', () => {
  for (const hostname of ['10.0.0.1', '127.0.0.1', '192.168.0.1', '::1', '[::1]', '2001:db8::1']) {
    assertMissing(
      { ...valid, tls: { certPath: '/cert.pem', keyPath: '/key.pem', hostname } },
      ['tls_hostname_ip_forbidden'],
    )
  }
})

test('TLS hostnames must be canonical RFC 1123 names', () => {
  const invalid = [
    'localhost',
    'LOCALHOST',
    '1.2.3.4.',
    '127.0.0.1.',
    '0x7f000001',
    '2130706433',
    '127.1',
    '0177.0.0.1',
    'example.123',
    'h:443',
    'a b',
    '-a.example',
    'a-.example',
    'a..b',
    '.example',
    'example.',
    'under_score.example',
    'exa:mple',
    `${'a'.repeat(64)}.example`,
    `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.example`,
  ]
  for (const hostname of invalid) {
    assertMissing(
      { ...valid, tls: { certPath: '/cert.pem', keyPath: '/key.pem', hostname } },
      ['tls_hostname_invalid'],
    )
  }
})

test('canonical RFC 1123 TLS hostnames are accepted', () => {
  for (const hostname of [
    'guanxi.example',
    'node.lan',
    'a-b.example',
    'sub.node-1.example',
    '123.example',
    'xn--bcher-kva.example',
    `${'a'.repeat(63)}.example`,
  ]) {
    assert.doesNotThrow(
      () => assertBindAllowed({ ...valid, tls: { certPath: '/cert.pem', keyPath: '/key.pem', hostname } }),
      hostname,
    )
  }
})

test('a complete remote profile passes for wildcard, LAN and hostname binds', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.20', 'node.lan', 'guanxi.example']) {
    assert.doesNotThrow(() => assertBindAllowed({ ...valid, host }), host)
  }
})

test('lookalike loopback names are not treated as loopback', () => {
  for (const host of ['127.0.0.1.example', 'localhost.', '::2', '128.0.0.1', ' 127.0.0.1', '[localhost]', '[127.0.0.1]']) {
    assertMissing(withoutProfile(host), [
      'tls_required',
      'accounts_required',
      'allowed_roots_required',
      'node_credential_required',
    ])
  }
})
