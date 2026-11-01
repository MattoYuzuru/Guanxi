// Bounded macOS packaging gate: exercises files shipped in DMG/ZIP, never checkout service code.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PRODUCT_FILE_PREFIX, PRODUCT_NAME } from '@guanxi/contract/brand'
import { DESKTOP_APP_ID, MAC_ARCH } from '../packaging/targets.mjs'
import { NODE_VERSION } from './lib/node-runtime.mjs'
import { compareApps, verifyBuildEvidence, verifyNotices } from './lib/package-evidence.mjs'
import { inspectService } from './lib/package-process.mjs'
import { connectRenderer } from './lib/renderer-cdp.mjs'
import { packageLaunchArguments } from './lib/package-launch.mjs'
import { verifyStagedService } from './lib/verify-stage.mjs'

const desktop = resolve(import.meta.dirname, '..')
const root = resolve(desktop, '../..')
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
const sleep = ms => new Promise(done => setTimeout(done, ms))
async function until(label, action, timeout = 90_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const result = await action().catch(() => null)
    if (result) return result
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}
async function freePort() {
  const socket = createServer()
  await new Promise((done, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', done) })
  const port = socket.address().port
  await new Promise(done => socket.close(done))
  return port
}
export const ZIP_PREFLIGHT = `
import zipfile,sys,posixpath,stat
app=sys.argv[2]
seen=set()
with zipfile.ZipFile(sys.argv[1]) as archive:
 for entry in archive.infolist():
  name=entry.filename
  parts=name.rstrip('/').split('/')
  assert name not in seen and parts[0]==app and all(p not in ('','..','.') for p in parts) and '\\\\' not in name, 'Unexpected ZIP path'
  seen.add(name)
  if stat.S_ISLNK(entry.external_attr >> 16):
   target=archive.read(entry).decode('utf-8')
   resolved=posixpath.normpath(posixpath.join(posixpath.dirname(name),target))
   assert not target.startswith('/') and resolved.startswith(app+'/'), 'ZIP symlink escapes app'
 assert archive.testzip() is None, 'ZIP CRC failure'
`

async function smokeApp(app, temporary) {
  const resources = join(app, 'Contents', 'Resources')
  const entry = join(resources, 'service', 'bin.js')
  const node = join(resources, 'service', 'node', 'bin', 'node')
  const data = join(temporary, 'data')
  const port = await freePort()
  const debugPort = await freePort()
  assert.notEqual(port, debugPort)
  const home = join(temporary, 'home')
  await mkdir(home)
  const child = spawn(join(app, 'Contents', 'MacOS', PRODUCT_NAME), packageLaunchArguments(join(temporary, 'chromium'), debugPort), {
    cwd: temporary,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: temporary, LANG: 'en_US.UTF-8',
      GUANXI_API_PORT: String(port), GUANXI_DATA_DIR: data, GUANXI_PROVIDER_KEYS_FILE: '',
      GUANXI_DESKTOP_HEALTH_TIMEOUT_MS: '90000' },
    stdio: 'ignore',
  })
  let shellExited = false
  child.once('exit', () => { shellExited = true })
  let spawnError
  child.once('error', error => { spawnError = error; shellExited = true })
  let servicePid
  let renderer
  const serviceState = () => inspectService(servicePid, {
    probe: pid => process.kill(pid, 0), command: pid => run('/bin/ps', ['-p', String(pid), '-o', 'uid=', '-o', 'command=']),
    uid: process.getuid(), executable: node, entry, dataDir: data,
  })
  const health = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
    assert.equal(response.status, 200)
    const body = await response.json()
    return body.ok === true && body.application.source === 'application_http'
  }
  let failure
  try {
    // Instrument the initial status document before data→HTTP navigation. A URL alone does
    // not establish renderer readiness; late attachment can stall the inspector in that transition.
    await until('loopback renderer debugging endpoint', async () => (await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1000) })).ok)
    const target = await until('packaged renderer', async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000) })
      return (await response.json()).find(target => target.type === 'page')
    })
    const debuggerUrl = new URL(target.webSocketDebuggerUrl)
    assert.equal(debuggerUrl.origin, `ws://127.0.0.1:${debugPort}`)
    renderer = await connectRenderer(debuggerUrl.href)
    await Promise.all(['Runtime.enable', 'Page.enable', 'Debugger.enable', 'Runtime.runIfWaitingForDebugger', 'Network.enable', 'Log.enable'].map(method => renderer.send(method)))
    const manifest = await until('packaged service manifest', async () => {
      if (spawnError) throw spawnError
      if (shellExited) throw new Error('Packaged shell exited before readiness')
      return JSON.parse(await readFile(join(data, 'desktop', 'service.json'), 'utf8'))
    })
    assert.ok(Number.isSafeInteger(manifest.pid) && manifest.pid > 1)
    servicePid = manifest.pid
    assert.equal(manifest.entry, entry)
    assert.equal(manifest.port, port)
    assert.equal(serviceState(), 'owned', 'temporary service must run mounted bundled Node and entry with the test data directory')
    await until('packaged service health', health)
    const evaluate = async expression => {
      const result = await renderer.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      assert.ok(!result.exceptionDetails, 'packaged renderer evaluation must succeed')
      return result.result.value
    }
    let lastDocument
    try {
      await until('initial packaged UI mount', async () => {
        lastDocument = await evaluate('({origin: location.origin, ready: document.readyState, title: document.title, heading: document.querySelector("h1")?.textContent?.slice(0, 120), rootChildren: document.querySelectorAll("#root > *").length})')
        return lastDocument.origin === `http://127.0.0.1:${port}` && lastDocument.rootChildren > 0
      }, 60_000)
    } catch (error) {
      // Only synthetic test-document status metadata; never dump HTML, application data or logs.
      throw new Error(`Packaged UI readiness failed: ${JSON.stringify(lastDocument ?? { state: 'unobservable' })}`, { cause: error })
    }
    await renderer.reload()
    await until('packaged UI mount', async () => evaluate('document.querySelectorAll("#root > *").length > 0'), 60_000)
    assert.deepEqual(await evaluate('[typeof process, typeof require]'), ['undefined', 'undefined'])
    const csp = await evaluate('fetch("/").then(r => r.headers.get("content-security-policy"))')
    assert.ok(typeof csp === 'string' && csp.includes("script-src 'self'") && !csp.includes("'unsafe-eval'"), 'packaged shell must install its script CSP')
    await sleep(1000)
    assert.deepEqual(renderer.violations, [], 'packaged UI resources must load under the shell policy')
    child.kill('SIGTERM')
    await until('packaged shell exit', async () => shellExited, 10_000)
    assert.equal(serviceState(), 'owned', 'node service must survive shell termination')
    assert.equal(await health(), true)
  } catch (error) {
    failure = error
    throw error
  } finally {
    try {
      if (!shellExited) child.kill('SIGTERM')
      renderer?.close()
      // Read the owned temporary manifest even if readiness/assertions failed before it was captured.
      if (!servicePid) {
        const manifest = await readFile(join(data, 'desktop', 'service.json'), 'utf8').then(JSON.parse).catch(() => null)
        if (Number.isSafeInteger(manifest?.pid) && manifest.pid > 1) servicePid = manifest.pid
      }
      if (serviceState() === 'owned') process.kill(servicePid, 'SIGTERM')
      await until('owned processes to exit', async () => shellExited && serviceState() === 'gone', 10_000).catch(() => {
        if (!shellExited) child.kill('SIGKILL')
        if (serviceState() === 'owned') process.kill(servicePid, 'SIGKILL')
      })
      if (servicePid) await until('confirmed process exit after escalation', async () => shellExited && serviceState() === 'gone', 5000)
    } catch (error) {
      throw new AggregateError([failure, error].filter(Boolean), 'Packaged smoke/owned process cleanup failed')
    }
  }
}

