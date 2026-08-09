import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  huggingFaceGgufPathSchema,
  huggingFaceSelectionBody,
  huggingFaceSelectionFitPreviewSchema,
  huggingFaceSelectionResultSchema,
} from '@alamo/contract'

const SHA = 'a'.repeat(40)
const CALCULATED_AT = '2026-08-08T12:00:01.000Z'
const HARDWARE_EVIDENCE = {
  source: 'application_startup_hardware_probe' as const,
  observedAt: '2026-08-08T11:59:00.000Z',
  confidence: 'estimated' as const,
}

const VALID_FIT = {
  level: 'green' as const,
  summary: 'fits',
  contextLength: 8_192,
  modelBytes: 1,
  kvCacheBytes: 0,
  requiredBytes: 1,
  usableBytes: 100,
  utilization: 0.01,
  basis: 'vendor_hint' as const,
  measured: null,
}

const REPOSITORY = {
  version: 1 as const,
  provider: 'hugging_face' as const,
  identity: {
    provider: 'hugging_face' as const,
    owner: 'TheBloke',
    name: 'Llama-2-7B-GGUF',
    repositoryId: 'TheBloke/Llama-2-7B-GGUF',
    comparisonKey: 'thebloke/llama-2-7b-gguf',
  },
  metadata: 'resolved' as const,
  observedAt: '2026-08-08T12:00:00.000Z',
  revision: { state: 'exact_commit' as const, commit: SHA, source: 'hugging_face_api_model' as const },
  gated: { state: 'open' as const, mode: null },
  license: {
    state: 'declared' as const, value: 'apache-2.0',
    source: 'hugging_face_model_tags' as const, confidence: 'declared' as const,
  },
  files: {
    state: 'listed' as const, source: 'hugging_face_api_model' as const,
    totalFiles: 1, malformedEntries: 0, truncated: false,
    ggufFiles: [{ path: 'x.gguf', sizeBytes: 1, sizeSource: 'hugging_face_api_model' as const }],
  },
  verdict: {
    state: 'supported' as const, scope: 'exact_gguf_file_only' as const,
    basis: 'exact_gguf_files_listed' as const, reason: null, requiresExactFileSelection: true as const,
  },
}

