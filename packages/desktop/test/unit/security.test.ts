import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SECURE_WEB_PREFERENCES,
  allowPermission,
  allowRequest,
  contentSecurityPolicy,
  decideNavigation,
  decideWindowOpen,
  isExternallyOpenable,
  isSameOrigin,
} from '../../src/security.ts'

const origin = 'http://127.0.0.1:4441'

describe('SECURE_WEB_PREFERENCES', () => {
  it('is the exact hardened set', () => {
    assert.deepEqual({ ...SECURE_WEB_PREFERENCES }, {
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false,
      nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, allowRunningInsecureContent: false, safeDialogs: true,
    })
    assert.ok(Object.isFrozen(SECURE_WEB_PREFERENCES))
  })
})

describe('origin and scheme checks', () => {
  it('isSameOrigin compares scheme, host and port exactly', () => {
    assert.equal(isSameOrigin('http://127.0.0.1:4441/a?b#c', origin), true)
    for (const other of ['http://127.0.0.1:4442/', 'https://127.0.0.1:4441/', 'http://localhost:4441/', 'http://127.0.0.1.evil.test:4441/', 'http://127.0.0.1:4441@evil.test/', 'not a url', '']) {
      assert.equal(isSameOrigin(other, origin), false, other)
    }
  })

  it('only http, https and mailto reach the system', () => {
    for (const ok of ['https://example.com', 'http://example.com/x', 'mailto:a@b.c']) assert.equal(isExternallyOpenable(ok), true, ok)
    for (const no of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'ftp://example.com', 'smb://host/share', 'vscode://x', 'x-apple.systempreferences:', '']) assert.equal(isExternallyOpenable(no), false, no)
  })
})

describe('decideNavigation', () => {
  it('allows the service origin', () => {
    assert.deepEqual(decideNavigation(`${origin}/projects`, origin), { action: 'allow' })
    assert.deepEqual(decideNavigation(`${origin}/#/x`, origin, 'redirect'), { action: 'allow' })
  })

  it('sends a navigated-to remote page to the system browser, leaving the window where it is', () => {
    assert.deepEqual(decideNavigation('https://example.com/x', origin), { action: 'external', url: 'https://example.com/x' })
  })

  it('a redirect is not user intent: denied, not opened', () => {
    assert.deepEqual(decideNavigation('https://example.com/x', origin, 'redirect'), { action: 'deny' })
  })

  it('denies every other scheme and look-alike origin', () => {
    for (const url of ['file:///etc/hosts', 'javascript:void 0', 'data:text/html,x', 'guanxi-shell://retry', 'about:blank', 'smb://host/share']) {
      assert.deepEqual(decideNavigation(url, origin), { action: 'deny' }, url)
    }
  })

  it('a subframe navigation is never handed to the system browser', () => {
    assert.deepEqual(decideNavigation('https://example.com/x', origin, 'subframe'), { action: 'deny' })
    assert.deepEqual(decideNavigation(`${origin}/x`, origin, 'subframe'), { action: 'allow' })
  })

  it('a look-alike origin is not the service: another port or host is "remote", never allowed in the window', () => {
    for (const url of ['http://127.0.0.1:4442/', 'http://localhost:4441/', 'http://127.0.0.1:4441@evil.test/']) {
      assert.notDeepEqual(decideNavigation(url, origin), { action: 'allow' }, url)
      assert.equal(decideNavigation(url, origin, 'redirect').action, 'deny', url)
    }
  })
})

describe('decideWindowOpen', () => {
  it('same-origin popouts become child windows', () => {
    assert.deepEqual(decideWindowOpen(`${origin}/workspace-popout.html`, origin), { action: 'child' })
  })
  it('remote http(s) goes to the system browser, never a window', () => {
    assert.deepEqual(decideWindowOpen('https://example.com/', origin), { action: 'external', url: 'https://example.com/' })
  })
  it('anything else is denied', () => {
    for (const url of ['file:///etc/hosts', 'javascript:1', 'data:text/html,x', 'about:blank', '']) assert.deepEqual(decideWindowOpen(url, origin), { action: 'deny' }, url)
  })
})

describe('allowRequest (no remote content)', () => {
  it('allows the service origin, its sockets and local data', () => {
    for (const url of [`${origin}/api/health`, 'ws://127.0.0.1:4441/socket', 'data:image/png;base64,AA', 'blob:http://127.0.0.1:4441/uuid']) assert.equal(allowRequest(url, origin), true, url)
  })
  it('cancels everything remote or foreign', () => {
    for (const url of ['https://example.com/a.png', 'http://127.0.0.1:4442/', 'http://localhost:4441/', 'ws://127.0.0.1:4442/', 'wss://example.com/', 'ftp://example.com/', 'file:///etc/hosts', 'nonsense']) assert.equal(allowRequest(url, origin), false, url)
  })
})

describe('allowPermission', () => {
  const ask = (permission: string, requestingUrl = `${origin}/`, isMainFrame = true) => allowPermission({ permission, requestingUrl, isMainFrame }, origin)

  it('grants the clipboard write (every copy button) and fullscreen to the top frame of the service origin', () => {
    assert.equal(ask('clipboard-sanitized-write'), true)
    assert.equal(ask('fullscreen'), true)
    assert.equal(ask('clipboard-sanitized-write', `${origin}/projects/1`), true)
  })

  it('does not grant them to a subframe, another origin or the shell’s own status page', () => {
    for (const permission of ['clipboard-sanitized-write', 'fullscreen']) {
      assert.equal(ask(permission, `${origin}/`, false), false)
      assert.equal(ask(permission, 'https://example.com/'), false)
      assert.equal(ask(permission, 'http://127.0.0.1:4442/'), false)
      assert.equal(ask(permission, 'data:text/html,x'), false)
      assert.equal(ask(permission, ''), false)
    }
  })

  it('denies everything else, for the service origin too: reading the clipboard, notifications (NC1 owns delivery), media, geolocation, devices', () => {
    for (const permission of ['clipboard-read', 'notifications', 'media', 'geolocation', 'openExternal', 'midi', 'midiSysex', 'hid', 'usb', 'serial', 'idle-detection', 'display-capture', 'persistent-storage']) {
      assert.equal(ask(permission), false, permission)
    }
  })
})

describe('contentSecurityPolicy', () => {
  const policy = contentSecurityPolicy(origin)
  const directive = (name: string) => policy.split('; ').find((part) => part.startsWith(`${name} `))

  it('lets the node’s pages load and connect to the node only', () => {
    assert.equal(directive('default-src'), "default-src 'self'")
    assert.equal(directive('connect-src'), "connect-src 'self' ws://127.0.0.1:4441")
    assert.equal(directive('object-src'), "object-src 'none'")
    assert.equal(directive('base-uri'), "base-uri 'self'")
    assert.equal(directive('form-action'), "form-action 'self'")
    assert.doesNotMatch(policy, /https?:\/\/|\*/, 'no remote source and no wildcard')
  })

  it('script-src is exactly self plus inline, and no directive allows eval or wasm eval', () => {
    assert.equal(directive('script-src'), "script-src 'self' 'unsafe-inline'")
    assert.doesNotMatch(policy, /unsafe-eval|wasm-unsafe-eval/)
  })

  it('keeps what the UI needs: workers and previews from blob:, inline theme bootstrap, data: fonts and images', () => {
    assert.match(directive('worker-src') ?? '', /blob:/)
    assert.match(directive('script-src') ?? '', /'unsafe-inline'/)
    assert.match(directive('img-src') ?? '', /data: blob:/)
    assert.match(directive('font-src') ?? '', /data:/)
  })
})
