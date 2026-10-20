import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { huggingFaceReferencePreviewSchema } from '@guanxi/contract'
import {
  HuggingFaceReferenceError,
  normalizeHuggingFaceReference,
} from '../src/models/hugging-face-reference.ts'

describe('strict local Hugging Face repository identity normalization', () => {
  it('accepts bare owner/name and preserves the case-sensitive Hub path', () => {
    const preview = normalizeHuggingFaceReference('TheBloke/Llama-2-7B-GGUF')
    assert.equal(preview.inputKind, 'repository_id')
    assert.equal(preview.displayValue, 'TheBloke/Llama-2-7B-GGUF')
    assert.equal(preview.identity.provider, 'hugging_face')
    assert.equal(preview.identity.owner, 'TheBloke')
    assert.equal(preview.identity.name, 'Llama-2-7B-GGUF')
    // Hub paths are case-sensitive: the exact input case must survive.
    assert.equal(preview.identity.repositoryId, 'TheBloke/Llama-2-7B-GGUF')
    assert.equal(preview.identity.comparisonKey, 'thebloke/llama-2-7b-gguf')
    assert.deepEqual(Object.keys(preview).sort(), [
      'displayValue', 'identity', 'inputKind',
    ])
    // The published shape is exactly the contract shape, with no extra field.
    assert.deepEqual(huggingFaceReferencePreviewSchema.parse(preview), preview)
  })

  it('maps an exact HTTPS model page to the same identity as its repository id', () => {
    const fromUrl = normalizeHuggingFaceReference(
      'https://huggingface.co/TheBloke/Llama-2-7B-GGUF',
    )
    assert.equal(fromUrl.inputKind, 'model_page_url')
    assert.equal(fromUrl.displayValue, 'https://huggingface.co/TheBloke/Llama-2-7B-GGUF')
    assert.deepEqual(
      fromUrl.identity,
      normalizeHuggingFaceReference('TheBloke/Llama-2-7B-GGUF').identity,
    )
  })

  it('accepts documented dot, underscore and digit component shapes', () => {
    for (const input of [
      'openai/whisper-large-v3',
      'user_1/model_name',
      'org.ai/model.v2',
      'a/b',
      'Qwen/Qwen2.5-7B-Instruct-GGUF',
    ]) {
      const preview = normalizeHuggingFaceReference(input)
      assert.equal(preview.identity.repositoryId, input, input)
      assert.equal(preview.identity.comparisonKey, input.toLowerCase(), input)
    }
  })

  it('folds only case for the local comparison key and never for the Hub path', () => {
    const upper = normalizeHuggingFaceReference('OWNER/MODEL')
    const lower = normalizeHuggingFaceReference('owner/model')
    assert.equal(upper.identity.comparisonKey, lower.identity.comparisonKey)
    assert.notEqual(upper.identity.repositoryId, lower.identity.repositoryId)
    assert.equal(upper.identity.repositoryId, 'OWNER/MODEL')
  })

  it('fails closed for whitespace, control, credential, port, traversal and lookalike input', () => {
    const rejected = [
      // empty and ambiguous whitespace/control
      '',
      ' TheBloke/model',
      'TheBloke/model ',
      'TheBloke /model',
      'TheBloke\t/model',
      'TheBloke\n/model',
      'TheBloke/mo del',
      'TheBloke/model\u0000',
      'TheBloke/model\u007f',
      // NFKC-normalizable lookalike text
      'ＴheBloke/model',
      // protocol-relative and non-HTTPS schemes
      '//huggingface.co/TheBloke/model',
      'http://huggingface.co/TheBloke/model',
      'ftp://huggingface.co/TheBloke/model',
      'file:///private/model',
      // arbitrary, foreign and lookalike hosts
      'https://example.com/TheBloke/model',
      'https://huggingface.co.evil.test/TheBloke/model',
      'https://evil.test/huggingface.co/TheBloke/model',
      'https://hugging-face.co/TheBloke/model',
      'https://www.huggingface.co/TheBloke/model',
      'https://HUGGINGFACE.CO.evil.test/TheBloke/model',
      'https://127.0.0.1/TheBloke/model',
      'https://localhost/TheBloke/model',
      // credentials and ports
      'https://user:pass@huggingface.co/TheBloke/model',
      'https://huggingface.co:443/TheBloke/model',
      'https://huggingface.co:8443/TheBloke/model',
      'https://huggingface.co\\@evil.test/TheBloke/model',
      // query and fragment
      'https://huggingface.co/TheBloke/model?x=1',
      'https://huggingface.co/TheBloke/model#section',
      // encoded separators and traversal
      'https://huggingface.co/TheBloke%2Fmodel',
      'https://huggingface.co/%2e%2e/model',
      'https://huggingface.co/TheBloke/../model',
      'https://huggingface.co/TheBloke/./model',
      'TheBloke%2Fmodel',
      '../TheBloke/model',
      'TheBloke/../model',
      'TheBloke\\model',
      // wrong arity and empty segments
      'model-without-owner',
      'TheBloke/model/extra',
      'TheBloke//model',
      '/TheBloke/model',
      'TheBloke/model/',
      '/',
      '//',
      'TheBloke/',
      '/model',
      // component boundary shapes
      '.hidden/model',
      'TheBloke/.hidden',
      'owner-/model',
      'owner/model-',
      'owner/model.',
      // Hub site routes that are not repository owners
      'datasets/squad',
      'spaces/demo',
      'models/gpt2',
      'https://huggingface.co/datasets/squad',
      'https://huggingface.co/settings/tokens',
      // revision/file suffixes are out of this slice's grammar
      'TheBloke/model:main',
      'TheBloke/model@abc123',
      'https://huggingface.co/TheBloke/model/tree/main',
      'https://huggingface.co/TheBloke/model/blob/main/x.gguf',
      'https://huggingface.co/TheBloke/model/resolve/main/x.gguf',
    ]
    for (const input of rejected) {
      assert.throws(
        () => normalizeHuggingFaceReference(input),
        (error) => error instanceof HuggingFaceReferenceError,
        input,
      )
    }
  })

  it('reports a typed reason for each refusal class', () => {
    const expected = new Map([
      ['', 'empty'],
      [' owner/model', 'ambiguous_input'],
      ['owner/mo del', 'ambiguous_input'],
      ['//huggingface.co/owner/model', 'ambiguous_input'],
      ['owner', 'invalid_repository_id'],
      ['owner/model/extra', 'invalid_repository_id'],
      ['owner%2Fmodel', 'invalid_repository_id'],
      ['https://example.com/owner/model', 'invalid_model_page_url'],
      ['https://huggingface.co:443/owner/model', 'invalid_model_page_url'],
      ['https://huggingface.co/owner/model?x=1', 'invalid_model_page_url'],
    ])
    for (const [input, reason] of expected) {
      assert.throws(
        () => normalizeHuggingFaceReference(input),
        (error) =>
          error instanceof HuggingFaceReferenceError && error.reason === reason,
        `${input} → ${reason}`,
      )
    }
  })

  it('performs no host, network or filesystem access while parsing', async () => {
    // A parser that resolved anything would have to reach one of these globals.
    const originalFetch = globalThis.fetch
    let touched = false
    globalThis.fetch = (() => {
      touched = true
      throw new Error('the identity parser must not perform network access')
    }) as typeof fetch
    try {
      normalizeHuggingFaceReference('TheBloke/Llama-2-7B-GGUF')
      normalizeHuggingFaceReference('https://huggingface.co/TheBloke/Llama-2-7B-GGUF')
      assert.throws(() => normalizeHuggingFaceReference('https://evil.test/a/b'))
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.equal(touched, false)
  })
})
