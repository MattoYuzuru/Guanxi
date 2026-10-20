import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  huggingFaceSelectionResultSchema,
  type HardwareInfo,
  type HuggingFaceRepository,
  type HuggingFaceRepositoryResult,
} from '@guanxi/contract'
import { normalizeHuggingFaceReference } from '../src/models/hugging-face-reference.ts'
import { selectHuggingFaceGgufFile as selectHuggingFaceGgufFileImpl } from '../src/models/hugging-face-selection.ts'
import type {
  HuggingFaceRepositoryReader,
  SelectHuggingFaceGgufFileInput,
} from '../src/models/hugging-face-selection.ts'

const OBSERVED_AT = '2026-08-08T12:00:00.000Z'
const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const REVISION = {
  state: 'exact_commit' as const,
  commit: SHA,
  source: 'hugging_face_api_model' as const,
}

const HARDWARE: HardwareInfo = {
  platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8,
  totalMemoryBytes: 32_000_000_000, usableMemoryBytes: 24_000_000_000,
  accelerator: 'metal', acceleratorName: 'fixture', unifiedMemory: true,
  freeDiskBytes: null,
}

function supportedRepository(overrides: Partial<HuggingFaceRepository> = {}): HuggingFaceRepository {
  return {
    version: 1,
    provider: 'hugging_face',
    identity: {
      provider: 'hugging_face',
      owner: 'TheBloke',
      name: 'Llama-2-7B-GGUF',
      repositoryId: 'TheBloke/Llama-2-7B-GGUF',
      comparisonKey: 'thebloke/llama-2-7b-gguf',
    },
    metadata: 'resolved',
    observedAt: OBSERVED_AT,
    revision: { state: 'exact_commit', commit: SHA, source: 'hugging_face_api_model' },
    gated: { state: 'open', mode: null },
    license: {
      state: 'declared', value: 'apache-2.0',
      source: 'hugging_face_model_tags', confidence: 'declared',
    },
    files: {
      state: 'listed',
      source: 'hugging_face_api_model',
      totalFiles: 2,
      malformedEntries: 0,
      truncated: false,
      ggufFiles: [
        { path: 'llama-2-7b.Q4_K_M.gguf', sizeBytes: 4_000_000_000, sizeSource: 'hugging_face_api_model' },
        { path: 'llama-2-7b.Q8_0.gguf', sizeBytes: null, sizeSource: 'not_reported' },
      ],
    },
    verdict: {
      state: 'supported',
      scope: 'exact_gguf_file_only',
      basis: 'exact_gguf_files_listed',
      reason: null,
      requiresExactFileSelection: true,
    },
    ...overrides,
  }
}

function readerFor(repository: HuggingFaceRepository): HuggingFaceRepositoryReader {
  const result: HuggingFaceRepositoryResult = {
    state: 'resolved',
    version: repository.version,
    preview: normalizeHuggingFaceReference(repository.identity.repositoryId),
    repository,
    source: {
      state: 'available', source: 'hugging_face_public_api', observedAt: OBSERVED_AT, reason: null,
    },
    reason: null,
  }
  return { repository: async () => result }
}

const preview = () => normalizeHuggingFaceReference('TheBloke/Llama-2-7B-GGUF')

function selectHuggingFaceGgufFile(
  input: Omit<SelectHuggingFaceGgufFileInput, 'hardwareObservedAt' | 'now'>,
) {
  return selectHuggingFaceGgufFileImpl({
    ...input,
    hardwareObservedAt: OBSERVED_AT,
    now: () => new Date(OBSERVED_AT),
  })
}

