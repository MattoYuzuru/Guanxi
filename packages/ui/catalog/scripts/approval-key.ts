#!/usr/bin/env node
/**
 * Owner approval key (D-184). Run by the owner, on the owner's Mac, never by an agent:
 *
 *   node packages/ui/catalog/scripts/approval-key.ts init   # install the helper, create the key
 *   node packages/ui/catalog/scripts/approval-key.ts show   # print the public entry again
 *
 * `init` delegates to the installed Secure Enclave helper, which creates the P-256 key and
 * stores its wrapped representation in the login keychain, and prints the public entry to add
 * to packages/ui/catalog/approval-keys.json on main. The private key never enters this process.
 *
 * Options: `--helper PATH` uses a specific helper (tests use the test build); `--home DIR`
 * installs under another home; `--service S` and `--account A` override the keychain item.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createPublicKey } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  exportPublicKey,
  type TrustedKey,
} from '../approval/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const installer = join(here, '..', '..', '..', 'server', 'scripts', 'install-approval-signer.ts')

function option(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : (process.argv[index + 1] ?? null)
}

const home = option('--home')
const service = option('--service') ?? KEYCHAIN_SERVICE
const account = option('--account') ?? KEYCHAIN_ACCOUNT

function installedHelper(build: boolean): string {
  const args = [installer, ...(build ? [] : ['--print-path']), ...(home ? ['--home', home] : [])]
  const output = execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  const path = output.trim().split('\n').at(-1) ?? ''
  if (path === '') throw new Error('The installer did not print the approval signer path.')
  return path
}

function helperPath(build: boolean): string {
  return resolve(option('--helper') ?? installedHelper(build))
}

function invoke(helper: string, request: Record<string, unknown>): Record<string, unknown> {
  const result = spawnSync(helper, [], { input: JSON.stringify(request), encoding: 'utf8' })
  let response: Record<string, unknown> | null = null
  try {
    response = JSON.parse(result.stdout.trim()) as Record<string, unknown>
  } catch {
    response = null
  }
  if (!response) {
    throw new Error(`The approval signer helper returned no JSON response${result.stderr ? `: ${result.stderr.trim()}` : ''}`)
  }
  if (response['ok'] !== true) {
    throw new Error(`The approval signer helper refused: ${String(response['code'])}: ${String(response['message'])}`)
  }
  return response
}

function init(): void {
  const status = invoke(helperPath(true), { op: 'init', service, account })
  const keyId = status['keyId']
  const publicKey = status['publicKey']
  if (status['state'] !== 'available' || typeof keyId !== 'string' || typeof publicKey !== 'string') {
    throw new Error('The approval signer helper did not return a key id and public key.')
  }
  printEntry({ keyId, algorithm: 'p256', publicKey, addedAt: new Date().toISOString(), note: 'owner approval key' })
}

function show(): void {
  const status = invoke(helperPath(false), { op: 'status', service, account })
  if (status['state'] !== 'available' || typeof status['keyId'] !== 'string') {
    throw new Error(`No approval key is stored as ${service}/${account}. Run "init" first.`)
  }
  console.log(`Keychain item ${service}/${account} holds key ${status['keyId']}.`)
  console.log('The public key is in packages/ui/catalog/approval-keys.json once it has been committed on main.')
}

function printEntry(entry: TrustedKey): void {
  // Sanity check: the printed public key really derives the printed key id.
  if (
    exportPublicKey(createPublicKey({ key: Buffer.from(entry.publicKey, 'base64'), format: 'der', type: 'spki' })).keyId !==
    entry.keyId
  ) {
    throw new Error('Public key does not match its key id.')
  }
  console.log(`Created the owner approval key ${entry.keyId} in the login keychain.`)
  console.log('Add this entry to "keys" in packages/ui/catalog/approval-keys.json, set "version" to 1, and commit it on main yourself:')
  console.log(JSON.stringify(entry, null, 2))
  console.log('Compare the key id with the one the catalog shows before you trust it.')
}

const command = process.argv[2]
try {
  if (command === 'init') init()
  else if (command === 'show') show()
  else {
    console.error('usage: approval-key.ts init | show [--helper PATH] [--home DIR] [--service S] [--account A]')
    process.exit(2)
  }
} catch (error) {
  console.error((error as Error).message)
  process.exit(1)
}
