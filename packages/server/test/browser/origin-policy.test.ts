import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decide, normalizeOrigin } from '../../src/browser/origin-policy.ts'
import type { BrowserAction, RunBrowserPolicy } from '../../src/browser/types.ts'

const READ = 'https://read.example'
const OTHER = 'https://other.example'
const WRITE = 'https://write.example'

function fullPolicy(overrides: Partial<RunBrowserPolicy> = {}): RunBrowserPolicy {
  return { mode: 'full', readable: [READ, OTHER], writable: [WRITE], ...overrides }
}

function navigate(
  url: string,
  via: 'policy' | 'clean_link' | 'model',
  fromOrigin?: string,
): BrowserAction {
  return fromOrigin === undefined
    ? { kind: 'navigate', url, via }
    : { kind: 'navigate', url, via, fromOrigin }
}

const INTERACTIONS = ['type', 'submit', 'upload', 'download'] as const

test('normalizeOrigin lowercases the host, drops default ports and trailing dots', () => {
  assert.equal(normalizeOrigin('HTTPS://Example.COM:443/a?b#c'), 'https://example.com')
  assert.equal(normalizeOrigin('http://Example.COM:80'), 'http://example.com')
  assert.equal(normalizeOrigin('http://example.com:8080/x'), 'http://example.com:8080')
  assert.equal(normalizeOrigin('https://example.com./path'), 'https://example.com')
  assert.equal(normalizeOrigin('https://example.com.:8443/path'), 'https://example.com:8443')
  assert.equal(normalizeOrigin('https://user:pass@example.com/x'), 'https://example.com')
  assert.equal(normalizeOrigin('https://example.com'), 'https://example.com')
})

test('normalizeOrigin converts IDN to punycode and keeps bracketed IPv6', () => {
  assert.equal(normalizeOrigin('https://BÜCHER.Example/path'), 'https://xn--bcher-kva.example')
  assert.equal(normalizeOrigin('http://[::1]:8080/x'), 'http://[::1]:8080')
})

test('normalizeOrigin throws TypeError for every non-http(s) or unparseable value', () => {
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///etc/passwd',
    'blob:https://example.com/id',
    'ftp://example.com/x',
    '/relative',
    'not a url',
    'https://',
  ]) {
    assert.throws(() => normalizeOrigin(value), TypeError, value)
  }
})

test('navigate to an already-readable origin is allowed regardless of how it was produced', () => {
  assert.equal(decide(fullPolicy(), navigate(`${READ}/page?q=1#x`, 'policy')).allowed, true)
  assert.deepEqual(decide(fullPolicy(), navigate(`${READ}/page?q=1`, 'model')), {
    allowed: true,
    code: 'allowed',
  })
  assert.deepEqual(decide(fullPolicy(), navigate(`${READ}/page?q=1#x`, 'clean_link', OTHER)), {
    allowed: true,
    code: 'allowed',
  })
})

test('policy-named navigation is allowed only on a readable origin', () => {
  assert.deepEqual(decide(fullPolicy(), navigate(`${READ}/deep/path`, 'policy')), {
    allowed: true,
    code: 'allowed',
  })
  assert.deepEqual(decide(fullPolicy(), navigate('https://new.example/path', 'policy')), {
    allowed: false,
    code: 'origin_not_allowed',
  })
  // The policy is the authority even for a data-looking URL on a readable origin.
  assert.deepEqual(decide(fullPolicy(), navigate(`${READ}/x?q=${'a'.repeat(65)}`, 'policy')), {
    allowed: true,
    code: 'allowed',
  })
})

test('a clean link from a readable page adds exactly one readable origin', () => {
  const decision = decide(fullPolicy(), navigate('https://new.example/about', 'clean_link', READ))
  assert.deepEqual(decision, {
    allowed: true,
    code: 'allowed',
    addReadable: 'https://new.example',
  })

  const updated: RunBrowserPolicy = {
    ...fullPolicy(),
    readable: [...fullPolicy().readable, decision.addReadable!],
  }
  assert.deepEqual(decide(updated, { kind: 'type', origin: 'https://new.example' }), {
    allowed: false,
    code: 'write_not_allowed',
  })
})

