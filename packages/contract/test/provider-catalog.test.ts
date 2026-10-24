import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  connectionProviderSchema, createConnectionSchema,
  providerCatalog, providerCategoryOrder, providerCategorySchema,
} from '../src/connections/index.ts'

test('provider catalog has exactly one valid entry per provider', () => {
  const providers = connectionProviderSchema.options
  assert.equal(providerCatalog.length, providers.length)
  assert.deepEqual(providerCatalog.map(item => item.provider).sort(), [...providers].sort())
  assert.equal(new Set(providerCatalog.map(item => item.provider)).size, providers.length)
  for (const item of providerCatalog) {
    const parsed = createConnectionSchema.safeParse({
      name: item.label, kind: item.kind, provider: item.provider, auth: item.auth,
    })
    assert.equal(parsed.success, true, `${item.provider}: ${item.kind}/${item.auth} is not a supported connection route`)
    assert.ok(item.label.length > 0)
    if (item.docsUrl !== null) assert.doesNotThrow(() => new URL(item.docsUrl!))
  }
  assert.equal(Object.isFrozen(providerCatalog), true)
  assert.ok(providerCatalog.every(item => Object.isFrozen(item)))
})

test('provider categories have one stable display order', () => {
  const categories = providerCategorySchema.options
  assert.deepEqual([...providerCategoryOrder], ['llm_api', 'local_runtime', 'agent_subscription', 'search', 'speech'])
  assert.deepEqual([...providerCategoryOrder].sort(), [...categories].sort())
  assert.equal(new Set(providerCategoryOrder).size, categories.length)
})

test('catalog key hints name the credential families the stored modes accept', () => {
  const hint = (provider: string) => providerCatalog.find(item => item.provider === provider)!.keyHint
  assert.equal(hint('anthropic'), 'starts with sk-ant-api or sk-ant-usr')
  assert.equal(hint('claude-code'), 'starts with sk-ant-oat')
})

test('catalog key hints describe formats without containing key material', () => {
  for (const item of providerCatalog) {
    if (item.keyHint === null) continue
    assert.equal(/sk-[A-Za-z0-9_-]{12,}/.test(item.keyHint), false, `${item.provider} key hint looks like a key`)
  }
})
