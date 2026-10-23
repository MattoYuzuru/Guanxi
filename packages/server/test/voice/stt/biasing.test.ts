import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  glossaryAllowed,
  glossaryFingerprint,
  orderedPromptTerms,
  planBiasing,
} from '../../../src/voice/stt/biasing.ts'
import { glossaryRevisionHash } from '../../../src/voice/marker.ts'
import type { SttConnection, SttGlossaryEntry } from '../../../src/voice/stt/types.ts'

const LOCAL: SttConnection = { kind: 'local', glossaryConsent: false }
const CLOUD_NO_CONSENT: SttConnection = { kind: 'cloud', glossaryConsent: false }
const CLOUD_CONSENT: SttConnection = { kind: 'cloud', glossaryConsent: true }

function entry(
  id: string,
  canonical: string,
  variants: string[] = [],
  extra: Partial<SttGlossaryEntry> = {},
): SttGlossaryEntry {
  return { id, canonical, variants, language: 'en', ...extra }
}

function initialPrompt(maxPromptChars = 448) {
  return { biasing: 'initial_prompt' as const, maxPromptChars }
}

function plan(
  entries: SttGlossaryEntry[],
  capabilities: { biasing: 'initial_prompt' | 'hotwords' | 'keyterms' | 'none'; maxPromptChars?: number },
  connection: SttConnection = LOCAL,
  language?: string,
) {
  return planBiasing({
    entries,
    capabilities,
    connection,
    ...(language === undefined ? {} : { language }),
  })
}

describe('glossaryAllowed (D-157)', () => {
  it('allows local use without consent and cloud use only with explicit consent', () => {
    assert.equal(glossaryAllowed(LOCAL), true)
    assert.equal(glossaryAllowed({ kind: 'local', glossaryConsent: true }), true)
    assert.equal(glossaryAllowed(CLOUD_NO_CONSENT), false)
    assert.equal(glossaryAllowed(CLOUD_CONSENT), true)
  })

  it('rejects a malformed connection instead of treating it as consent', () => {
    const bad: unknown[] = [
      null,
      [],
      { kind: 'lan', glossaryConsent: true },
      { kind: 'local' },
      { kind: 'local', glossaryConsent: 'yes' },
      { kind: 'cloud', glossaryConsent: 1 },
    ]
    for (const connection of bad) {
      assert.throws(() => glossaryAllowed(connection as SttConnection), TypeError)
    }
  })
})

describe('orderedPromptTerms', () => {
  const zeta = entry('zeta', 'Zeta')
  const alpha = entry('alpha', 'alpha')
  const beta = entry('beta', 'Beta')

  it('orders by folded key, then exact canonical, then id, independent of input order', () => {
    assert.deepEqual(orderedPromptTerms([zeta, alpha, beta]), ['alpha', 'Beta', 'Zeta'])
    assert.deepEqual(orderedPromptTerms([beta, zeta, alpha]), ['alpha', 'Beta', 'Zeta'])
  })

  it('keeps only canonical terms, not spoken variants', () => {
    assert.deepEqual(
      orderedPromptTerms([entry('hono', 'Hono', ['хоно', 'хона'])]),
      ['Hono'],
    )
  })

  it('keeps a Latin canonical in Latin script for Cyrillic speech', () => {
    const terms = orderedPromptTerms([
      entry('hono', 'Hono', ['хоно']),
      entry('ollama', 'Оллама', ['оллама'], { language: 'ru' }),
      entry('cyrillic-hono', 'Хоно'),
    ])
    assert.deepEqual(terms, ['Hono', 'Оллама'])
  })

  it('deduplicates folded keys deterministically and ignores empty folded keys', () => {
    assert.deepEqual(
      orderedPromptTerms([entry('lower', 'pr'), entry('upper', 'PR'), entry('empty', '!!!')]),
      ['PR'],
    )
  })

  it('rejects malformed entries', () => {
    for (const bad of [
      null,
      'entries',
      [null],
      [{ id: '', canonical: 'Hono', variants: [] }],
      [{ id: 'hono', canonical: '', variants: [] }],
      [{ id: 'hono', canonical: 'Hono', variants: 'хоно' }],
    ]) {
      assert.throws(() => orderedPromptTerms(bad as unknown as SttGlossaryEntry[]), TypeError)
    }
  })
})

