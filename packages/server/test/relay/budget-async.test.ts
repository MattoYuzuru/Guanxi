import assert from 'node:assert/strict'
import { test } from 'node:test'
import { request, requestAsync, upperTokens, type AsyncMeasure, type Measure } from '../../src/relay/budget.ts'
import { window } from './fixture.ts'

/** A deterministic word tokenizer standing in for an exact remote one. */
const wordTokens = (value: string) => (value.match(/\S+/g) ?? []).length + 3
function random(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 0x100000000 } }
const words = (n: number, r: () => number) => Array.from({ length: n }, () => `t${Math.floor(r() * 1000)}`).join(' ')

test('the asynchronous packer makes exactly the decisions of the synchronous one for the same measure', async () => {
  const r = random(0x5eed)
  for (let i = 0; i < 300; i++) {
    const exact = i % 2 === 0, limit = 40 + Math.floor(r() * 3000)
    const parts = { head: [words(Math.floor(r() * 60), r), words(Math.floor(r() * 600), r)], turns: Array.from({ length: Math.floor(r() * 12) }, () => words(Math.floor(r() * 400), r)) }
    const prompt = 'prompt ' + words(Math.floor(r() * 10), r)
    const calls: string[] = [], callsAsync: string[] = []
    const sync: Measure = Object.assign((value: string) => { calls.push(value); return exact ? wordTokens(value) : upperTokens(value, window) }, { exact })
    const async_: AsyncMeasure = Object.assign(async (value: string) => { callsAsync.push(value); await Promise.resolve(); return exact ? wordTokens(value) : upperTokens(value, window) }, { exact, async: true as const })
    const attempt = <T>(run: () => T) => { try { return { ok: run() } } catch (error) { return { error: (error as Error).message } } }
    const a = attempt(() => request(prompt, parts, sync, limit))
    const b = await requestAsync(prompt, parts, async_, limit).then(ok => ({ ok }), (error: Error) => ({ error: error.message }))
    assert.deepEqual(b, a, `case ${i}`)
    assert.deepEqual(callsAsync, calls, `the same strings were measured in the same order, case ${i}`)
  }
})

test('an exact asynchronous measure never lets a packed request exceed the limit, and a failing measure fails the pack', async () => {
  const r = random(7)
  for (let i = 0; i < 100; i++) {
    const limit = 60 + Math.floor(r() * 500)
    const measure: AsyncMeasure = Object.assign(async (value: string) => wordTokens(value), { exact: true, async: true as const })
    const out = await requestAsync('head', { head: [words(300, r)], turns: Array.from({ length: 8 }, () => words(200, r)) }, measure, limit)
    assert.ok(wordTokens(out.text) <= limit, `case ${i}`)
  }
  const broken: AsyncMeasure = Object.assign(async () => { throw new Error('runtime_count_invalid') }, { exact: true, async: true as const })
  await assert.rejects(requestAsync('p', { turns: ['a'] }, broken, 100), /runtime_count_invalid/)
})
