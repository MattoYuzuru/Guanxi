import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { PRODUCT_FILE_PREFIX, PRODUCT_NAME } from '@guanxi/contract/brand'
import { PLACEHOLDER_APP_ID, createConfig, notarizationCredentials } from '../../electron-builder.config.mjs'
import { DESKTOP_APP_ID } from '../../packaging/targets.mjs'

const REAL = { GUANXI_DESKTOP_APP_ID: 'org.example.guanxi', CSC_LINK: 'file-is-supplied-by-the-owner-in-ci', CSC_KEY_PASSWORD: 'x' }

describe('electron-builder configuration', () => {
  it('a default build is unsigned and un-notarized, and never picks up a keychain identity by itself', () => {
    const config = createConfig({})
    assert.equal(config.mac.identity, null)
    assert.equal(config.mac.notarize, false)
    assert.equal(config.electronFuses.resetAdHocDarwinSignature, true)
    assert.equal(config.appId, DESKTOP_APP_ID)
    assert.equal(config.appId, 'io.github.mattoyuzuru.guanxi', 'owner-approved permanent identity')
    assert.equal(config.publish, null, 'no update feed in this slice')
  })

  it('names and files come from the brand module', () => {
    const config = createConfig({})
    assert.equal(config.productName, PRODUCT_NAME)
    assert.ok(config.artifactName.startsWith(`${PRODUCT_FILE_PREFIX}-desktop-`))
  })

  it('macOS: arm64 DMG + zip, hardened runtime, minimal entitlements', () => {
    const { mac } = createConfig({})
    assert.deepEqual(mac.target, [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }])
    assert.equal(mac.hardenedRuntime, true)
    const plist = readFileSync(resolve(import.meta.dirname, '../../', mac.entitlements), 'utf8')
    const granted = [...plist.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((m) => m[1]).sort()
    assert.deepEqual(granted, ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory'])
  })

  it('fuses: every one closed, RunAsNode included (the service runs on its own staged Node.js)', () => {
    const fuses = createConfig({}).electronFuses
    assert.equal(fuses.runAsNode, false)
    assert.equal(fuses.enableCookieEncryption, true, 'the real application keeps cookie encryption enabled')
    assert.equal(fuses.enableNodeOptionsEnvironmentVariable, false)
    assert.equal(fuses.enableNodeCliInspectArguments, false)
    assert.equal(fuses.onlyLoadAppFromAsar, true)
    assert.equal(fuses.enableEmbeddedAsarIntegrityValidation, true)
    assert.equal(fuses.grantFileProtocolExtraPrivileges, false)
  })

  it('the service is shipped as a sub-directory file set, because the root node_modules of a set is never copied', () => {
    const [set] = createConfig({}).extraResources
    assert.deepEqual(set, { from: '.stage', to: '.', filter: ['service/**/*'] })
  })

  it('signing is opt-in and refuses to proceed without a certificate or without the real bundle id', () => {
    assert.throws(() => createConfig({ GUANXI_DESKTOP_SIGN: '1', GUANXI_DESKTOP_APP_ID: 'org.example.guanxi' }), /certificate/)
    assert.throws(() => createConfig({ GUANXI_DESKTOP_SIGN: '1', CSC_LINK: 'x', GUANXI_DESKTOP_APP_ID: PLACEHOLDER_APP_ID }), /bundle id/)
    assert.equal(createConfig({ GUANXI_DESKTOP_SIGN: '1', CSC_LINK: 'x' }).appId, DESKTOP_APP_ID)
    const signed = createConfig({ GUANXI_DESKTOP_SIGN: '1', ...REAL })
    assert.ok(!('identity' in signed.mac), 'electron-builder resolves the identity from CSC_LINK / CSC_NAME')
    assert.equal(signed.electronFuses.resetAdHocDarwinSignature, false)
    assert.equal(signed.appId, 'org.example.guanxi')
  })

  it('notarization needs signing and one complete credential set; each set is recognised', () => {
    assert.throws(() => createConfig({ GUANXI_DESKTOP_NOTARIZE: '1' }), /needs GUANXI_DESKTOP_SIGN/)
    assert.throws(() => createConfig({ GUANXI_DESKTOP_SIGN: '1', GUANXI_DESKTOP_NOTARIZE: '1', ...REAL }), /APPLE_API_KEY/)
    assert.throws(() => createConfig({ GUANXI_DESKTOP_SIGN: '1', GUANXI_DESKTOP_NOTARIZE: '1', ...REAL, APPLE_ID: 'a@b.c' }), /APPLE_API_KEY/)
    const sets = {
      'api-key': { APPLE_API_KEY: 'p', APPLE_API_KEY_ID: 'i', APPLE_API_ISSUER: 's' },
      'apple-id': { APPLE_ID: 'a@b.c', APPLE_APP_SPECIFIC_PASSWORD: 'p', APPLE_TEAM_ID: 't' },
      'keychain-profile': { APPLE_KEYCHAIN: 'k', APPLE_KEYCHAIN_PROFILE: 'p' },
    } as const
    for (const [name, set] of Object.entries(sets)) {
      assert.equal(notarizationCredentials(set), name)
      assert.equal(createConfig({ GUANXI_DESKTOP_SIGN: '1', GUANXI_DESKTOP_NOTARIZE: '1', ...REAL, ...set }).mac.notarize, true)
    }
  })

  it('holds no credential of its own: the config text and the repository package carry no secret-looking value', () => {
    const text = readFileSync(resolve(import.meta.dirname, '../../electron-builder.config.mjs'), 'utf8')
    assert.doesNotMatch(text, /-----BEGIN|\.p8|\.p12|app-specific|password\s*[:=]\s*['"][^'"]+['"]/i)
  })
})
