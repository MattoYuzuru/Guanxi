import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONTAINER_IMAGE, GUARD_DIGEST, GUARD_LABEL, ContainerExecutionOwner } from '../../src/native-agent/execution-owner.ts'
import type { SandboxPolicy } from '../../src/native-agent/sandbox-protocol.ts'

const container = (file: string) => readFile(new URL(`../../src/native-agent/container/${file}`, import.meta.url))

test('the guard digest the node trusts is the hash of guard.c followed by the Dockerfile', async () => {
  // Editing either file without updating GUARD_DIGEST (and rebuilding the image) must fail here.
  const digest = createHash('sha256').update(await container('guard.c')).update(await container('Dockerfile')).digest('hex')
  assert.equal(GUARD_DIGEST, digest)
  assert.match(GUARD_LABEL, /^org\.guanxi\./)
})

test('the provisioning script labels the image with the same digest it computes from the files', async () => {
  const script = await readFile(new URL('../../scripts/prepare-native-execution.sh', import.meta.url), 'utf8')
  assert.match(script, new RegExp(`--label "?${GUARD_LABEL.replaceAll('.', '\\.')}=`))
  assert.match(script, /guard\.c/); assert.match(script, /Dockerfile/); assert.ok(script.includes(CONTAINER_IMAGE), 'script builds the tag the node runs')
})

// A fake docker that answers `image inspect` as an image built from other guard content (or not at all)
// would, and records every call so that "failed closed" can be shown as "never reached create".
async function attempt(answer: string, exit = 0) {
  const dir = await mkdtemp(join(tmpdir(), 'k4-image-'))
  try {
    const log = join(dir, 'calls'), docker = join(dir, 'docker')
    await writeFile(docker, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$3" in image) printf '%s' '${answer}'; exit ${exit};; *) exit 0;; esac\n`, { mode: 0o700 })
    const policy: SandboxPolicy = { mode: 'read-only', scratch: join(dir, 'scratch'), roots: [], attachments: [], protectedPaths: [], domains: [] }
    const owner = new ContainerExecutionOwner(policy, 'unix:///fixture', 'k4-image-fixture', dir, docker)
    const outcome = await owner.execute('printf MUST_NOT_RUN').then(() => 'ran', (error: Error) => error.message)
    const calls = (await readFile(log, 'utf8')).trim().split('\n')
    return { outcome, calls }
  } finally { await rm(dir, { recursive: true, force: true }) }
}
const id = `sha256:${'a'.repeat(64)}`

test('an image without the guard label (an older build) fails closed before any container is created', async () => {
  const { outcome, calls } = await attempt(`${id} `)
  assert.equal(outcome, 'container_runtime_unavailable')
  assert.equal(calls.length, 1); assert.match(calls[0]!, /image inspect/)
})
test('an image labelled with another guard digest fails closed', async () => {
  const { outcome, calls } = await attempt(`${id} ${'0'.repeat(64)}`)
  assert.equal(outcome, 'container_runtime_unavailable')
  assert.equal(calls.length, 1)
})
test('inspect output with anything beyond "<id> <digest>" fails closed', async () => {
  for (const answer of [`${id} ${GUARD_DIGEST} extra`, `${id} ${GUARD_DIGEST.toUpperCase()}`, `${GUARD_DIGEST} ${id}`, `${id}\n${GUARD_DIGEST}`]) {
    assert.equal((await attempt(answer)).outcome, 'container_runtime_unavailable', answer)
  }
})
test('a missing image fails closed', async () => {
  const { outcome } = await attempt('', 1)
  assert.equal(outcome, 'container_runtime_unavailable')
})
test('the label is read from the inspected image by the same inspect that selects its content-addressed id', async () => {
  const { calls } = await attempt(`${id} ${'0'.repeat(64)}`)
  assert.ok(calls[0]!.includes(CONTAINER_IMAGE) && calls[0]!.includes(GUARD_LABEL), calls[0])
})
test('an image carrying the current guard digest passes the identity gate', async () => {
  const { outcome } = await attempt(`${id} ${GUARD_DIGEST}`)
  // Later steps need a running sandbox runtime and fail differently; only the identity gate is under test.
  assert.notEqual(outcome, 'container_runtime_unavailable')
})