describe('planBiasing', () => {
  const entries = [entry('pr', 'PR', ['пиар']), entry('hono', 'Hono', ['хоно'])]

  it('builds a deterministic comma-separated initial prompt from canonicals', () => {
    const result = plan(entries, initialPrompt())
    assert.deepEqual(result, {
      outcome: 'initial_prompt',
      prompt: 'Hono, PR',
      included: 2,
      omitted: 0,
    })
  })

  it('does not filter Latin canonicals out for Cyrillic speech', () => {
    const result = plan(entries, initialPrompt(), LOCAL, 'ru')
    assert.equal(result.prompt, 'Hono, PR')
    assert.equal(result.outcome, 'initial_prompt')
  })

  it('sends nothing for an empty glossary or a backend without biasing', () => {
    assert.deepEqual(plan([], initialPrompt()), { outcome: 'none', included: 0, omitted: 0 })
    assert.deepEqual(plan(entries, { biasing: 'none' }), {
      outcome: 'none',
      included: 0,
      omitted: 2,
    })
  })

  it('fits whole terms into the adapter budget and reports omitted terms', () => {
    const terms = [entry('a', 'alpha'), entry('b', 'beta'), entry('c', 'gamma')]
    assert.deepEqual(plan(terms, initialPrompt(13)), {
      outcome: 'initial_prompt',
      prompt: 'alpha, beta',
      included: 2,
      omitted: 1,
    })
    assert.deepEqual(plan(terms, initialPrompt(5)), {
      outcome: 'initial_prompt',
      prompt: 'alpha',
      included: 1,
      omitted: 2,
    })
    assert.deepEqual(plan(terms, initialPrompt(3)), {
      outcome: 'none',
      included: 0,
      omitted: 3,
    })
  })

  it('skips an oversized term but still fits later short terms without splitting one', () => {
    const terms = [entry('a', 'aaa'), entry('b', 'longlonglong'), entry('c', 'zzz')]
    assert.deepEqual(plan(terms, initialPrompt(8)), {
      outcome: 'initial_prompt',
      prompt: 'aaa, zzz',
      included: 2,
      omitted: 1,
    })
  })

  it('measures the budget in code points, so a surrogate pair is never split', () => {
    const result = plan([entry('e', 'é😀')], initialPrompt(2))
    assert.equal(result.prompt, 'é😀')
    assert.equal([...(result.prompt ?? '')].length, 2)
  })

  it('rejects prompt mechanisms without a positive integer adapter budget', () => {
    for (const maxPromptChars of [undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => plan(entries, { biasing: 'initial_prompt', maxPromptChars }),
        TypeError,
      )
    }
  })

  it('validates the connection and prompt budget even when there is nothing to send', () => {
    assert.throws(() => plan([], { biasing: 'initial_prompt' }), TypeError)
    assert.throws(
      () => plan([], initialPrompt(), { kind: 'lan' } as unknown as SttConnection),
      TypeError,
    )
    assert.throws(
      () => plan(entries, { biasing: 'initial_prompt' }, CLOUD_NO_CONSENT),
      TypeError,
    )
    assert.throws(
      () => plan([], { biasing: 'none' }, { kind: 'lan' } as unknown as SttConnection),
      TypeError,
    )
  })

  it('deduplicates folded keys and counts only the deduplicated terms', () => {
    const result = plan([entry('lat', 'Hono'), entry('cyr', 'Хоно')], initialPrompt())
    assert.equal(result.prompt, 'Hono')
    assert.equal(result.included, 1)
    assert.equal(result.omitted, 0)
  })

  it('rejects an unknown mechanism and malformed planner input', () => {
    assert.throws(() => plan(entries, { biasing: 'grammar' as 'none' }), TypeError)
    assert.throws(() => plan('entries' as unknown as SttGlossaryEntry[], initialPrompt()), TypeError)
    assert.throws(() => planBiasing({
      entries,
      capabilities: null as unknown as { biasing: 'initial_prompt' },
      connection: LOCAL,
    }), TypeError)
    assert.throws(() => plan(entries, initialPrompt(), { kind: 'lan' } as unknown as SttConnection), TypeError)
  })
})

