#!/usr/bin/env node
/**
 * Owner approval key (D-138). Run by the owner, on the owner's Mac, never by an agent:
 *
 *   node packages/ui/catalog/scripts/approval-key.ts init   # create the key in the keychain
 *   node packages/ui/catalog/scripts/approval-key.ts show   # print the public entry again
 *
 * `init` generates an Ed25519 key pair in memory, stores the private key (PKCS#8, base64) in
 * the login keychain as a generic password whose access list trusts no application, so every
 * read shows a macOS prompt, and prints the public entry to add to
 * packages/ui/catalog/approval-keys.json on main. The secret goes to `security` on stdin,
 * never on a command line, and is never printed.
 *
 * Options: `--keychain PATH` uses another keychain file (tests); `--trust-security-tool`
 * lets `/usr/bin/security` read the item without a prompt (automated tests only).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { exportPublicKey, type TrustedKey } from '../approval/index.ts'

const SERVICE = 'guanxi.ui-approval'
const ACCOUNT = 'owner-approval-key'

function option(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : (process.argv[index + 1] ?? null)
}

const security = option('--security') ?? '/usr/bin/security'
const keychain = option('--keychain')
const service = option('--service') ?? SERVICE
const keychainArgs = keychain ? [keychain] : []

function itemComment(): string | null {
  const result = spawnSync(security, ['find-generic-password', '-s', service, '-a', ACCOUNT, ...keychainArgs], {
    encoding: 'utf8',
  })
  if (result.status !== 0) return null
  return /"icmt"<blob>="(ed25519:[0-9a-f]{32})"/.exec(result.stdout)?.[1] ?? null
}

function quote(value: string): string {
  if (!/^[A-Za-z0-9:._/=+-]+$/.test(value)) throw new Error(`refusing to pass an unexpected value to security: ${value}`)
  return value
}

function init(): void {
  if (process.platform !== 'darwin') throw new Error('The approval key lives in the macOS keychain; run this on the owner Mac.')
  if (itemComment() !== null || spawnSync(security, ['find-generic-password', '-s', service, '-a', ACCOUNT, ...keychainArgs]).status === 0) {
    throw new Error(`A keychain item ${service}/${ACCOUNT} already exists. Run "show", or delete it in Keychain Access first.`)
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const { keyId, publicKey: spki } = exportPublicKey(publicKey)
  const secret = privateKey.export({ format: 'der', type: 'pkcs8' })
  const access = process.argv.includes('--trust-security-tool') ? '' : '-T "" '
  const command =
    `add-generic-password -s ${quote(service)} -a ${ACCOUNT} -j ${quote(keyId)} ` +
    `-l "Guanxi UI approval key" ${access}-w ${quote(secret.toString('base64'))}` +
    (keychain ? ` ${quote(keychain)}` : '') +
    '\n'
  try {
    execFileSync(security, ['-i'], { input: command, stdio: ['pipe', 'ignore', 'inherit'] })
  } finally {
    secret.fill(0)
  }
  if (itemComment() !== keyId) throw new Error('The keychain item was not created as expected.')
  printEntry({ keyId, algorithm: 'ed25519', publicKey: spki, addedAt: new Date().toISOString(), note: 'owner approval key' })
}

function show(): void {
  const keyId = itemComment()
  if (keyId === null) throw new Error(`No keychain item ${service}/${ACCOUNT}. Run "init" first.`)
  console.log(`Keychain item ${service}/${ACCOUNT} holds key ${keyId}.`)
  console.log('The public key is in packages/ui/catalog/approval-keys.json once it has been committed on main.')
}

function printEntry(entry: TrustedKey): void {
  // Sanity check: the printed public key really derives the printed key id.
  if (exportPublicKey(createPublicKey({ key: Buffer.from(entry.publicKey, 'base64'), format: 'der', type: 'spki' })).keyId !== entry.keyId) {
    throw new Error('Public key does not match its key id.')
  }
  console.log(`Created the owner approval key ${entry.keyId} in the keychain.`)
  console.log('Add this entry to "keys" in packages/ui/catalog/approval-keys.json and commit it on main yourself:')
  console.log(JSON.stringify(entry, null, 2))
  console.log('Compare the key id with the one the catalog shows before you trust it.')
}

const command = process.argv[2]
try {
  if (command === 'init') init()
  else if (command === 'show') show()
  else {
    console.error('usage: approval-key.ts init | show [--keychain PATH]')
    process.exit(2)
  }
} catch (error) {
  console.error((error as Error).message)
  process.exit(1)
}