test('a 200-character path of short segments is still a clean link', () => {
  const path = `/${'a/'.repeat(99)}a`
  assert.equal(path.length, 200)
  assert.deepEqual(decide(fullPolicy(), navigate(`https://new.example${path}`, 'clean_link', READ)), {
    allowed: true,
    code: 'allowed',
    addReadable: 'https://new.example',
  })
  // A 32-character segment is at the limit; 33 is data-carrying (tested below).
  assert.deepEqual(decide(fullPolicy(), navigate(`https://new.example/${'a'.repeat(32)}`, 'clean_link', READ)), {
    allowed: true,
    code: 'allowed',
    addReadable: 'https://new.example',
  })
})

test('clean links refuse queries, fragments, userinfo, long segments and long paths', () => {
  const cases: Array<[string, string]> = [
    ['query string', 'https://new.example/search?q=x'],
    ['empty query string', 'https://new.example/search?'],
    ['fragment', 'https://new.example/page#top'],
    ['empty fragment', 'https://new.example/page#'],
    ['userinfo', 'https://user@new.example/page'],
    ['long hex segment', `https://new.example/${'a1b2'.repeat(10)}`],
    ['long base64url segment', `https://new.example/${'A1b2_-'.repeat(7)}`],
    ['long plain word', `https://new.example/${'a'.repeat(33)}`],
    ['201-character path', `https://new.example/${'a/'.repeat(100)}`],
    ['encoded separator hiding data', `https://new.example/${'A'.repeat(40)}%2F${'B'.repeat(40)}`],
  ]
  for (const [name, url] of cases) {
    assert.deepEqual(
      decide(fullPolicy(), navigate(url, 'clean_link', READ)),
      { allowed: false, code: 'data_url_refused' },
      name,
    )
  }
})

test('a clean link needs a readable fromOrigin', () => {
  assert.deepEqual(decide(fullPolicy(), navigate('https://new.example/a', 'clean_link')), {
    allowed: false,
    code: 'origin_not_allowed',
  })
  assert.deepEqual(decide(fullPolicy(), navigate('https://new.example/a', 'clean_link', 'https://unknown.example')), {
    allowed: false,
    code: 'origin_not_allowed',
  })
  assert.deepEqual(decide(fullPolicy(), navigate('https://new.example/a', 'clean_link', 'javascript:alert(1)')), {
    allowed: false,
    code: 'origin_not_allowed',
  })
})

test('model navigation allows an already-readable origin unless the URL carries data', () => {
  assert.deepEqual(decide(fullPolicy(), navigate(`${READ}/docs/page`, 'model')), {
    allowed: true,
    code: 'allowed',
  })
  assert.deepEqual(decide(fullPolicy(), navigate(`${READ}/search?page=2`, 'model')), {
    allowed: true,
    code: 'allowed',
  })
})

test('model navigation refuses data on a readable origin', () => {
  const cases: Array<[string, string]> = [
    ['65-character query value', `${READ}/search?q=${'a'.repeat(65)}`],
    ['high-entropy query value', `${READ}/search?q=${'a1b2'.repeat(10)}`],
    ['long plain query value', `${READ}/search?q=${encodeURIComponent('long value '.repeat(7))}`],
    ['high-entropy path segment', `${READ}/${'A1b2_-'.repeat(7)}`],
    ['65-character query name', `${READ}/?${'a'.repeat(65)}=1`],
    ['high-entropy query name', `${READ}/?${'a1b2'.repeat(10)}=1`],
    ['plain path segment over 64', `${READ}/${'x'.repeat(65)}`],
    ['plus is literal base64', `${READ}/?q=${'A'.repeat(20)}+${'B'.repeat(20)}`],
    ['malformed percent is literal', `${READ}/?q=${'%'.repeat(70)}`],
    ['encoded separator hiding data', `${READ}/${'A'.repeat(40)}%2F${'B'.repeat(40)}`],
    ['userinfo', `https://user@read.example/page`],
  ]
  for (const [name, url] of cases) {
    assert.deepEqual(decide(fullPolicy(), navigate(url, 'model')), {
      allowed: false,
      code: 'data_url_refused',
    }, name)
  }
})

