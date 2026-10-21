/**
 * K2 egress scrubber core: exact-match redaction, bounds, fail-closed lifetime
 * and the kernel service facade. Every secret here is a generated fake.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { createKernel, definePlugin, service } from '@guanxi/kernel'
import {
  EGRESS_SCRUBBER_SERVICE,
  EgressScrubberError,
  egressScrubberPlugin,
  formsOf,
  redactionMarker,
  type EgressScrubber,
  type SecretRef,
} from '../src/egress/index.ts'
import { SecretScrubber } from '../src/egress/scrubber.ts'

function fakeSecret(prefix = 'fake-'): string {
  return `${prefix}${randomBytes(12).toString('hex')}`
}

function errorCode(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof EgressScrubberError, `expected EgressScrubberError, got ${String(error)}`)
    return error.code
  }
  assert.fail('expected the call to throw')
}

describe('egress scrubber: exact-match redaction', () => {
  it('redacts every occurrence of the raw, JSON-escaped and URI-encoded forms', () => {
    const scrubber = new SecretScrubber()
    const value = `${fakeSecret()}"/ +&`
    scrubber.register('secret://test/a', value)
    const marker = redactionMarker('secret://test/a')
    const jsonForm = JSON.stringify(value).slice(1, -1)
    const uriForm = encodeURIComponent(value)
    assert.notEqual(jsonForm, value)
    assert.notEqual(uriForm, value)

    const text = `a ${value} b ${value} c ${jsonForm} d ${uriForm} e`
    const scrubbed = scrubber.scrub(text)
    assert.equal(scrubbed, `a ${marker} b ${marker} c ${marker} d ${marker} e`)
    for (const form of formsOf(value)) assert.equal(scrubbed.includes(form), false)
  })

  it('scrubs a serialized structure whose value needed JSON escaping', () => {
    const scrubber = new SecretScrubber()
    const value = `${fakeSecret()}\\"quoted"`
    scrubber.register('secret://test/json', value)
    const serialized = JSON.stringify({ header: `Bearer ${value}` })
    assert.equal(serialized.includes(value), false, 'the raw form is not in the serialized text')
    const scrubbed = scrubber.scrub(serialized)
    assert.equal(scrubbed.includes(JSON.stringify(value).slice(1, -1)), false)
    assert.deepEqual(JSON.parse(scrubbed), { header: `Bearer ${redactionMarker('secret://test/json')}` })
  })

  it('copies nested structures, scrubbing keys and values, without mutating the input', () => {
    const scrubber = new SecretScrubber()
    const value = fakeSecret()
    scrubber.register('secret://test/nested', value)
    const marker = redactionMarker('secret://test/nested')
    const date = new Date('2026-10-20T10:00:00.000Z')
    const input = {
      [value]: 'key holds the value',
      list: [value, 1, true, null, undefined, 3n, { deep: `x${value}y` }],
      when: date,
      bytes: Buffer.from(`pre ${value} post`),
      plain: new Uint8Array(Buffer.from(value)),
      bare: Object.assign(Object.create(null) as Record<string, string>, { v: value }),
    }
    const serialize = (value: unknown) =>
      JSON.stringify(value, (_key, item: unknown) => {
        if (typeof item === 'bigint') return `${item}n`
        if (item instanceof Uint8Array) return [...item]
        return item === undefined ? '<undefined>' : item
      })
    const snapshot = serialize(input)
    const output = scrubber.scrub(input)

    assert.deepEqual(Object.keys(output).sort(), [marker, 'bare', 'bytes', 'list', 'plain', 'when'].sort())
    assert.deepEqual(output.list.slice(0, 6), [marker, 1, true, null, undefined, 3n])
    assert.deepEqual(output.list[6], { deep: `x${marker}y` })
    assert.notEqual(output.when, date)
    assert.equal(output.when.getTime(), date.getTime())
    assert.ok(Buffer.isBuffer(output.bytes))
    assert.equal(output.bytes.toString('utf8'), `pre ${marker} post`)
    assert.equal(Buffer.isBuffer(output.plain), false)
    assert.ok(output.plain instanceof Uint8Array)
    assert.equal(Buffer.from(output.plain).toString('utf8'), marker)
    assert.equal(Object.getPrototypeOf(output.bare), null)
    assert.equal(output.bare['v'], marker)

    assert.equal(serialize(input), snapshot, 'the input is not mutated')
    assert.equal(serialize(output).includes(value), false)
  })

  it('refuses values it cannot traverse instead of passing them through', () => {
    const scrubber = new SecretScrubber()
    scrubber.register('secret://test/types', fakeSecret())
    class Holder {
      value = 'v'
    }
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    for (const value of [
      new Map([['k', 'v']]),
      new Set(['v']),
      new Holder(),
      () => 'v',
      Symbol('v'),
      new Uint16Array(4),
      new ArrayBuffer(4),
      cyclic,
      [cyclic],
    ]) {
      assert.equal(errorCode(() => scrubber.scrub(value)), 'unsupported_value')
    }
    const shared = { v: 'x' }
    assert.deepEqual(scrubber.scrub([shared, shared]), [{ v: 'x' }, { v: 'x' }], 'a repeated non-cyclic reference is fine')
  })

  it('merges overlapping occurrences into side-by-side single-ref markers', () => {
    const scrubber = new SecretScrubber()
    scrubber.register('secret://test/left', 'abcdef12')
    scrubber.register('secret://test/right', 'ef123456')
    const scrubbed = scrubber.scrub('>abcdef123456<')
    assert.equal(
      scrubbed,
      `>${redactionMarker('secret://test/left')}${redactionMarker('secret://test/right')}<`,
    )
  })

  it('never returns a registered form, and chunks scrubbed apart cannot re-form one', () => {
    const alphabet = 'ab12-_ /'
    let seed = 7
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed % n
    }
    const randomText = (length: number) =>
      Array.from({ length }, () => alphabet[random(alphabet.length)]).join('')
    for (let round = 0; round < 300; round++) {
      const scrubber = new SecretScrubber()
      const values = Array.from({ length: 1 + random(4) }, () => randomText(8 + random(5)))
      values.forEach((value, index) => {
        try {
          scrubber.register(`secret://fuzz/${index}`, value)
        } catch (error) {
          assert.ok(error instanceof EgressScrubberError)
        }
      })
      const text = Array.from({ length: 6 }, () =>
        random(2) === 0 ? values[random(values.length)]! : randomText(random(20)),
      ).join('')
      const whole = scrubber.scrub(text)
      const forms = values.flatMap(formsOf)
      for (const form of forms) {
        if (registeredForm(scrubber, form)) assert.equal(whole.includes(form), false, `round ${round}`)
      }
      // Split only at cuts no occurrence straddles; the joined output still has none.
      const cut = safeCut(scrubber, text, forms)
      if (cut !== null) {
        const joined = scrubber.scrub(text.slice(0, cut)) + scrubber.scrub(text.slice(cut))
        for (const form of forms) {
          if (registeredForm(scrubber, form)) assert.equal(joined.includes(form), false, `round ${round} cut ${cut}`)
        }
      }
    }
  })
})

function registeredForm(scrubber: SecretScrubber, form: string): boolean {
  return scrubber.scrub(form) !== form
}

function safeCut(scrubber: SecretScrubber, text: string, forms: string[]): number | null {
  for (let cut = Math.floor(text.length / 2); cut < text.length; cut++) {
    const straddles = forms.some((form) => {
      if (!registeredForm(scrubber, form)) return false
      for (let i = text.indexOf(form); i >= 0; i = text.indexOf(form, i + 1)) {
        if (i < cut && i + form.length > cut) return true
      }
      return false
    })
    if (!straddles) return cut
  }
  return null
}

describe('egress scrubber: registration bounds', () => {
  it('refuses malformed refs and out-of-bounds values without echoing the value', () => {
    const scrubber = new SecretScrubber()
    const value = fakeSecret()
    for (const ref of ['vault/a', 'secret://', 'secret://has space', 'secret://a,b', `secret://${'x'.repeat(241)}`]) {
      assert.equal(errorCode(() => scrubber.register(ref as SecretRef, value)), 'invalid_ref')
    }
    const refused = ['short1', 'x'.repeat(65_537), `${fakeSecret()}⟦`, `${fakeSecret()}⟧`, 42]
    for (const bad of refused) {
      let message = ''
      try {
        scrubber.register('secret://test/bounds', bad as string)
      } catch (error) {
        assert.ok(error instanceof EgressScrubberError)
        assert.equal(error.code, 'invalid_value')
        message = error.message
      }
      assert.ok(message.length > 0)
      if (typeof bad === 'string') assert.equal(message.includes(bad), false)
    }
    assert.equal(scrubber.size, 0)
  })

  it('refuses a value that occurs inside a marker, or a ref whose marker contains a value', () => {
    const scrubber = new SecretScrubber()
    assert.equal(errorCode(() => scrubber.register('secret://vault/abcdefgh', 'abcdefgh')), 'marker_collision')
    assert.equal(errorCode(() => scrubber.register('secret://test/x', 'REDACTED secret')), 'marker_collision')
    scrubber.register('secret://test/ok', 'zz-other-value')
    assert.equal(errorCode(() => scrubber.register('secret://zz-other-value', fakeSecret())), 'marker_collision')
    assert.equal(scrubber.size, 1)
  })

  it('rotates a ref in place and keeps a shared value redacted until both refs go', () => {
    const scrubber = new SecretScrubber()
    const first = fakeSecret()
    const second = fakeSecret()
    scrubber.register('secret://test/rotate', first)
    scrubber.register('secret://test/rotate', second)
    assert.equal(scrubber.scrub(first), first, 'the rotated-out value is no longer redacted')
    assert.equal(scrubber.scrub(second), redactionMarker('secret://test/rotate'))

    const shared = fakeSecret()
    scrubber.register('secret://test/one', shared)
    scrubber.register('secret://test/two', shared)
    assert.equal(scrubber.scrub(shared), redactionMarker('secret://test/one'))
    assert.equal(scrubber.unregister('secret://test/one'), true)
    assert.equal(scrubber.scrub(shared), redactionMarker('secret://test/two'))
    assert.equal(scrubber.unregister('secret://test/two'), true)
    assert.equal(scrubber.unregister('secret://test/two'), false)
    assert.equal(scrubber.scrub(shared), shared)
  })
})

describe('egress scrubber: readiness (K3 H3)', () => {
  it('is ready only when every declared source is ready, and resolves waiters then', async () => {
    const scrubber = new SecretScrubber({ expectedSources: ['vault'] })
    assert.equal(scrubber.isReady(), false)
    assert.deepEqual(scrubber.pendingSources(), ['vault'])
    let resolved = false
    const waiting = scrubber.whenReady().then(() => { resolved = true })
    scrubber.expect('vault')
    scrubber.expect('env.shell')
    scrubber.ready('vault')
    await Promise.resolve()
    assert.equal(resolved, false, 'one declared source is still pending')
    assert.deepEqual(scrubber.pendingSources(), ['env.shell'])
    scrubber.ready('env.shell')
    await waiting
    assert.equal(resolved, true)
    assert.equal(scrubber.isReady(), true)
    scrubber.expect('vault')
    assert.equal(scrubber.isReady(), true, 'declaring a ready source keeps it ready')
    scrubber.ready('late')
    assert.equal(scrubber.isReady(), true, 'ready() declares an undeclared source as ready')
    scrubber.expect('later')
    assert.equal(scrubber.isReady(), false, 'a new declaration makes the scrubber not ready again')
    const settled = await Promise.race([scrubber.whenReady().then(() => 'ready'), Promise.resolve().then(() => 'pending')])
    assert.equal(settled, 'pending', 'whenReady waits for the new source')
  })

  it('refuses invalid source ids and rejects waiters when closed', async () => {
    const scrubber = new SecretScrubber()
    assert.equal(scrubber.isReady(), true, 'with no declared source the scrubber is ready')
    for (const bad of ['', 'Vault', '1vault', 'a b', 'x'.repeat(65)]) {
      assert.equal(errorCode(() => scrubber.expect(bad)), 'invalid_source')
      assert.equal(errorCode(() => scrubber.ready(bad)), 'invalid_source')
    }
    scrubber.expect('vault')
    const waiting = scrubber.whenReady()
    scrubber.close()
    await assert.rejects(waiting, (error: unknown) => error instanceof EgressScrubberError && error.code === 'closed')
    await assert.rejects(scrubber.whenReady(), (error: unknown) => error instanceof EgressScrubberError && error.code === 'closed')
    assert.equal(errorCode(() => scrubber.isReady()), 'closed')
  })

  it('declares sources from the plugin config before any consumer loads', async () => {
    const kernel = createKernel()
    await kernel.plugin(egressScrubberPlugin, { expectedSources: ['vault'] })
    const facade = kernel.service<EgressScrubber>(EGRESS_SCRUBBER_SERVICE)!
    assert.equal(facade.isReady(), false)
    assert.deepEqual(facade.pendingSources(), ['vault'])
    facade.ready('vault')
    assert.equal(facade.isReady(), true)
    await kernel.dispose()
  })
})

describe('egress scrubber: kernel service', () => {
  it('provides a frozen three-method facade that fails closed after unload', async () => {
    const kernel = createKernel()
    const handle = await kernel.plugin(egressScrubberPlugin)
    const facade = kernel.service<EgressScrubber>(EGRESS_SCRUBBER_SERVICE)!
    assert.ok(Object.isFrozen(facade))
    assert.deepEqual(
      Object.keys(facade).sort(),
      ['expect', 'isReady', 'pendingSources', 'ready', 'register', 'scrub', 'unregister', 'whenReady'],
    )
    const value = fakeSecret()
    facade.register('secret://test/kernel', value)
    assert.equal(facade.scrub(value), redactionMarker('secret://test/kernel'))

    await handle.dispose()
    assert.equal(kernel.service(EGRESS_SCRUBBER_SERVICE), undefined)
    assert.equal(errorCode(() => facade.scrub(value)), 'closed')
    assert.equal(errorCode(() => facade.register('secret://test/kernel', value)), 'closed')
    assert.equal(errorCode(() => facade.unregister('secret://test/kernel')), 'closed')
    await kernel.dispose()
  })

  it('restarts a consumer with the new instance, so registrations made in apply survive a reload', async () => {
    const kernel = createKernel()
    const value = fakeSecret()
    let applies = 0
    const consumer = definePlugin({
      manifest: {
        id: 'test.vault-consumer',
        engines: { guanxi: '^0.1.0' },
        provides: [],
        requires: [EGRESS_SCRUBBER_SERVICE],
        trust: 'T0',
      },
      apply(ctx) {
        applies++
        service<EgressScrubber>(ctx, EGRESS_SCRUBBER_SERVICE).register('secret://test/vault', value)
      },
    })
    const provider = await kernel.plugin(egressScrubberPlugin)
    await kernel.plugin(consumer)
    assert.equal(applies, 1)
    await provider.dispose()
    await kernel.plugin(egressScrubberPlugin)
    assert.equal(applies, 2)
    const fresh = kernel.service<EgressScrubber>(EGRESS_SCRUBBER_SERVICE)!
    assert.equal(fresh.scrub(value), redactionMarker('secret://test/vault'))
    await kernel.dispose()
  })
})
