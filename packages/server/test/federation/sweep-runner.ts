/** Review 1 sweep, adapted from the supplied sweep.ts. No listeners or installed models. */
import assert from 'node:assert/strict'
import { sweep } from './sweep.ts'
const mode = process.env.MODE ?? 'mixed'
assert.ok(['mixed', 'push', 'pull'].includes(mode))
const result = sweep(Number(process.argv[2] ?? 1), Number(process.argv[3] ?? 1000), mode)
console.log(JSON.stringify({ mode, ...result }))
assert.equal(result.unsafeGrantWins, 0, 'saw-only-what-was-stored oracle: unsafe grant win')
assert.deepEqual(result.convergenceFailures, [])
assert.deepEqual(result.countFailures, [])
assert.equal(result.hlcViolations, 0)
assert.deepEqual(result.otherErrors, [])