test('model navigation refuses cumulative, repeated and separator-hidden data', () => {
  const cases: Array<[string, string]> = [
    ['50 segments of 32 base64 characters', `${READ}/${Array.from({ length: 50 }, () => 'A'.repeat(32)).join('/')}`],
    ['50 repeated query parameters', `${READ}/?${Array.from({ length: 50 }, () => `a=${'A'.repeat(32)}`).join('&')}`],
    ['dot-separated data segment', `${READ}/ab.${'A'.repeat(60)}`],
    ['5000-character fragment', `${READ}/page#${'a'.repeat(5000)}`],
  ]
  for (const [name, url] of cases) {
    assert.deepEqual(decide(fullPolicy(), navigate(url, 'model')), {
      allowed: false,
      code: 'data_url_refused',
    }, name)
  }
})

test('model navigation still allows an ordinary documentation URL', () => {
  const policy = fullPolicy({ readable: ['https://docs.example.com'] })
  assert.deepEqual(decide(policy, navigate('https://docs.example.com/guide/install', 'model')), {
    allowed: true,
    code: 'allowed',
  })
})

test('model navigation to a non-readable origin is refused before its data shape matters', () => {
  const dataUrl = `https://new.example/?q=${'a'.repeat(65)}`
  assert.deepEqual(decide(fullPolicy(), navigate(dataUrl, 'model')), {
    allowed: false,
    code: 'origin_not_allowed',
  })
})

test('unknown action kinds are refused as invalid_action in every mode', () => {
  const policies: RunBrowserPolicy[] = [
    fullPolicy({ readable: [WRITE], writable: [WRITE] }),
    { mode: 'read_only', readable: [WRITE], writable: [] },
  ]
  for (const kind of ['evaluate', 'scroll']) {
    for (const policy of policies) {
      assert.deepEqual(decide(policy, { kind, origin: WRITE } as unknown as BrowserAction), {
        allowed: false,
        code: 'invalid_action',
      }, `${kind} in ${policy.mode}`)
    }
  }
})

test('read_only refuses type, submit, upload and download on every origin', () => {
  const policy: RunBrowserPolicy = { mode: 'read_only', readable: [READ, WRITE], writable: [WRITE] }
  for (const kind of INTERACTIONS) {
    for (const origin of [READ, WRITE, 'https://unknown.example']) {
      assert.deepEqual(decide(policy, { kind, origin }), { allowed: false, code: 'read_only' }, `${kind} on ${origin}`)
    }
  }
  // The ADR validation names form submission explicitly.
  assert.deepEqual(decide(policy, { kind: 'submit', origin: READ }), { allowed: false, code: 'read_only' })
  assert.deepEqual(decide(policy, { kind: 'click', origin: READ }), { allowed: true, code: 'allowed' })
  assert.deepEqual(decide(policy, { kind: 'click', origin: 'https://unknown.example' }), {
    allowed: false,
    code: 'origin_not_allowed',
  })
  assert.deepEqual(decide(policy, navigate(`${READ}/a`, 'policy')), { allowed: true, code: 'allowed' })
})

