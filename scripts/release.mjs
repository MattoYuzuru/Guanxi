/** Version-tag promotion of the current run's verified macOS bytes; never builds or creates tags. */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { appendFile, lstat, open, readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PRODUCT_FILE_PREFIX, PRODUCT_NAME } from '../packages/contract/src/brand.ts'
import { DESKTOP_APP_ID, MAC_ARCH } from '../packages/desktop/packaging/targets.mjs'
import { tasks } from './ci/tasks.mjs'

const project = resolve(import.meta.dirname, '..')
const sha = /^[a-f0-9]{40}$/
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/

export class ReleaseError extends Error {
  constructor(code) { super(code); this.name = 'ReleaseError'; this.code = code }
}
const requireThat = (condition, code) => { if (!condition) throw new ReleaseError(code) }
const positive = value => Number.isSafeInteger(value) && value > 0
const sameKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join()

/** Validate event and local source before even reading publisher credentials. */
export function releaseContext({ eventName, ref, commit, tree, version, repository, runId, runAttempt, tagCommit, mainAncestor, clean, actions, forced = false, deleted = false }) {
  requireThat(actions === 'true' && eventName === 'push' && !forced && !deleted && typeof ref === 'string' && ref.startsWith('refs/tags/v'), 'release_event_refused')
  const tag = ref.slice('refs/tags/'.length)
  requireThat(versionPattern.test(tag.slice(1)) && tag === `v${version}`, 'release_version_mismatch')
  requireThat(sha.test(commit) && sha.test(tree) && tagCommit === commit && mainAncestor === true && clean === true, 'release_source_refused')
  requireThat(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') && !repository.split('/').some(part => part === '.' || part === '..'), 'release_repository_refused')
  requireThat(positive(runId) && positive(runAttempt), 'release_run_refused')
  return Object.freeze({ tag, version, commit, tree, repository, runId, runAttempt })
}

export async function localContext(env = process.env, root = project) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  // Check syntax before passing the ref to git, and reject non-tag events without touching source.
  requireThat(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'push' && /^refs\/tags\/v[^/]+$/.test(env.GITHUB_REF ?? ''), 'release_event_refused')
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'))
  requireThat(event.ref === env.GITHUB_REF, 'release_event_refused')
  const pkg = JSON.parse(await readFile(resolve(root, 'packages/desktop/package.json'), 'utf8'))
  return releaseContext({ actions: env.GITHUB_ACTIONS, eventName: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF,
    forced: event.forced, deleted: event.deleted, commit: env.GITHUB_SHA, tree: git('rev-parse', 'HEAD^{tree}'),
    version: pkg.version, repository: env.GITHUB_REPOSITORY, runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    tagCommit: git('rev-parse', `${env.GITHUB_REF}^{commit}`), clean: git('status', '--porcelain') === '' && git('rev-parse', 'HEAD') === env.GITHUB_SHA,
    mainAncestor: spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main'], { stdio: 'ignore' }).status === 0 })
}

/** Fixed GitHub origins, no redirects/retries, and no upstream body/error text in failures. */
export function githubClient(token, fetchImpl = fetch) {
  requireThat(typeof token === 'string' && token.length > 0, 'release_credential_unavailable')
  return async ({ method = 'GET', path, body, asset }) => {
    const origin = asset ? 'https://uploads.github.com' : 'https://api.github.com'
    const url = new URL(path, origin)
    requireThat(url.origin === origin && path.startsWith('/repos/'), 'release_endpoint_refused')
    let stream
    try {
      stream = asset?.stream()
      const response = await fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(asset ? 15 * 60_000 : 60_000),
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2026-03-10',
          ...(asset ? { 'content-type': asset.contentType, 'content-length': String(asset.size) } : body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(asset ? { body: stream, duplex: 'half' } : body === undefined ? {} : { body: JSON.stringify(body) }) })
      let data
      try { data = await response.json() } catch { throw new ReleaseError('release_response_invalid') }
      return { status: response.status, data }
    } catch (error) { throw error instanceof ReleaseError ? error : new ReleaseError('release_request_failed') }
    finally { stream?.destroy() }
  }
}

const prefix = context => `/repos/${context.repository}`
async function get(api, path) {
  const response = await api({ path })
  requireThat(response?.status === 200 && response.data !== null && typeof response.data === 'object', 'release_read_failed')
  return response.data
}

/** Numeric pagination inspects all entries without trusting server-provided next origins. */
async function pages(api, path, field) {
  const result = [], seen = new Set()
  for (let page = 1; ; page++) {
    const data = await get(api, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    const items = field ? data[field] : data
    requireThat(Array.isArray(items), 'release_response_invalid')
    for (const item of items) {
      requireThat(item && positive(item.id) && !seen.has(item.id), 'release_response_invalid')
      seen.add(item.id); result.push(item)
    }
    if (items.length < 100) return result
  }
}

async function remoteSource(api, context) {
  const repo = prefix(context)
  const metadata = await get(api, repo)
  requireThat(metadata.full_name === context.repository && metadata.default_branch === 'main', 'release_repository_refused')
  let object = (await get(api, `${repo}/git/ref/tags/${encodeURIComponent(context.tag)}`)).object
  const seen = new Set()
  while (object?.type === 'tag') {
    requireThat(sha.test(object.sha) && !seen.has(object.sha), 'release_tag_mismatch')
    seen.add(object.sha)
    object = (await get(api, `${repo}/git/tags/${object.sha}`)).object
  }
  requireThat(object?.type === 'commit' && object.sha === context.commit, 'release_tag_mismatch')
  const main = (await get(api, `${repo}/git/ref/heads/main`)).object
  requireThat(main?.type === 'commit' && sha.test(main.sha), 'release_source_refused')
  const comparison = await get(api, `${repo}/compare/${context.commit}...${main.sha}`)
  requireThat(comparison.base_commit?.sha === context.commit && ['ahead', 'identical'].includes(comparison.status), 'release_source_refused')
}

/** The publisher itself is still running; every planned check must already have succeeded. */
export async function releaseRun(api, context) {
  await remoteSource(api, context)
  const repo = prefix(context)
  const run = await get(api, `${repo}/actions/runs/${context.runId}`)
  requireThat(run.id === context.runId && run.run_attempt === context.runAttempt && run.event === 'push' && run.head_sha === context.commit &&
    run.status === 'in_progress' && run.conclusion === null && run.repository?.full_name === context.repository &&
    run.path?.split('@')[0] === '.github/workflows/full-gate.yml', 'release_run_refused')
  // A publisher-only rerun need not re-execute successful matrix jobs. Read all attempts and
  // select the newest actual execution of each required name, never an older green fallback.
  const history = await pages(api, `${repo}/actions/runs/${context.runId}/jobs?filter=all`, 'jobs')
  const jobs = []
  for (const name of ['plan', 'Full gate', ...tasks.map(task => `check / ${task.id}`)]) {
    const candidates = history.filter(job => job.name === name), attempts = new Set()
    requireThat(candidates.length > 0, 'release_gate_incomplete')
    for (const candidate of candidates) {
      requireThat(positive(candidate.run_attempt) && candidate.run_attempt <= context.runAttempt && !attempts.has(candidate.run_attempt) &&
        candidate.head_sha === context.commit, 'release_gate_incomplete')
      attempts.add(candidate.run_attempt)
    }
    const latest = candidates.reduce((left, right) => left.run_attempt > right.run_attempt ? left : right)
    requireThat(latest.status === 'completed' && latest.conclusion === 'success', 'release_gate_incomplete')
    jobs.push(latest)
  }
  const packageJob = jobs.find(job => job.name === 'check / desktop-package')
  requireThat(positive(packageJob.run_attempt) && packageJob.run_attempt <= context.runAttempt, 'release_artifact_refused')
  const artifacts = await pages(api, `${repo}/actions/runs/${context.runId}/artifacts`, 'artifacts')
  const matches = artifacts.filter(artifact => artifact.name === `macos-arm64-package-${packageJob.run_attempt}`)
  requireThat(matches.length === 1 && matches[0].expired === false && matches[0].workflow_run?.id === context.runId && matches[0].workflow_run?.head_sha === context.commit,
    'release_artifact_refused')
  return Object.freeze({ id: matches[0].id, name: matches[0].name, runId: context.runId })
}

async function digest(handle) {
  const hash = createHash('sha256')
  for await (const bytes of handle.createReadStream({ start: 0, autoClose: false })) hash.update(bytes)
  return hash.digest('hex')
}

/** Open only the four verified regular files. Handles pin uploads to their validated files. */
export async function releaseBundle(directory, context) {
  const stem = `${PRODUCT_FILE_PREFIX}-desktop-${context.version}-${MAC_ARCH}`
  const binaries = [`${stem}.dmg`, `${stem}.zip`]
  const names = [...binaries, 'SHA256SUMS', 'package-evidence.json']
  requireThat((await lstat(directory)).isDirectory(), 'release_bundle_invalid')
  requireThat(JSON.stringify((await readdir(directory)).sort()) === JSON.stringify([...names].sort()), 'release_bundle_invalid')
  const assets = []
  const close = () => Promise.all(assets.map(asset => asset.handle.close()))
  try {
    for (const name of names) {
      const handle = await open(resolve(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const asset = { name, handle }; assets.push(asset)
      const stat = await handle.stat()
      requireThat(stat.isFile() && stat.nlink === 1 && Number.isSafeInteger(stat.size) && stat.size > 0, 'release_bundle_invalid')
      asset.size = stat.size; asset.sha256 = await digest(handle)
      asset.contentType = name.endsWith('.json') ? 'application/json' : name === 'SHA256SUMS' ? 'text/plain' : 'application/octet-stream'
      asset.stream = () => handle.createReadStream({ start: 0, autoClose: false })
    }
    const text = async name => {
      const asset = assets.find(item => item.name === name)
      requireThat(asset.size <= 2 * 1024 * 1024, 'release_bundle_invalid')
      const buffer = Buffer.alloc(asset.size)
      requireThat((await asset.handle.read(buffer, 0, buffer.length, 0)).bytesRead === buffer.length, 'release_bundle_invalid')
      return buffer.toString('utf8')
    }
    let evidence
    try { evidence = JSON.parse(await text('package-evidence.json')) } catch { throw new ReleaseError('release_bundle_invalid') }
    requireThat(sameKeys(evidence, ['schema', 'commit', 'tree', 'version', 'appId', 'architecture', 'signing', 'notarized', 'assets']) &&
      evidence.schema === 1 && evidence.commit === context.commit && evidence.tree === context.tree && evidence.version === context.version &&
      evidence.appId === DESKTOP_APP_ID && evidence.architecture === MAC_ARCH && evidence.signing === 'ad-hoc' && evidence.notarized === false &&
      Array.isArray(evidence.assets) && evidence.assets.length === 2, 'release_bundle_invalid')
    for (const [index, name] of binaries.entries()) {
      const actual = assets.find(item => item.name === name), declared = evidence.assets[index]
      requireThat(sameKeys(declared, ['name', 'size', 'sha256']) && declared.name === name && declared.size === actual.size && declared.sha256 === actual.sha256,
        'release_bundle_invalid')
    }
    requireThat(await text('SHA256SUMS') === evidence.assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join(''), 'release_bundle_invalid')
    return { assets, close }
  } catch (error) { await close(); throw error }
}

function releaseBody(context, artifact) {
  return `${PRODUCT_NAME} ${context.tag}\n\nAlpha macOS Apple Silicon DMG and ZIP, ad-hoc signed; not Developer ID signed or notarized.\n` +
    `macOS Gatekeeper may block first launch. Follow the package instructions: https://github.com/${context.repository}/blob/${context.commit}/docs/operations/desktop-packages.md\n` +
    `Source: ${context.commit}\nVerified full gate: https://github.com/${context.repository}/actions/runs/${context.runId}\n\n` +
    `<!-- ${PRODUCT_FILE_PREFIX}-release:v1;source=${context.commit};tree=${context.tree};run=${context.runId};artifact=${artifact.id} -->`
}
function checkRelease(release, context, body, expectedId) {
  requireThat(release && positive(release.id) && (expectedId === undefined || release.id === expectedId) &&
    release.tag_name === context.tag && release.target_commitish === context.commit && release.name === `${PRODUCT_NAME} ${context.tag}` &&
    release.body === body && typeof release.draft === 'boolean' && release.prerelease === true, 'release_conflict')
}
function checkAssets(existing, assets, complete = false) {
  const seen = new Set()
  for (const actual of existing) {
    const expected = assets.find(asset => asset.name === actual.name)
    requireThat(expected && !seen.has(actual.name) && actual.state === 'uploaded' && actual.size === expected.size && actual.digest === `sha256:${expected.sha256}` &&
      actual.content_type === expected.contentType, 'release_asset_conflict')
    seen.add(actual.name)
  }
  if (complete) requireThat(seen.size === assets.length, 'release_asset_incomplete')
  return seen
}

/** No mutating retry, clobber or deletion: an ambiguous failure leaves a draft for a same-byte rerun. */
export async function publishRelease(api, context, bundle, artifact) {
  const selected = await releaseRun(api, context)
  requireThat(selected.id === artifact.id && selected.name === artifact.name && selected.runId === artifact.runId, 'release_artifact_refused')
  const repo = prefix(context), body = releaseBody(context, artifact)
  const matching = (await pages(api, `${repo}/releases`)).filter(release => release.tag_name === context.tag)
  requireThat(matching.length <= 1, 'release_conflict')
  let release = matching[0]
  let existing = []
  if (release) {
    checkRelease(release, context, body)
    existing = await pages(api, `${repo}/releases/${release.id}/assets`)
    checkAssets(existing, bundle.assets, !release.draft)
  }
  // Rehash every pinned handle and recheck the remote tag immediately before any mutation.
  for (const asset of bundle.assets) requireThat(await digest(asset.handle) === asset.sha256 && (await asset.handle.stat()).size === asset.size, 'release_bundle_changed')
  await remoteSource(api, context)
  if (release && !release.draft) return { status: 'unchanged', tag: context.tag, releaseId: release.id }
  if (!release) {
    const response = await api({ method: 'POST', path: `${repo}/releases`, body: { tag_name: context.tag, target_commitish: context.commit,
      name: `${PRODUCT_NAME} ${context.tag}`, body, draft: true, prerelease: true, make_latest: 'false' } })
    requireThat(response?.status === 201 && response.data?.draft === true, 'release_create_failed')
    release = response.data; checkRelease(release, context, body)
  }
  const present = checkAssets(existing, bundle.assets)
  for (const asset of bundle.assets) if (!present.has(asset.name)) {
    const response = await api({ method: 'POST', path: `${repo}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`, asset })
    requireThat(response?.status === 201 && positive(response.data?.id) && response.data.name === asset.name, 'release_upload_failed')
    checkAssets([response.data], [asset], true)
  }
  const fresh = await get(api, `${repo}/releases/${release.id}`)
  checkRelease(fresh, context, body, release.id)
  requireThat(fresh.draft === true, 'release_conflict')
  checkAssets(await pages(api, `${repo}/releases/${release.id}/assets`), bundle.assets, true)
  // Fetch gate and tag again: moving refs, new attempts or stale artifacts cannot be published.
  requireThat((await releaseRun(api, context)).id === artifact.id, 'release_artifact_refused')
  const response = await api({ method: 'PATCH', path: `${repo}/releases/${release.id}`, body: { draft: false, make_latest: 'false' } })
  requireThat(response?.status === 200 && response.data?.draft === false, 'release_publish_failed')
  checkRelease(response.data, context, body, release.id)
  checkAssets(await pages(api, `${repo}/releases/${release.id}/assets`), bundle.assets, true)
  return { status: 'published', tag: context.tag, releaseId: release.id }
}

if (process.argv[1] === import.meta.filename) {
  let bundle
  try {
    const context = await localContext()
    const api = githubClient(process.env.GITHUB_TOKEN)
    const artifact = await releaseRun(api, context)
    if (process.argv[2] === 'select') {
      requireThat(process.env.GITHUB_OUTPUT, 'release_output_unavailable')
      await appendFile(process.env.GITHUB_OUTPUT, `artifact-id=${artifact.id}\n`)
      console.log(JSON.stringify({ selected: artifact.id, run: artifact.runId }))
    } else {
      requireThat(process.argv[2] === 'publish' && process.argv.length === 4, 'release_command_refused')
      bundle = await releaseBundle(resolve(process.argv[3]), context)
      console.log(JSON.stringify(await publishRelease(api, context, bundle, artifact)))
    }
  } catch (error) { console.error(error instanceof ReleaseError ? error.code : 'release_failed'); process.exitCode = 1 }
  finally { await bundle?.close() }
}
