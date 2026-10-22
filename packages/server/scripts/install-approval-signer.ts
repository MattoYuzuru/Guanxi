#!/usr/bin/env node
/**
 * Builds the approval signing helper and installs it under the owner's home directory:
 *
 *   node packages/server/scripts/install-approval-signer.ts [--home DIR] [--identifier ID]
 *
 * The installed copy is re-signed ad hoc at its final path, because the helper's keychain
 * access list names that executable. `--print-path` prints the destination without building.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PRODUCT_FILE_PREFIX, PRODUCT_NAME } from '@guanxi/contract'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')

function option(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : (process.argv[index + 1] ?? null)
}

const home = resolve(option('--home') ?? homedir())
const destination = join(
  home,
  'Library',
  'Application Support',
  PRODUCT_NAME,
  'approval-signer',
  `${PRODUCT_FILE_PREFIX}-approval-signer`,
)
const identifier = option('--identifier') ?? 'local.approval-signer'

if (process.argv.includes('--print-path')) {
  console.log(destination)
  process.exit(0)
}

const build = join(repoRoot, 'native', 'approval-signer', 'build.sh')
const source = join(repoRoot, 'native', 'approval-signer', '.build', 'approval-signer')
execFileSync('sh', [build], {
  env: { ...process.env, SIGNER_IDENTIFIER: identifier },
  stdio: ['ignore', 'inherit', 'inherit'],
})

mkdirSync(dirname(destination), { recursive: true })
copyFileSync(source, destination)
chmodSync(destination, 0o755)
execFileSync('codesign', ['-s', '-', '-f', '--identifier', identifier, destination], { stdio: 'ignore' })
console.log(destination)
