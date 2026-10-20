import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  huggingFaceImportStreamEventSchema,
  type CompletionProbeBody,
  type CompletionProbeEvidence,
  type HuggingFaceDownloadProvenance,
  type HuggingFaceImportStreamEvent,
} from '@guanxi/contract'
import { HuggingFaceImportService } from '../src/models/hugging-face-import.ts'

const roots: string[] = []
const ARTIFACT_ID = '11111111-1111-4111-8111-111111111111'
const TARGET = 'owner/model:latest'
const SOURCE_SHA = 'a'.repeat(40)
const OBSERVED_AT = '2026-08-09T12:00:00.000Z'
const LOCAL_HOST = 'http://127.0.0.1:11434'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function gguf(payload = 'fixture'): Uint8Array {
  const bytes = new Uint8Array(8 + payload.length)
  bytes.set([0x47, 0x47, 0x55, 0x46])
  new DataView(bytes.buffer).setUint32(4, 3, true)
  bytes.set(new TextEncoder().encode(payload), 8)
  return bytes
}

function sourceProvenance(bytes: Uint8Array): HuggingFaceDownloadProvenance {
  const digest = createHash('sha256').update(bytes).digest('hex')
  return {
    version: 1,
    identity: {
      provider: 'hugging_face', owner: 'Owner', name: 'Model',
      repositoryId: 'Owner/Model', comparisonKey: 'owner/model',
    },
    revision: { state: 'exact_commit', commit: SOURCE_SHA, source: 'hugging_face_api_model' },
    remotePath: 'model.gguf',
    license: {
      state: 'declared', value: 'apache-2.0',
      source: 'hugging_face_model_tags', confidence: 'declared',
    },
    gated: { state: 'open', mode: null },
    sourceUrlPolicy: 'hugging_face_exact_revision_explicit_hosts_v1',
    expectedSizeBytes: bytes.byteLength,
    observedSizeBytes: bytes.byteLength,
    checksum: {
      algorithm: 'sha256', expectedDigest: digest, observedDigest: digest,
      relation: 'matched_provider_claim',
    },
    format: { kind: 'gguf', magic: 'GGUF', version: 3, inspection: 'bounded_header_only' },
    artifact: { state: 'managed_staging', id: ARTIFACT_ID },
    observedAt: OBSERVED_AT,
    terminalState: 'completed',
  }
}

async function staging(bytes = gguf()) {
  const root = await mkdtemp(join(tmpdir(), 'guanxi-hf-import-'))
  roots.push(root)
  const path = join(root, `${ARTIFACT_ID}.gguf`)
  await writeFile(path, bytes)
  const file = await lstat(path)
  const provenance = sourceProvenance(bytes)
  let present = true
  return {
    root,
    path,
    provenance,
    downloads: {
      artifact: (id: string) => present && id === ARTIFACT_ID
        ? { id, path, rootDir: root, device: file.dev, inode: file.ino, provenance }
        : null,
      discard: async (id: string) => {
        if (!present || id !== ARTIFACT_ID) return false
        await rm(path)
        present = false
        return true
      },
    },
  }
}

function tags(models: Array<{ name: string; digest: string }> = []) {
  return {
    models: models.map((model) => ({
      ...model, model: model.name, modified_at: OBSERVED_AT, size: 1, details: {},
    })),
  }
}

function verifiedProbe(digest = 'manifest-digest'): CompletionProbeEvidence {
  return {
    status: 'verified', reason: 'terminal_response', capability: 'completion',
    source: 'runtime_probe', confidence: 'verified', observedAt: OBSERVED_AT,
    completedAt: OBSERVED_AT, durationMs: 0, historical: false,
    basis: {
      state: 'exact', keyVersion: 1, probeDefinitionVersion: 1,
      provider: 'ollama', normalizedModelReference: TARGET,
      artifactDigest: digest, runtimeVersion: '0.32.0', contextLength: 8_192,
      id: `sha256:${'b'.repeat(64)}`,
    },
  }
}

function createFrames(options: { abort?: AbortController; malformed?: boolean } = {}) {
  return async function* (_model: string, _filename: string, digest: string) {
    yield { status: 'parsing GGUF' }
    if (options.malformed) {
      yield { status: 'success' }
      return
    }
    yield { status: `using existing layer ${digest}` }
    yield { status: 'writing manifest' }
    yield { status: 'success' }
    options.abort?.abort('hf-import-user-cancelled')
  }
}