export async function verifyPackage() {
  assert.equal(process.platform, 'darwin', 'package smoke requires macOS')
  assert.equal(process.arch, MAC_ARCH)
  assert.equal(run('git', ['-C', root, 'status', '--porcelain']).trim(), '', 'package evidence requires a clean committed source tree')
  const pkg = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'))
  const stem = `${PRODUCT_FILE_PREFIX}-desktop-${pkg.version}-${MAC_ARCH}`
  const output = join(desktop, 'release')
  const dmg = join(output, `${stem}.dmg`)
  const zip = join(output, `${stem}.zip`)
  const identity = { commit: run('git', ['-C', root, 'rev-parse', 'HEAD']).trim(), tree: run('git', ['-C', root, 'rev-parse', 'HEAD^{tree}']).trim(),
    version: pkg.version, appId: DESKTOP_APP_ID, architecture: MAC_ARCH }
  const evidence = await verifyBuildEvidence(JSON.parse(await readFile(join(output, 'build-evidence.json'), 'utf8')), identity, [dmg, zip])
  // macOS aliases /var to /private/var; Electron canonicalizes Resources before launching Node.
  const temporary = await realpath(await mkdtemp(join(tmpdir(), `${PRODUCT_FILE_PREFIX}-package-`)))
  const mount = join(temporary, 'mount')
  const extracted = join(temporary, 'zip')
  let mounted = false
  let failure
  try {
    await mkdir(mount)
    run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg])
    mounted = true
    assert.deepEqual((await readdir(mount)).filter(name => name.endsWith('.app')), [`${PRODUCT_NAME}.app`])
    const app = join(mount, `${PRODUCT_NAME}.app`)
    run('/usr/bin/python3', ['-c', ZIP_PREFLIGHT, zip, `${PRODUCT_NAME}.app`])
    await mkdir(extracted)
    run('/usr/bin/ditto', ['-x', '-k', zip, extracted])
    await compareApps(app, join(extracted, `${PRODUCT_NAME}.app`))
    const appId = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(app, 'Contents', 'Info.plist')]).trim()
    assert.equal(appId, DESKTOP_APP_ID)
    assert.equal(run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents', 'Info.plist')]).trim(), pkg.version)
    await verifyNotices(join(app, 'Contents', 'Resources'))
    await verifyStagedService(join(app, 'Contents', 'Resources', 'service'), { nodeVersion: NODE_VERSION, run })
    // codesign writes its description to stderr. Require the declared ad-hoc identity.
    const details = spawn('/usr/bin/codesign', ['-dvv', app], { stdio: ['ignore', 'ignore', 'pipe'] })
    let description = ''
    details.stderr.on('data', bytes => { description += bytes })
    assert.equal(await new Promise(done => details.on('close', done)), 0)
    assert.match(description, /Signature=adhoc/)
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
    await smokeApp(app, temporary)
    assert.equal(run('git', ['-C', root, 'status', '--porcelain']).trim(), '')
    assert.equal(run('git', ['-C', root, 'rev-parse', 'HEAD']).trim(), identity.commit, 'source changed during package verification')
    await writeFile(join(output, 'package-evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
    await writeFile(join(output, 'SHA256SUMS'), evidence.assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join(''))
    console.log(JSON.stringify({ verified: true, ...evidence }))
  } catch (error) {
    failure = error
    throw error
  } finally {
    // Do not delete a mount point if detach fails; retain its task directory for recovery.
    if (mounted) {
      try { run('/usr/bin/hdiutil', ['detach', mount]) } catch (error) {
        throw new AggregateError([failure, error].filter(Boolean), 'Package verification/volume cleanup failed; temporary mount retained')
      }
    }
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] === import.meta.filename) {
  try { await verifyPackage() } catch (error) { console.error(error); process.exitCode = 1 }
}
