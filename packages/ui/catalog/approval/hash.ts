/**
 * Hashes that bind an approval to what the owner saw: the component folder (minus its review
 * record and docs) and its committed visual baselines.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listFiles(full))
    else out.push(full)
  }
  return out
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Files that do not change what the component is: its review record and its docs. */
export function isHashExcluded(fileName: string): boolean {
  return fileName.endsWith('.review.json') || fileName.endsWith('.docs.md')
}

/**
 * sha256 over "<relative posix path>\n<sha256 of the LF-normalised content>\n" for every file
 * in the component folder, sorted by path. CRLF is normalised so checkouts on Windows hash the
 * same as on macOS and Linux.
 */
export function componentSourceHash(componentDir: string): string {
  const hash = createHash('sha256')
  const files = listFiles(componentDir)
    .map((file) => ({ file, rel: relative(componentDir, file).split(sep).join('/') }))
    .filter(({ rel }) => !isHashExcluded(rel))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  for (const { file, rel } of files) {
    const content = readFileSync(file).toString('utf8').replace(/\r\n/g, '\n')
    hash.update(`${rel}\n${sha256(content)}\n`)
  }
  return `sha256:${hash.digest('hex')}`
}

/** `{ "<story>.<theme>": "sha256:…" }` for every committed baseline of the component. */
export function componentSnapshotHashes(snapshotsDir: string, id: string): Record<string, string> {
  const dir = join(snapshotsDir, id)
  if (!existsSync(dir)) return {}
  const result: Record<string, string> = {}
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.png')) continue
    result[name.slice(0, -'.png'.length)] = `sha256:${sha256(readFileSync(join(dir, name)))}`
  }
  return result
}

export function sameSnapshotHashes(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a).sort()
  const keysB = Object.keys(b).sort()
  return keysA.length === keysB.length && keysA.every((key, index) => key === keysB[index] && a[key] === b[key])
}