describe('P2-K Hugging Face selection contract', () => {
  it('round-trips a strict selection request body', () => {
    assert.deepEqual(
      huggingFaceSelectionBody.parse({
        identity: REPOSITORY.identity,
        revision: REPOSITORY.revision,
        filePath: 'llama-2-7b.Q4_K_M.gguf',
        contextLength: 8_192,
      }),
      {
        identity: REPOSITORY.identity,
        revision: REPOSITORY.revision,
        filePath: 'llama-2-7b.Q4_K_M.gguf',
        contextLength: 8_192,
      },
    )
  })

  it('rejects an extra field, a non-hex commit and an uppercase-hex commit', () => {
    const base = {
      identity: REPOSITORY.identity,
      revision: REPOSITORY.revision,
      filePath: 'x.gguf',
      contextLength: 1,
    }
    assert.equal(huggingFaceSelectionBody.safeParse({ ...base, extra: 1 }).success, false)
    assert.equal(
      huggingFaceSelectionBody.safeParse({
        ...base, revision: { ...base.revision, commit: 'z'.repeat(40) },
      }).success,
      false,
    )
    assert.equal(
      huggingFaceSelectionBody.safeParse({
        ...base, revision: { ...base.revision, commit: 'A'.repeat(40) },
      }).success,
      false,
    )
    assert.equal(
      huggingFaceSelectionBody.safeParse({ ...base, contextLength: 0 }).success,
      false,
    )
    for (const revision of [
      { state: 'branch', name: 'main', source: 'user' },
      { state: 'unknown', commit: null, source: 'not_reported' },
    ]) {
      assert.equal(huggingFaceSelectionBody.safeParse({ ...base, revision }).success, false)
    }
  })

  it('rejects a traversal, absolute, backslash, oversized, control-character or suffixless GGUF path', () => {
    const hostile = [
      '../secret.gguf',
      '/etc/passwd.gguf',
      'dir\\model.gguf',
      `${'a'.repeat(1021)}.gguf`,
      'model\u0000.gguf',
      'model.bin',
      'a//b.gguf',
      './model.gguf',
      '../model.gguf',
      '%2e%2e/secret.gguf',
      'dir/%2E%2E/secret.gguf',
      'dir%2fmodel.gguf',
      'dir%5cmodel.gguf',
      'model?download.gguf',
      'model#fragment.gguf',
      'C:/Windows/System32/model.gguf',
      'C:relative.gguf',
      'model.gguf:stream.gguf',
      '.. /model.gguf',
      'model. /child.gguf',
      'model./child.gguf',
      'model\u0085.gguf',
    ]
    for (const path of hostile) {
      assert.equal(huggingFaceGgufPathSchema.safeParse(path).success, false, path)
    }
    assert.equal(huggingFaceGgufPathSchema.safeParse('quant/model.Q4_K_M.GGUF').success, true)
  })

  it('accepts a confirmed selection result and rejects a calculated fit with a non-vendor_hint basis', () => {
    const confirmed = {
      state: 'confirmed' as const,
      version: 1 as const,
      repository: REPOSITORY,
      selection: {
        identity: REPOSITORY.identity,
        revision: REPOSITORY.revision,
        filePath: 'x.gguf',
        sizeBytes: 1,
        sizeSource: 'hugging_face_api_model' as const,
      },
      fit: {
        state: 'calculated' as const,
        contextLength: 8_192,
        basis: 'reported_file_size_only' as const,
        calculatedAt: CALCULATED_AT,
        hardware: HARDWARE_EVIDENCE,
        verdict: VALID_FIT,
      },
      reason: null,
    }
    assert.deepEqual(huggingFaceSelectionResultSchema.parse(confirmed), confirmed)

    const measuredFit = { ...confirmed, fit: { ...confirmed.fit, verdict: { ...VALID_FIT, basis: 'measured' as const } } }
    assert.equal(huggingFaceSelectionResultSchema.safeParse(measuredFit).success, false)

    const incoherentVerdicts = [
      { ...VALID_FIT, measured: { sizeBytes: 1, gpuPercent: 100, processorLabel: '100% GPU' } },
      { ...VALID_FIT, kvCacheBytes: 1 },
      { ...VALID_FIT, requiredBytes: 2 },
      { ...VALID_FIT, utilization: 0 },
      { ...VALID_FIT, level: 'red' as const },
    ]
    for (const verdict of incoherentVerdicts) {
      assert.equal(
        huggingFaceSelectionResultSchema.safeParse({
          ...confirmed, fit: { ...confirmed.fit, verdict },
        }).success,
        false,
      )
    }
    const { hardware: _hardware, ...withoutHardware } = confirmed.fit
    assert.equal(
      huggingFaceSelectionResultSchema.safeParse({
        ...confirmed, fit: withoutHardware,
      }).success,
      false,
    )
  })

  it('rejects a size and its source reported inconsistently, in both the file selection and the file inventory', () => {
    assert.equal(
      huggingFaceSelectionFitPreviewSchema.safeParse({
        state: 'unknown',
        contextLength: 8_192,
        basis: 'size_not_reported',
        verdict: null,
        reason: 'size_not_reported',
      }).success,
      true,
    )
    const confirmedWithMismatchedSize = {
      state: 'confirmed' as const,
      version: 1 as const,
      repository: REPOSITORY,
      selection: {
        identity: REPOSITORY.identity,
        revision: REPOSITORY.revision,
        filePath: 'x.gguf',
        sizeBytes: null,
        sizeSource: 'hugging_face_api_model' as const, // inconsistent with a null size
      },
      fit: {
        state: 'unknown' as const,
        contextLength: 8_192,
        basis: 'size_not_reported' as const,
        verdict: null,
        reason: 'size_not_reported' as const,
      },
      reason: null,
    }
    assert.equal(huggingFaceSelectionResultSchema.safeParse(confirmedWithMismatchedSize).success, false)
  })

  it('rejects a refused/failed result that still carries selection or fit facts', () => {
    assert.equal(
      huggingFaceSelectionResultSchema.safeParse({
        state: 'refused', version: 1, repository: REPOSITORY,
        selection: {
          identity: REPOSITORY.identity, revision: REPOSITORY.revision, filePath: 'x.gguf',
          sizeBytes: 1, sizeSource: 'hugging_face_api_model',
        },
        fit: null, reason: 'repository_not_supported',
      }).success,
      false,
    )
    assert.equal(
      huggingFaceSelectionResultSchema.safeParse({
        state: 'failed', version: 1, repository: REPOSITORY, selection: null, fit: null, reason: 'rate_limited',
      }).success,
      false,
      'a failed re-read cannot echo repository facts it never obtained',
    )
  })

  it('rejects a confirmed result whose identity, revision, file facts or fit basis drift from the repository', () => {
    const confirmed = {
      state: 'confirmed' as const,
      version: 1 as const,
      repository: REPOSITORY,
      selection: {
        identity: REPOSITORY.identity,
        revision: REPOSITORY.revision,
        filePath: 'x.gguf',
        sizeBytes: 1,
        sizeSource: 'hugging_face_api_model' as const,
      },
      fit: {
        state: 'calculated' as const,
        contextLength: 8_192,
        basis: 'reported_file_size_only' as const,
        calculatedAt: CALCULATED_AT,
        hardware: HARDWARE_EVIDENCE,
        verdict: VALID_FIT,
      },
      reason: null,
    }
    const mismatches = [
      {
        ...confirmed,
        selection: {
          ...confirmed.selection,
          identity: {
            ...REPOSITORY.identity,
            owner: 'Other',
            repositoryId: 'Other/Llama-2-7B-GGUF',
            comparisonKey: 'other/llama-2-7b-gguf',
          },
        },
      },
      {
        ...confirmed,
        selection: {
          ...confirmed.selection,
          revision: { ...REPOSITORY.revision, commit: 'b'.repeat(40) },
        },
      },
      { ...confirmed, selection: { ...confirmed.selection, filePath: 'other.gguf' } },
      { ...confirmed, selection: { ...confirmed.selection, sizeBytes: 2 } },
      { ...confirmed, fit: { ...confirmed.fit, verdict: { ...VALID_FIT, modelBytes: 2 } } },
      { ...confirmed, fit: { ...confirmed.fit, contextLength: 16_384 } },
    ]
    for (const mismatch of mismatches) {
      assert.equal(huggingFaceSelectionResultSchema.safeParse(mismatch).success, false)
    }
  })

  it('rejects a future/unknown state and an unknown refusal reason', () => {
    assert.equal(
      huggingFaceSelectionResultSchema.safeParse({
        state: 'future', version: 1, repository: null, selection: null, fit: null, reason: null,
      }).success,
      false,
    )
    assert.equal(
      huggingFaceSelectionResultSchema.safeParse({
        state: 'refused', version: 1, repository: REPOSITORY, selection: null, fit: null,
        reason: 'not_a_real_reason',
      }).success,
      false,
    )
  })
})
