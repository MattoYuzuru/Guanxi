import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildContextState, PrefillTracker } from '../src/context/usage.ts'

describe('PrefillTracker', () => {
  it('подтверждает структурно известный префикс по времени', () => {
    const tracker = new PrefillTracker()

    assert.deepEqual(
      tracker.evaluate({
        model: 'qwen',
        promptTokens: 100,
        promptEvalMs: 500,
        expectedPrefixTokens: 0,
      }),
      { cacheHit: false, cachedTokens: 0 },
    )

    assert.deepEqual(
      tracker.evaluate({
        model: 'qwen',
        promptTokens: 120,
        promptEvalMs: 100,
        expectedPrefixTokens: 94,
      }),
      { cacheHit: true, cachedTokens: 94 },
    )
  })

  it('не объявляет кэш без переиспользуемого префикса', () => {
    const tracker = new PrefillTracker()
    tracker.evaluate({
      model: 'qwen',
      promptTokens: 100,
      promptEvalMs: 500,
      expectedPrefixTokens: 0,
    })

    assert.deepEqual(
      tracker.evaluate({
        model: 'qwen',
        promptTokens: 100,
        promptEvalMs: 20,
        expectedPrefixTokens: 0,
      }),
      { cacheHit: false, cachedTokens: 0 },
    )
  })
})

describe('buildContextState', () => {
  it('возвращает процент в диапазоне 0..100 и включает компакцию после 60%', () => {
    const context = buildContextState({
      usedTokens: 700,
      allocatedTokens: 1_000,
      usage: null,
      model: 'qwen',
      tracker: new PrefillTracker(),
    })

    assert.equal(context.percent, 70)
    assert.equal(context.compactable, true)
  })
})
