import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SecretScrubber } from '../src/egress/scrubber.ts'
import { redactionMarker } from '../src/egress/types.ts'

for (const [label, value, formIndex] of [
  ['raw', 'xySECRET-end', 0],
  ['JSON', 'xy"\\\nSECRET-end', 1],
  ['URI', 'xy/ éSECRET-end', 2],
] as const) test(`known-truncated ${label} protects every proper-prefix length and complete occurrences`, () => {
  const scrubber = new SecretScrubber(), ref = 'secret://test/prefix'
  scrubber.register(ref, value)
  const form = formIndex === 0 ? value : formIndex === 1 ? JSON.stringify(value).slice(1, -1) : encodeURIComponent(value)
  assert.ok(form)
  for (let length = 1; length < form.length; length++) {
    assert.equal(scrubber.scrubTruncatedPrefix(`safe ${form.slice(0, length)}`), `safe ${redactionMarker(ref)}`, `${label} length ${length}`)
  }
  assert.equal(scrubber.scrubTruncatedPrefix(`safe ${form} other`), `safe ${redactionMarker(ref)} other`)
  assert.equal(scrubber.scrub('safe x'), 'safe x', 'ordinary exact semantics do not infer truncation')
})

test('boundary matches merge overlapping complete and partial occurrences using existing marker refs', () => {
  const scrubber = new SecretScrubber()
  scrubber.register('secret://test/first', 'abcdefghijkl')
  scrubber.register('secret://test/second', 'ijklmnop')
  assert.equal(scrubber.scrubTruncatedPrefix('safe abcdefghijklmn'),
    'safe ' + redactionMarker('secret://test/first') + redactionMarker('secret://test/second'))
  assert.equal(scrubber.scrubTruncatedPrefix('safe abcdefghij'), 'safe ' + redactionMarker('secret://test/first') + redactionMarker('secret://test/second'))
})

test('long repetitive forms, rotation and unregister refresh only private cached prefix data', () => {
  const scrubber = new SecretScrubber(), ref = 'secret://test/rotating'
  scrubber.register(ref, 'ab'.repeat(17000) + 'c')
  assert.equal(scrubber.scrubTruncatedPrefix('ab'.repeat(4096)), redactionMarker(ref))
  scrubber.register(ref, 'xyreplacement')
  assert.equal(scrubber.scrubTruncatedPrefix('safe a'), 'safe a')
  assert.equal(scrubber.scrubTruncatedPrefix('safe x'), 'safe ' + redactionMarker(ref))
  assert.equal(scrubber.unregister(ref), true)
  assert.equal(scrubber.scrubTruncatedPrefix('safe x'), 'safe x')
  assert.equal(Object.hasOwn(scrubber.facade(), 'forms'), false)
  scrubber.close()
  assert.throws(() => scrubber.scrubTruncatedPrefix('safe x'), { code: 'closed' })
})

test('KMP boundary matching agrees with a naive suffix oracle on periodic inputs', () => {
  for (const value of ['aaaaaaaa', 'abababab', 'abcababc', 'aabaaaab']) {
    const scrubber = new SecretScrubber(), ref = 'secret://test/oracle'
    scrubber.register(ref, value)
    for (let bits = 0; bits < 256; bits++) {
      const input = Array.from({ length: 8 }, (_, n) => (bits >> n) & 1 ? 'a' : 'b').join('')
      let length = 0
      for (let n = 1; n <= input.length; n++) if (input.endsWith(value.slice(0, n))) length = n
      const expected = length ? input.slice(0, -length) + redactionMarker(ref) : input
      assert.equal(scrubber.scrubTruncatedPrefix(input), expected)
    }
  }
})
