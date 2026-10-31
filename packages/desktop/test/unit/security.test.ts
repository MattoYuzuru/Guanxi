import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SECURE_WEB_PREFERENCES,
  allowPermission,
  allowRequest,
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
  it('grants nothing', () => {
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'midi', 'hid']) assert.equal(allowPermission(permission), false)
  })
})