describe('D-157 withholding', () => {
  const entries = [entry('hono', 'Hono', ['хоно'])]

  it('omits the prompt for a cloud connection without consent', () => {
    const result = plan(entries, initialPrompt(), CLOUD_NO_CONSENT)
    assert.deepEqual(result, {
      outcome: 'withheld_no_consent',
      included: 0,
      omitted: 1,
    })
    assert.equal(Object.hasOwn(result, 'prompt'), false)
  })

  it('sends the prompt for a cloud connection with consent', () => {
    const result = plan(entries, initialPrompt(), CLOUD_CONSENT)
    assert.equal(result.outcome, 'initial_prompt')
    assert.equal(result.prompt, 'Hono')
  })

  it('sends the prompt for a local connection without a cloud consent flag', () => {
    const result = plan(entries, initialPrompt(), LOCAL)
    assert.equal(result.outcome, 'initial_prompt')
    assert.equal(result.prompt, 'Hono')
  })

  it('reports none, not withholding, when there is nothing to withhold', () => {
    assert.deepEqual(plan([], initialPrompt(), CLOUD_NO_CONSENT), {
      outcome: 'none',
      included: 0,
      omitted: 0,
    })
  })
})

describe('other prompt mechanisms', () => {
  const entries = [entry('pr', 'PR'), entry('hono', 'Hono')]

  it('uses one term per line for hotwords and keyterms and applies the same budget', () => {
    assert.deepEqual(plan(entries, { biasing: 'hotwords', maxPromptChars: 448 }), {
      outcome: 'hotwords',
      prompt: 'Hono\nPR',
      included: 2,
      omitted: 0,
    })
    assert.deepEqual(plan(entries, { biasing: 'keyterms', maxPromptChars: 7 }), {
      outcome: 'keyterms',
      prompt: 'Hono\nPR',
      included: 2,
      omitted: 0,
    })
    assert.deepEqual(plan(entries, { biasing: 'hotwords', maxPromptChars: 5 }), {
      outcome: 'hotwords',
      prompt: 'Hono',
      included: 1,
      omitted: 1,
    })
  })
})

describe('glossaryFingerprint', () => {
  const hono = entry('hono', 'Hono', ['хоно'])
  const pr = entry('pr', 'PR', ['пиар'])

  it('equals glossaryRevisionHash when every entry carries a stored revision', () => {
    const revised = [
      { ...hono, revision: 2 },
      { ...pr, revision: 5 },
    ]
    assert.equal(
      glossaryFingerprint(revised),
      glossaryRevisionHash([{ id: 'hono', revision: 2 }, { id: 'pr', revision: 5 }]),
    )
  })

  it('hashes plain V1-a entries independently of input and variant order', () => {
    const first = glossaryFingerprint([hono, pr])
    const second = glossaryFingerprint([
      { ...pr, variants: ['пиар'] },
      { ...hono, variants: ['хоно'] },
    ])
    assert.equal(first, second)
    assert.match(first, /^[0-9a-f]{64}$/u)
  })

  it('changes when the glossary content changes and handles the empty set', () => {
    assert.notEqual(glossaryFingerprint([hono]), glossaryFingerprint([{ ...hono, canonical: 'Hono!' }]))
    assert.equal(glossaryFingerprint([]), glossaryRevisionHash([]))
  })

  it('includes language and flags in the content projection and ignores variant order', () => {
    assert.equal(
      glossaryFingerprint([{ ...hono, variants: ['b', 'a'] }]),
      glossaryFingerprint([{ ...hono, variants: ['a', 'b'] }]),
    )
    assert.notEqual(glossaryFingerprint([hono]), glossaryFingerprint([{ ...hono, language: 'ru' }]))
    assert.notEqual(
      glossaryFingerprint([hono]),
      glossaryFingerprint([{ ...hono, caseSensitive: true }]),
    )
    assert.notEqual(glossaryFingerprint([hono]), glossaryFingerprint([{ ...hono, inflect: false }]))
  })

  it('does not pretend that a partially revised set is a revision hash', () => {
    const mixed = [{ ...hono, revision: 2 }, pr]
    assert.equal(glossaryFingerprint(mixed), glossaryFingerprint([hono, pr]))
    assert.notEqual(
      glossaryFingerprint(mixed),
      glossaryRevisionHash([{ id: 'hono', revision: 2 }, { id: 'pr', revision: 1 }]),
    )
  })
})