test('full mode requires writable for type, submit, upload and download', () => {
  const policy = fullPolicy({ readable: [READ, WRITE], writable: [WRITE] })
  for (const kind of INTERACTIONS) {
    assert.deepEqual(decide(policy, { kind, origin: WRITE }), { allowed: true, code: 'allowed' }, kind)
    assert.deepEqual(decide(policy, { kind, origin: READ }), { allowed: false, code: 'write_not_allowed' }, kind)
    assert.deepEqual(decide(policy, { kind, origin: 'https://unknown.example' }), {
      allowed: false,
      code: 'write_not_allowed',
    }, kind)
  }
  assert.deepEqual(decide(policy, { kind: 'click', origin: READ }), { allowed: true, code: 'allowed' })
  assert.deepEqual(decide(policy, { kind: 'click', origin: 'https://unknown.example' }), {
    allowed: false,
    code: 'origin_not_allowed',
  })
  const writeOnly: RunBrowserPolicy = { mode: 'full', readable: [], writable: [WRITE] }
  assert.deepEqual(decide(writeOnly, { kind: 'click', origin: WRITE }), {
    allowed: false,
    code: 'origin_not_allowed',
  })
})

test('action origins are normalized before comparison', () => {
  const policy = fullPolicy({ readable: [READ, WRITE], writable: [WRITE] })
  assert.deepEqual(decide(policy, { kind: 'type', origin: 'HTTPS://WRITE.EXAMPLE:443' }), {
    allowed: true,
    code: 'allowed',
  })
  assert.deepEqual(decide(policy, navigate('HTTPS://READ.EXAMPLE.:443/a', 'policy')), {
    allowed: true,
    code: 'allowed',
  })
})

test('javascript, data, file and blob schemes are always refused', () => {
  const schemes = [
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///etc/passwd',
    'blob:https://example.com/id',
  ]
  for (const value of schemes) {
    for (const via of ['policy', 'clean_link', 'model'] as const) {
      assert.deepEqual(decide(fullPolicy(), navigate(value, via, READ)), {
        allowed: false,
        code: 'scheme_refused',
      }, `${value} via ${via}`)
    }
    assert.deepEqual(decide(fullPolicy(), { kind: 'type', origin: value }), {
      allowed: false,
      code: 'scheme_refused',
    }, value)
  }
})

test('a missing or unknown via fails closed before any readable shortcut', () => {
  const missing = { kind: 'navigate', url: 'https://new.example/about', fromOrigin: READ } as unknown as BrowserAction
  assert.deepEqual(decide(fullPolicy(), missing), { allowed: false, code: 'invalid_action' })
  const missingWithData = {
    kind: 'navigate',
    url: `${READ}/?q=${'a'.repeat(65)}`,
  } as unknown as BrowserAction
  assert.deepEqual(decide(fullPolicy(), missingWithData), { allowed: false, code: 'invalid_action' })
  const unknown = {
    kind: 'navigate',
    url: 'https://new.example/about',
    via: 'bogus',
    fromOrigin: READ,
  } as unknown as BrowserAction
  assert.deepEqual(decide(fullPolicy(), unknown), { allowed: false, code: 'invalid_action' })
})

test('an unknown runtime policy mode fails closed as read_only', () => {
  const policy = { mode: 'readonly', readable: [WRITE], writable: [WRITE] } as unknown as RunBrowserPolicy
  assert.deepEqual(decide(policy, { kind: 'type', origin: WRITE }), { allowed: false, code: 'read_only' })
  assert.deepEqual(decide(policy, { kind: 'download', origin: WRITE }), { allowed: false, code: 'read_only' })
})

test('decisions are deterministic and never mutate the policy or action', () => {
  const policy: RunBrowserPolicy = {
    mode: 'full',
    readable: Object.freeze([READ]) as unknown as string[],
    writable: Object.freeze([WRITE]) as unknown as string[],
  }
  const action = Object.freeze({
    kind: 'navigate' as const,
    url: 'https://new.example/about',
    via: 'clean_link' as const,
    fromOrigin: READ,
  })
  const first = decide(policy, action)
  const second = decide(policy, action)
  assert.deepEqual(first, second)
  assert.deepEqual(policy.readable, [READ])
  assert.deepEqual(policy.writable, [WRITE])
  assert.equal(action.fromOrigin, READ)
})