describe('P2-K Hugging Face GGUF file/revision selection', () => {
  it('confirms an exact file on the exact current revision with a calculated fit', async () => {
    const repository = supportedRepository()
    const result = await selectHuggingFaceGgufFile({
      huggingFace: readerFor(repository),
      hardware: HARDWARE,
      preview: preview(),
      revision: REVISION,
      filePath: 'llama-2-7b.Q4_K_M.gguf',
      contextLength: 8_192,
    })
    assert.deepEqual(huggingFaceSelectionResultSchema.parse(result), result)
    assert.equal(result.state, 'confirmed')
    if (result.state !== 'confirmed') return
    assert.equal(result.selection.filePath, 'llama-2-7b.Q4_K_M.gguf')
    assert.deepEqual(result.selection.revision, REVISION)
    assert.equal(result.fit.state, 'calculated')
    if (result.fit.state === 'calculated') {
      assert.equal(result.fit.verdict.basis, 'vendor_hint')
      assert.equal(result.fit.verdict.modelBytes, 4_000_000_000)
      assert.equal(result.fit.calculatedAt, OBSERVED_AT)
      assert.deepEqual(result.fit.hardware, {
        source: 'application_startup_hardware_probe',
        observedAt: OBSERVED_AT,
        confidence: 'estimated',
      })
    }
  })

  it('publishes an unknown fit with reason when the file size was not reported, without refusing the selection', async () => {
    const repository = supportedRepository()
    const result = await selectHuggingFaceGgufFile({
      huggingFace: readerFor(repository),
      hardware: HARDWARE,
      preview: preview(),
      revision: REVISION,
      filePath: 'llama-2-7b.Q8_0.gguf',
      contextLength: 8_192,
    })
    assert.equal(result.state, 'confirmed')
    if (result.state !== 'confirmed') return
    assert.deepEqual(result.fit, {
      state: 'unknown',
      contextLength: 8_192,
      basis: 'size_not_reported',
      verdict: null,
      reason: 'size_not_reported',
    })
  })

  it('keeps a provider-reported zero-byte size in the claimed-size fit path', async () => {
    const base = supportedRepository()
    assert.equal(base.files.state, 'listed')
    if (base.files.state !== 'listed') return
    const repository = supportedRepository({
      files: {
        ...base.files,
        totalFiles: 1,
        ggufFiles: [{
          path: 'empty.gguf', sizeBytes: 0,
          sizeSource: 'hugging_face_api_model',
        }],
      },
    })
    const result = await selectHuggingFaceGgufFile({
      huggingFace: readerFor(repository),
      hardware: HARDWARE,
      preview: preview(),
      revision: REVISION,
      filePath: 'empty.gguf',
      contextLength: 8_192,
    })
    assert.equal(result.state, 'confirmed')
    if (result.state !== 'confirmed' || result.fit.state !== 'calculated') return
    assert.equal(result.selection.sizeBytes, 0)
    assert.equal(result.fit.verdict.basis, 'vendor_hint')
    assert.equal(result.fit.verdict.modelBytes, 0)
    assert.equal(result.fit.verdict.requiredBytes, 0)
  })

  it('keeps fit unknown when the startup hardware profile has no usable capacity', async () => {
    const result = await selectHuggingFaceGgufFile({
      huggingFace: readerFor(supportedRepository()),
      hardware: { ...HARDWARE, usableMemoryBytes: 0 },
      preview: preview(),
      revision: REVISION,
      filePath: 'llama-2-7b.Q4_K_M.gguf',
      contextLength: 8_192,
    })
    assert.equal(result.state, 'confirmed')
    if (result.state !== 'confirmed') return
    assert.deepEqual(result.fit, {
      state: 'unknown', contextLength: 8_192,
      basis: 'hardware_capacity_unavailable', verdict: null,
      reason: 'hardware_capacity_unavailable',
    })
  })

  it('refuses a repository whose fresh verdict is unsupported', async () => {
    const repository = supportedRepository({
      files: {
        state: 'listed', source: 'hugging_face_api_model',
        totalFiles: 1, malformedEntries: 0, truncated: false, ggufFiles: [],
      },
      verdict: {
        state: 'unsupported', scope: 'exact_gguf_file_only',
        basis: 'complete_listing_without_gguf', reason: null, requiresExactFileSelection: true,
      },
    })
    const result = await selectHuggingFaceGgufFile({
      huggingFace: readerFor(repository),
      hardware: HARDWARE,
      preview: preview(),
      revision: REVISION,
      filePath: 'llama-2-7b.Q4_K_M.gguf',
      contextLength: 8_192,
    })
    assert.equal(result.state, 'refused')
    if (result.state === 'refused') assert.equal(result.reason, 'repository_not_supported')
  })

  it('refuses a repository whose fresh verdict is unknown', async () => {
    const repository = supportedRepository({
      files: {
        state: 'unknown', source: 'metadata_unavailable',
        totalFiles: null, malformedEntries: null, truncated: null, ggufFiles: [],
      },
      verdict: {
        state: 'unknown', scope: 'exact_gguf_file_only',
        basis: 'insufficient_evidence', reason: 'metadata_unavailable', requiresExactFileSelection: true,
      },
    })
    const result = await selectHuggingFaceGgufFile({
      huggingFace: readerFor(repository),
      hardware: HARDWARE,
      preview: preview(),
      revision: REVISION,
      filePath: 'llama-2-7b.Q4_K_M.gguf',
      contextLength: 8_192,
    })
    assert.equal(result.state, 'refused')
    if (result.state === 'refused') assert.equal(result.reason, 'repository_not_supported')
  })

  it('refuses a mutable/unknown fresh revision', async () => {
    const repository = supportedRepository({
      revision: { state: 'unknown', commit: null, source: 'not_reported' },
    })
    const result = await selectHuggingFaceGgufFile({
      huggingFace: readerFor(repository),
      hardware: HARDWARE,
      preview: preview(),
      revision: REVISION,
      filePath: 'llama-2-7b.Q4_K_M.gguf',
      contextLength: 8_192,
    })
    assert.equal(result.state, 'refused')
    if (result.state === 'refused') assert.equal(result.reason, 'revision_not_exact')
  })

  it('refuses when the requested commit no longer matches the fresh exact commit', async () => {
    const repository = supportedRepository()
    const result = await selectHuggingFaceGgufFile({
      huggingFace: readerFor(repository),
      hardware: HARDWARE,
      preview: preview(),
      revision: { ...REVISION, commit: OTHER_SHA },
      filePath: 'llama-2-7b.Q4_K_M.gguf',
      contextLength: 8_192,
    })
    assert.equal(result.state, 'refused')
    if (result.state === 'refused') assert.equal(result.reason, 'revision_mismatch')
  })

  it('refuses truncated or malformed fresh inventories even when they include the requested GGUF', async () => {
    const cases: Array<[
      string,
      Partial<Extract<HuggingFaceRepository['files'], { state: 'listed' }>>,
      string,
    ]> = [
      ['truncated', { truncated: true }, 'file_inventory_truncated'],
      ['malformed', { malformedEntries: 1 }, 'file_inventory_malformed'],
    ]
    for (const [label, files, reason] of cases) {
      const base = supportedRepository()
      assert.equal(base.files.state, 'listed')
      if (base.files.state !== 'listed') return
      const result = await selectHuggingFaceGgufFile({
        huggingFace: readerFor(supportedRepository({ files: { ...base.files, ...files } })),
        hardware: HARDWARE,
        preview: preview(),
        revision: REVISION,
        filePath: 'llama-2-7b.Q4_K_M.gguf',
        contextLength: 8_192,
      })
      assert.equal(result.state, 'refused', label)
      if (result.state === 'refused') assert.equal(result.reason, reason, label)
    }
  })

  it('refuses a path by name, a path from a different case, and any path absent from the fresh inventory', async () => {
    const repository = supportedRepository()
    for (const filePath of [
      'llama-2-7b.q4_k_m.gguf', // case mismatch is a different path, not the same file
      'llama-2-7b.Q5_K_M.gguf', // plausible-looking sibling that was never listed
      '../../etc/passwd.gguf',
    ]) {
      const result = await selectHuggingFaceGgufFile({
        huggingFace: readerFor(repository),
        hardware: HARDWARE,
        preview: preview(),
        revision: REVISION,
        filePath,
        contextLength: 8_192,
      })
      assert.equal(result.state, 'refused', filePath)
      if (result.state === 'refused') assert.equal(result.reason, 'file_not_in_current_inventory', filePath)
    }
  })

  it('propagates a bounded re-read failure as a typed failed result without repository facts', async () => {
    const reader: HuggingFaceRepositoryReader = {
      repository: async () => ({
        state: 'failed',
        version: 1,
        preview: preview(),
        repository: {
          version: 1, provider: 'hugging_face',
          identity: preview().identity, metadata: 'unavailable', observedAt: OBSERVED_AT,
          revision: { state: 'unknown', commit: null, source: 'not_reported' },
          gated: { state: 'unknown', mode: null },
          license: { state: 'unknown', value: null, source: 'metadata_unavailable', confidence: 'unknown' },
          files: {
            state: 'unknown', source: 'metadata_unavailable',
            totalFiles: null, malformedEntries: null, truncated: null, ggufFiles: [],
          },
          verdict: {
            state: 'unknown', scope: 'exact_gguf_file_only',
            basis: 'insufficient_evidence', reason: 'metadata_unavailable', requiresExactFileSelection: true,
          },
        },
        source: {
          state: 'unavailable', source: 'hugging_face_public_api', observedAt: OBSERVED_AT, reason: 'rate_limited',
        },
        reason: 'rate_limited',
      }),
    }
    const result = await selectHuggingFaceGgufFile({
      huggingFace: reader,
      hardware: HARDWARE,
      preview: preview(),
      revision: REVISION,
      filePath: 'llama-2-7b.Q4_K_M.gguf',
      contextLength: 8_192,
    })
    assert.deepEqual(result, {
      state: 'failed', version: 1, repository: null, selection: null, fit: null, reason: 'rate_limited',
    })
    assert.deepEqual(huggingFaceSelectionResultSchema.parse(result), result)
  })

  it('never touches gated/license state when deciding a refusal or a confirmation', async () => {
    const gatedRepository = supportedRepository({ gated: { state: 'gated', mode: 'manual' } })
    const result = await selectHuggingFaceGgufFile({
      huggingFace: readerFor(gatedRepository),
      hardware: HARDWARE,
      preview: preview(),
      revision: REVISION,
      filePath: 'llama-2-7b.Q4_K_M.gguf',
      contextLength: 8_192,
    })
    assert.equal(result.state, 'confirmed')
  })
})
