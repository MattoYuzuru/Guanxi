// The Node.js that runs the packaged service: download, verify, extract. Kept out of stage-service.mjs so it can
// be tested without the network or a real archive.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Node.js 26.9.0 (released 2026-09-16) is the version the repository's CI runs. The digests are pinned here,
// copied from https://nodejs.org/dist/v26.9.0/SHASUMS256.txt; bytes that do not match are rejected. Bump
// deliberately for security releases (hand-off, residual risk).
export const NODE_VERSION = '26.9.0'
export const NODE_SHA256 = {
  'darwin-arm64': '6f3de7ed853ee283b4bf24b6e426618f1d357401ce5815db1866eb85eb4b05d9',
  'darwin-x64': '06b2e742ed9025dc84adc830243b3f731956eac9c321bccd0ede384209af02a8',
}

export const archiveName = (platformKey, version = NODE_VERSION) => `node-v${version}-${platformKey}.tar.gz`
export const archiveUrl = (platformKey, version = NODE_VERSION) => `https://nodejs.org/dist/v${version}/${archiveName(platformKey, version)}`

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

export class DigestMismatch extends Error {
  constructor(actual, expected) {
    super(`Node.js archive digest mismatch: got ${actual}, expected ${expected}`)
    this.name = 'DigestMismatch'
  }
}

/**
 * Bytes whose SHA-256 is the pinned digest, from the cache when it verifies, otherwise from the network.
 * @param {{ cachePath: string, url: string, expected: string, fetchImpl?: any, timeoutMs?: number, log?: (line: string) => void }} options
 * @returns {Promise<Buffer>}
 */
export async function verifiedArchive({ cachePath, url, expected, fetchImpl = fetch, timeoutMs = 120_000, log = () => undefined }) {
  const cached = await readFile(cachePath).catch(() => null)
  if (cached !== null && sha256(cached) === expected) return cached
  if (cached !== null) log(`cached ${cachePath} does not match the pinned digest; downloading again`)
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`Node.js download failed: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const actual = sha256(bytes)
  if (actual !== expected) throw new DigestMismatch(actual, expected)
  await mkdir(join(cachePath, '..'), { recursive: true })
  await writeFile(cachePath, bytes, { mode: 0o600 })
  return bytes
}

const defaultRun = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})`)
}

/**
 * Extract `bin/node` and `LICENSE` from VERIFIED bytes. The archive handed to `tar` is a fresh file written from
 * those bytes into a private temporary directory (never the cache file, which something else could have changed
 * after it was checked); the directory is removed whether or not extraction succeeds.
 */
export async function extractNodeRuntime({ bytes, expected, destination, workDir, run = defaultRun }) {
  if (sha256(bytes) !== expected) throw new DigestMismatch(sha256(bytes), expected)
  await mkdir(workDir, { recursive: true })
  const scratch = await mkdtemp(join(workDir, 'unpack-'))
  try {
    const archive = join(scratch, 'node.tar.gz')
    await writeFile(archive, bytes, { mode: 0o600 })
    const into = join(scratch, 'tree')
    await mkdir(into)
    run('tar', ['-xzf', archive, '-C', into, '--strip-components=1'])
    await mkdir(join(destination, 'bin'), { recursive: true })
    await cp(join(into, 'bin', 'node'), join(destination, 'bin', 'node'))
    await cp(join(into, 'LICENSE'), join(destination, 'LICENSE'))
    await chmod(join(destination, 'bin', 'node'), 0o755)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Leftovers of an earlier run that was killed before its `finally`. */
export async function removeStaleUnpacks(workDir) {
  for (const entry of await readdir(workDir).catch(() => [])) {
    if (entry.startsWith('unpack-')) await rm(join(workDir, entry), { recursive: true, force: true })
  }
}
