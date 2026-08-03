import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createThreadBody,
  listModelsQuery,
  positiveSafeIntegerSchema,
  threadOptionsSchema,
  updateSettingsBody,
  warmModelBody,
} from '@alamo/contract'
import { openDb } from '../src/store/db.ts'
import { SettingsStore } from '../src/store/settings.ts'
import { ThreadStore } from '../src/store/threads.ts'

const OLD_CEILING = 1_048_576
const CUSTOM_CONTEXT = OLD_CEILING + 1

describe('positive safe-integer context boundary', () => {
  it('accepts below, at, and above the retired product ceiling', () => {
    for (const value of [OLD_CEILING - 1, OLD_CEILING, CUSTOM_CONTEXT, Number.MAX_SAFE_INTEGER]) {
      assert.equal(positiveSafeIntegerSchema.parse(value), value)
      assert.equal(threadOptionsSchema.parse({ numCtx: value, temperature: 0, think: 'off' }).numCtx, value)
      assert.equal(createThreadBody.parse({ mode: 'chat', model: 'fixture', options: { numCtx: value } }).options?.numCtx, value)
      assert.equal(updateSettingsBody.parse({ defaultNumCtx: value }).defaultNumCtx, value)
      assert.equal(warmModelBody.parse({ contextLength: value }).contextLength, value)
      assert.equal(listModelsQuery.parse({ contextLength: String(value) }).contextLength, value)
    }
  })

  it('rejects malformed, fractional, non-positive, and unsafe values without coercion loss', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(positiveSafeIntegerSchema.safeParse(value).success, false)
    }
    for (const value of ['', '0', '-1', '1.5', String(Number.MAX_SAFE_INTEGER + 1), 'not-a-number']) {
      assert.equal(listModelsQuery.safeParse({ contextLength: value }).success, false)
    }
  })

  it('round-trips exact custom settings and thread values through SQLite', () => {
    const db = openDb(':memory:')
    try {
      const settings = new SettingsStore(db, { ollamaHost: 'http://127.0.0.1:11434' })
      const threads = new ThreadStore(db)
      assert.equal(settings.update({ defaultNumCtx: CUSTOM_CONTEXT }).defaultNumCtx, CUSTOM_CONTEXT)
      assert.equal(settings.get().defaultNumCtx, CUSTOM_CONTEXT)

      const thread = threads.create({
        title: 'custom context',
        mode: 'chat',
        model: 'fixture:latest',
        workspaceId: null,
        options: { numCtx: CUSTOM_CONTEXT, temperature: 0, think: 'off' },
      })
      assert.equal(thread.options.numCtx, CUSTOM_CONTEXT)
      assert.equal(threads.get(thread.id)?.options.numCtx, CUSTOM_CONTEXT)
      assert.equal(
        threads.update(thread.id, { options: { numCtx: CUSTOM_CONTEXT + 1 } })?.options.numCtx,
        CUSTOM_CONTEXT + 1,
      )
    } finally {
      db.close()
    }
  })
})
