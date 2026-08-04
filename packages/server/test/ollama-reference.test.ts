import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  normalizeOllamaReference,
  OllamaReferenceError,
} from '../src/models/ollama-reference.ts'

describe('strict local Ollama reference normalization', () => {
  it('accepts documented base, tag, namespace and canonical case variants', () => {
    const cases = new Map([
      ['qwen3', 'qwen3:latest'],
      ['qwen3:8b', 'qwen3:8b'],
      ['mavryk/magistral-small-2509', 'mavryk/magistral-small-2509:latest'],
      ['MAVRYK/Magistral-Small-2509:Q4_K_M', 'mavryk/magistral-small-2509:q4_k_m'],
    ])
    for (const [input, expected] of cases) {
      const preview = normalizeOllamaReference(input)
      assert.equal(preview.inputKind, 'model_name')
      assert.equal(preview.displayValue, input)
      assert.equal(preview.normalizedModelName, expected)
      assert.deepEqual(Object.keys(preview).sort(), [
        'displayValue', 'inputKind', 'normalizedModelName',
      ])
    }
  })

  it('maps only exact official HTTPS model page shapes to the same name', () => {
    assert.equal(
      normalizeOllamaReference('https://ollama.com/library/qwen3:8b').normalizedModelName,
      'qwen3:8b',
    )
    assert.equal(
      normalizeOllamaReference('https://ollama.com/mavryk/magistral-small-2509')
        .normalizedModelName,
      'mavryk/magistral-small-2509:latest',
    )
  })

  it('rejects arbitrary, ambiguous, traversal, encoded and unsafe references', () => {
    const rejected = [
      '', ' qwen3', 'qwen3 ', 'qwen 3', 'qwen\t3', 'qwen\n3', 'qwen\u0000',
      '//ollama.com/library/qwen3', '../qwen3', 'team/../qwen3', 'a/b/c',
      'qwen3@sha256:abc', 'https://example.com/library/qwen3',
      'https://models.ollama.com/library/qwen3', 'https://ollama.com.evil.test/library/qwen3',
      'http://ollama.com/library/qwen3', 'https://127.0.0.1/library/qwen3',
      'https://localhost/library/qwen3', 'https://user:pass@ollama.com/library/qwen3',
      'https://ollama.com:443/library/qwen3', 'https://ollama.com/library/qwen3?q=x',
      'https://ollama.com/library/qwen3#x', 'https://ollama.com/library/qwen3/',
      'https://ollama.com/library/a/b', 'https://ollama.com/library/%2e%2e',
      'https://ollama.com/library/team%2Fmodel', 'https://ollama.com\\@evil.test/library/qwen3',
      'ftp://ollama.com/library/qwen3', 'file:///private/model',
    ]
    for (const input of rejected) {
      assert.throws(
        () => normalizeOllamaReference(input),
        (error) => error instanceof OllamaReferenceError,
        input,
      )
    }
  })
})
