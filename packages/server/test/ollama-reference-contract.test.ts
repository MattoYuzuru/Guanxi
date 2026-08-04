import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ollamaReferencePreviewBody,
  ollamaReferencePreviewResponse,
  ollamaReferenceStartBody,
  pullStreamEventSchema,
} from '@alamo/contract'

describe('Ollama reference contract', () => {
  it('round-trips strict preview/start and preserves legacy pull events', () => {
    assert.deepEqual(
      ollamaReferencePreviewBody.parse({ reference: 'qwen3:8b' }),
      { reference: 'qwen3:8b' },
    )
    assert.equal(
      ollamaReferencePreviewResponse.parse({
        preview: {
          inputKind: 'model_name',
          displayValue: 'qwen3:8b',
          normalizedModelName: 'qwen3:8b',
        },
      }).preview.normalizedModelName,
      'qwen3:8b',
    )
    assert.deepEqual(
      ollamaReferenceStartBody.parse({
        reference: 'qwen3:8b',
        confirmedModelName: 'qwen3:8b',
      }),
      { reference: 'qwen3:8b', confirmedModelName: 'qwen3:8b' },
    )
    assert.equal(
      pullStreamEventSchema.parse({
        type: 'done',
        seq: 1,
        data: { name: 'legacy:latest' },
      }).type,
      'done',
    )
  })

  it('rejects unknown fields and future input kinds', () => {
    assert.equal(
      ollamaReferencePreviewBody.safeParse({ reference: 'qwen3', fetch: true }).success,
      false,
    )
    assert.equal(
      ollamaReferenceStartBody.safeParse({
        reference: 'qwen3',
        confirmedModelName: 'qwen3:latest',
        insecure: true,
      }).success,
      false,
    )
    assert.equal(
      ollamaReferencePreviewResponse.safeParse({
        preview: {
          inputKind: 'future',
          displayValue: 'qwen3',
          normalizedModelName: 'qwen3:latest',
        },
      }).success,
      false,
    )
  })
})
