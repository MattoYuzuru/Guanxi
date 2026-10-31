import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Entitlements that are `<true/>` in a plist (the form `codesign -d --xml --entitlements -` prints). */
export function trueEntitlements(plist) {
  return [...String(plist).matchAll(/<key>([^<]+)<\/key>\s*<true\s*\/>/g)].map((match) => match[1]).sort()
}

/** `TeamIdentifier=XXXX` from `codesign -dvv` output; null for unsigned and ad-hoc ("not set"). */
export function teamIdentifier(output) {
  const match = /^TeamIdentifier=(.+)$/m.exec(String(output))
  return match && match[1].trim() !== 'not set' ? match[1].trim() : null
}

async function findNativeAddons(directory, found = []) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) await findNativeAddons(path, found)
    else if (entry.name.endsWith('.node')) found.push(path)
  }
  return found
}

/** The nested executables that run code outside the app's main binary: the bundled Node and every native addon. */
export async function nestedBinaries(appPath) {
  const service = join(appPath, 'Contents', 'Resources', 'service')
  return [join(service, 'node', 'bin', 'node'), ...(await findNativeAddons(join(service, 'node_modules'))).sort()]
}

/**
 * Run after electron-builder signed the app (signing enabled only). Every nested binary must carry the app's own
 * Team ID and exactly the entitlements of `packaging/entitlements.mac.plist`, and must pass `codesign --verify`.
 * An unsigned local build is never checked: it keeps whatever the official Node.js binary ships with, which is
 * more permissive than ours.
 * @param run (file, args) => stdout+stderr string; throws on a non-zero exit
 */
export async function verifyNestedSignatures({ appPath, entitlementsFile, run, binaries }) {
  const expected = trueEntitlements(await readFile(entitlementsFile, 'utf8'))
  const appTeam = teamIdentifier(run('/usr/bin/codesign', ['-dvv', appPath]))
  if (appTeam === null) throw new Error(`${appPath} has no Team ID: it was not signed with a Developer ID identity`)
  const files = binaries ?? (await nestedBinaries(appPath))
  if (files.length === 0 || !files[0].endsWith('/node/bin/node')) throw new Error('The bundled Node.js was not found among the nested binaries')
  const problems = []
  for (const file of files) {
    try {
      run('/usr/bin/codesign', ['--verify', '--strict', file])
    } catch (error) {
      problems.push(`${file}: signature invalid (${error.message})`)
      continue
    }
    const team = teamIdentifier(run('/usr/bin/codesign', ['-dvv', file]))
    if (team !== appTeam) problems.push(`${file}: Team ID ${team ?? 'not set'}, expected ${appTeam}`)
    const granted = trueEntitlements(run('/usr/bin/codesign', ['-d', '--xml', '--entitlements', '-', file]))
    if (JSON.stringify(granted) !== JSON.stringify(expected)) {
      problems.push(`${file}: entitlements [${granted.join(', ')}], expected [${expected.join(', ')}]`)
    }
  }
  if (problems.length > 0) throw new Error(`Nested binaries are not signed as the app is:\n  ${problems.join('\n  ')}`)
  return { team: appTeam, checked: files.length, entitlements: expected }
}