async function collect(
  service: HuggingFaceImportService,
  signal = new AbortController().signal,
  targetModelName = TARGET,
): Promise<HuggingFaceImportStreamEvent[]> {
  const events: HuggingFaceImportStreamEvent[] = []
  for await (const event of service.import({
    artifactId: ARTIFACT_ID, targetModelName, contextLength: 8_192,
  }, signal)) {
    assert.deepEqual(huggingFaceImportStreamEventSchema.parse(event), event)
    events.push(event)
  }
  return events
}

describe('server-owned staged GGUF import', () => {
  it('rejects incompatible state/phase and completed provenance identities', () => {
    assert.throws(() => huggingFaceImportStreamEventSchema.parse({
      type: 'state', seq: 0,
      data: { version: 1, state: 'preparing', phase: 'creating_model' },
    }))
    const source = sourceProvenance(gguf())
    const provenance = {
      version: 1, source, targetModelName: TARGET,
      create: {
        endpoint: '/api/create', input: 'uploaded_sha256_blob_files_map',
        terminalStatus: 'success', startedAt: OBSERVED_AT, terminalAt: OBSERVED_AT,
      },
      installation: {
        source: 'ollama_api_tags', normalizedModelReference: TARGET,
        digest: 'manifest-digest', runtimeVersion: '0.32.0', observedAt: OBSERVED_AT,
      },
      probe: verifiedProbe(),
      staging: { artifactId: ARTIFACT_ID, retention: 'deleted_after_verified_success' },
      completedAt: OBSERVED_AT,
    }
    for (const inconsistent of [
      { ...provenance, targetModelName: 'other/model:latest' },
      {
        ...provenance,
        staging: {
          ...provenance.staging,
          artifactId: '22222222-2222-4222-8222-222222222222',
        },
      },
    ]) {
      assert.throws(() => huggingFaceImportStreamEventSchema.parse({
        type: 'completed', seq: 0,
        data: { version: 1, state: 'completed', provenance: inconsistent },
      }))
    }
  })

  it('collapses a concurrent artifact/target activation before any mutation', async () => {
    const staged = await staging()
    let mutations = 0
    const service = new HuggingFaceImportService({
      downloads: staged.downloads,
      ollama: () => ({
        host: LOCAL_HOST,
        tags: async () => tags(),
        blobExists: async () => { mutations += 1; return true },
        pushBlob: async () => { mutations += 1 },
        createModelFromBlob: async function* () { mutations += 1 },
      }),
      completionProbe: { execute: async () => { mutations += 1; return verifiedProbe() } },
    } as never)
    const first = service.import({
      artifactId: ARTIFACT_ID, targetModelName: TARGET, contextLength: 8_192,
    }, new AbortController().signal)
    assert.equal((await first.next()).value?.type, 'state')
    const duplicate = (await collect(
      service,
      new AbortController().signal,
      'other/model:latest',
    )).at(-1)!
    assert.equal(duplicate.type, 'conflict')
    if (duplicate.type === 'conflict') assert.equal(duplicate.data.reason, 'duplicate_active')
    assert.equal(mutations, 0)
    await first.return(undefined)
  })

  it('refuses a remote Ollama host before artifact or provider effects', async () => {
    let effects = 0
    const service = new HuggingFaceImportService({
      downloads: {
        artifact: () => { effects += 1; return null },
        discard: async () => { effects += 1; return false },
      },
      ollama: () => ({
        host: 'http://192.0.2.10:11434',
        tags: async () => { effects += 1; return tags() },
      }),
      completionProbe: { execute: async () => { effects += 1; return verifiedProbe() } },
    } as never)
    const terminal = (await collect(service)).at(-1)!
    assert.equal(terminal.type, 'failed')
    if (terminal.type === 'failed') {
      assert.equal(terminal.data.reason, 'remote_provider_not_allowed')
    }
    assert.equal(effects, 0)
  })

  it('revalidates the artifact, uploads exact bytes, creates once, observes tags, probes and cleans up', async () => {
    const staged = await staging()
    const calls = { tags: 0, blob: 0, push: 0, create: 0, probe: 0 }
    let uploaded = new Uint8Array()
    const service = new HuggingFaceImportService({
      downloads: staged.downloads,
      ollama: () => ({
        host: LOCAL_HOST,
        tags: async () => {
          calls.tags += 1
          return calls.tags < 3 ? tags() : tags([{ name: TARGET, digest: 'manifest-digest' }])
        },
        blobExists: async (digest: string) => {
          calls.blob += 1
          assert.equal(digest, `sha256:${staged.provenance.checksum.observedDigest}`)
          return false
        },
        pushBlob: async (digest: string, body: RequestInit['body'], size: number) => {
          calls.push += 1
          assert.equal(digest, `sha256:${staged.provenance.checksum.observedDigest}`)
          assert.equal(size, staged.provenance.observedSizeBytes)
          const reader = (body as ReadableStream<Uint8Array>).getReader()
          const chunks: Uint8Array[] = []
          for (;;) {
            const result = await reader.read()
            if (result.done) break
            chunks.push(result.value)
          }
          uploaded = Buffer.concat(chunks)
        },
        createModelFromBlob: async function* (model: string, filename: string, digest: string) {
          calls.create += 1
          assert.equal(model, TARGET)
          assert.equal(filename, 'model.gguf')
          yield* createFrames()(model, filename, digest)
        },
      }),
      completionProbe: {
        execute: async (_name: string, body: CompletionProbeBody) => {
          calls.probe += 1
          assert.deepEqual(body, {
            capability: 'completion', expectedDigest: 'manifest-digest',
            contextLength: 8_192, force: true,
          })
          return verifiedProbe()
        },
      },
      now: () => new Date(OBSERVED_AT),
    } as never)

    const events = await collect(service)
    const terminal = events.at(-1)!
    assert.equal(terminal.type, 'completed')
    assert.deepEqual(calls, { tags: 3, blob: 1, push: 1, create: 1, probe: 1 })
    assert.deepEqual(uploaded, Buffer.from(gguf()))
    await assert.rejects(readFile(staged.path), { code: 'ENOENT' })
    if (terminal.type === 'completed') {
      assert.deepEqual(terminal.data.provenance.source, staged.provenance)
      assert.equal(terminal.data.provenance.targetModelName, TARGET)
      assert.equal(terminal.data.provenance.installation.digest, 'manifest-digest')
      assert.equal(terminal.data.provenance.probe.status, 'verified')
      assert.equal(terminal.data.provenance.staging.retention, 'deleted_after_verified_success')
    }
    assert.equal(events.filter((event) => event.type === 'completed').length, 1)

    const repeated = (await collect(service)).at(-1)!
    assert.equal(repeated.type, 'failed')
    if (repeated.type === 'failed') assert.equal(repeated.data.reason, 'artifact_not_found')
    assert.deepEqual(calls, { tags: 3, blob: 1, push: 1, create: 1, probe: 1 })
  })

  it('fails closed for missing, foreign, symlinked, replaced and checksum-corrupt artifacts before Ollama', async () => {
    const cases: Array<[
      'missing' | 'foreign' | 'symlink' | 'replaced' | 'corrupt', string,
    ]> = [
      ['missing', 'artifact_not_found'],
      ['foreign', 'artifact_changed'],
      ['symlink', 'artifact_changed'],
      ['replaced', 'artifact_changed'],
      ['corrupt', 'artifact_corrupt'],
    ]
    for (const [kind, reason] of cases) {
      const staged = await staging()
      if (kind === 'missing') await rm(staged.path)
      if (kind === 'symlink') {
        const foreign = join(staged.root, `${randomUUID()}.gguf`)
        await writeFile(foreign, gguf('foreign'))
        await rm(staged.path)
        await symlink(foreign, staged.path)
      }
      if (kind === 'replaced') await writeFile(staged.path, gguf('replacement'))
      if (kind === 'corrupt') {
        const bytes = gguf()
        bytes[8] = 0xff
        await writeFile(staged.path, bytes)
      }
      let providerCalls = 0
      const downloads = kind === 'foreign'
        ? {
            ...staged.downloads,
            artifact: (id: string) => {
              const record = staged.downloads.artifact(id)
              return record ? { ...record, path: join(staged.root, 'foreign.gguf') } : null
            },
          }
        : staged.downloads
      const service = new HuggingFaceImportService({
        downloads,
        ollama: () => ({
          host: LOCAL_HOST,
          tags: async () => { providerCalls += 1; return tags() },
        }),
        completionProbe: { execute: async () => { throw new Error('not called') } },
      } as never)
      const terminal = (await collect(service)).at(-1)!
      assert.equal(terminal.type, 'failed', kind)
      if (terminal.type === 'failed') assert.equal(terminal.data.reason, reason, kind)
      assert.equal(providerCalls, 0, kind)
    }
  })

  it('refuses a pre-existing or ambiguous normalized target without blob/create/probe effects', async () => {
    for (const models of [
      [{ name: TARGET, digest: 'existing' }],
      [{ name: TARGET, digest: 'a' }, { name: 'OWNER/MODEL', digest: 'b' }],
    ]) {
      const staged = await staging()
      let effects = 0
      const service = new HuggingFaceImportService({
        downloads: staged.downloads,
        ollama: () => ({
          host: LOCAL_HOST,
          tags: async () => tags(models),
          blobExists: async () => { effects += 1; return false },
          pushBlob: async () => { effects += 1 },
          createModelFromBlob: async function* () { effects += 1 },
        }),
        completionProbe: { execute: async () => { effects += 1; return verifiedProbe() } },
      } as never)
      const terminal = (await collect(service)).at(-1)!
      assert.equal(terminal.type, 'conflict')
      if (terminal.type === 'conflict') {
        assert.equal(terminal.data.reason, models.length === 1 ? 'target_preexisting' : 'target_ambiguous')
      }
      assert.equal(effects, 0)
      assert.deepEqual(await readFile(staged.path), Buffer.from(gguf()))
    }
  })

  it('rejects missing terminal/progress order and never treats create status alone as Installation', async () => {
    const staged = await staging()
    let tagsCalls = 0
    const service = new HuggingFaceImportService({
      downloads: staged.downloads,
      ollama: () => ({
        host: LOCAL_HOST,
        tags: async () => { tagsCalls += 1; return tags() },
        blobExists: async () => true,
        pushBlob: async () => { throw new Error('not called') },
        createModelFromBlob: createFrames({ malformed: true }),
      }),
      completionProbe: { execute: async () => { throw new Error('not called') } },
    } as never)
    const terminal = (await collect(service)).at(-1)!
    assert.equal(terminal.type, 'failed')
    if (terminal.type === 'failed') {
      assert.equal(terminal.data.reason, 'create_protocol_error')
      assert.equal(terminal.data.target?.state, 'absent')
    }
    assert.equal(tagsCalls, 3)
    assert.deepEqual(await readFile(staged.path), Buffer.from(gguf()))
  })

  it('rejects duplicate, regressing and post-terminal create frames', async () => {
    const sequences = [
      ['parsing GGUF', 'parsing GGUF', 'using existing layer DIGEST', 'writing manifest', 'success'],
      ['parsing GGUF', 'using existing layer DIGEST', 'parsing GGUF', 'writing manifest', 'success'],
      ['parsing GGUF', 'using existing layer DIGEST', 'writing manifest', 'success', 'success'],
    ]
    for (const sequence of sequences) {
      const staged = await staging()
      const service = new HuggingFaceImportService({
        downloads: staged.downloads,
        ollama: () => ({
          host: LOCAL_HOST,
          tags: async () => tags(),
          blobExists: async () => true,
          pushBlob: async () => { throw new Error('not called') },
          createModelFromBlob: async function* (_model: string, _file: string, blobDigest: string) {
            for (const status of sequence) {
              yield { status: status.replace('DIGEST', blobDigest) }
            }
          },
        }),
        completionProbe: { execute: async () => { throw new Error('not called') } },
      } as never)
      const terminal = (await collect(service)).at(-1)!
      assert.equal(terminal.type, 'failed', sequence.join(' -> '))
      if (terminal.type === 'failed') assert.equal(terminal.data.reason, 'create_protocol_error')
      assert.deepEqual(await readFile(staged.path), Buffer.from(gguf()))
    }
  })

  it('never issues a second create after an uncertain create attempt', async () => {
    const staged = await staging()
    let createCalls = 0
    const service = new HuggingFaceImportService({
      downloads: staged.downloads,
      ollama: () => ({
        host: LOCAL_HOST,
        tags: async () => tags(),
        blobExists: async () => true,
        pushBlob: async () => { throw new Error('not called') },
        createModelFromBlob: async function* () {
          createCalls += 1
          yield { status: 'parsing GGUF' }
          yield { status: 'success' }
        },
      }),
      completionProbe: { execute: async () => { throw new Error('not called') } },
    } as never)

    const first = (await collect(service)).at(-1)!
    assert.equal(first.type, 'failed')
    const second = (await collect(service)).at(-1)!
    assert.equal(second.type, 'conflict')
    if (second.type === 'conflict') {
      assert.equal(second.data.reason, 'outcome_unknown')
      assert.equal(second.data.target.state, 'absent')
    }
    assert.equal(createCalls, 1)
    assert.deepEqual(await readFile(staged.path), Buffer.from(gguf()))
  })

  it('reconciles cancellation after create as conflict and retains staging', async () => {
    const staged = await staging()
    const controller = new AbortController()
    let tagsCalls = 0
    const service = new HuggingFaceImportService({
      downloads: staged.downloads,
      ollama: () => ({
        host: LOCAL_HOST,
        tags: async () => {
          tagsCalls += 1
          return tagsCalls < 3 ? tags() : tags([{ name: TARGET, digest: 'manifest-digest' }])
        },
        blobExists: async () => true,
        pushBlob: async () => {},
        createModelFromBlob: createFrames({ abort: controller }),
      }),
      completionProbe: { execute: async () => { throw new Error('not called') } },
    } as never)
    const terminal = (await collect(service, controller.signal)).at(-1)!
    assert.equal(terminal.type, 'conflict')
    if (terminal.type === 'conflict') {
      assert.equal(terminal.data.reason, 'cancelled_after_create')
      assert.equal(terminal.data.target.state, 'exact')
    }
    assert.deepEqual(await readFile(staged.path), Buffer.from(gguf()))
  })

  it('allows a probe-only retry after observed create and never issues a second create', async () => {
    const staged = await staging()
    let tagsCalls = 0
    let createCalls = 0
    let probeCalls = 0
    const service = new HuggingFaceImportService({
      downloads: staged.downloads,
      ollama: () => ({
        host: LOCAL_HOST,
        tags: async () => {
          tagsCalls += 1
          return tagsCalls < 3 ? tags() : tags([{ name: TARGET, digest: 'manifest-digest' }])
        },
        blobExists: async () => true,
        pushBlob: async () => {},
        createModelFromBlob: async function* (model: string, filename: string, digest: string) {
          createCalls += 1
          yield* createFrames()(model, filename, digest)
        },
      }),
      completionProbe: {
        execute: async () => {
          probeCalls += 1
          return probeCalls === 1
            ? { ...verifiedProbe(), status: 'degraded', reason: 'provider_error', confidence: 'degraded' }
            : verifiedProbe()
        },
      },
      now: () => new Date(OBSERVED_AT),
    } as never)

    const first = (await collect(service)).at(-1)!
    assert.equal(first.type, 'failed')
    if (first.type === 'failed') assert.equal(first.data.reason, 'probe_not_verified')
    assert.deepEqual(await readFile(staged.path), Buffer.from(gguf()))

    const second = (await collect(service)).at(-1)!
    assert.equal(second.type, 'completed')
    assert.equal(createCalls, 1)
    assert.equal(probeCalls, 2)
    await assert.rejects(readFile(staged.path), { code: 'ENOENT' })
  })

  it('reports clean cancellation only before create and performs no provider mutation', async () => {
    const staged = await staging()
    const controller = new AbortController()
    controller.abort('hf-import-user-cancelled')
    let calls = 0
    const service = new HuggingFaceImportService({
      downloads: staged.downloads,
      ollama: () => ({
        host: LOCAL_HOST,
        tags: async () => { calls += 1; return tags() },
      }),
      completionProbe: { execute: async () => { calls += 1; return verifiedProbe() } },
    } as never)
    const terminal = (await collect(service, controller.signal)).at(-1)!
    assert.equal(terminal.type, 'cancelled')
    if (terminal.type === 'cancelled') assert.equal(terminal.data.reason, 'user_requested')
    assert.equal(calls, 0)
    assert.deepEqual(await readFile(staged.path), Buffer.from(gguf()))
  })
})
