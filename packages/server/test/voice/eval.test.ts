import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  compareEval,
  normalizeForWer,
  scoreEval,
  wordErrors,
  type EvalItem,
  type EvalOrigin,
} from '../../src/voice/eval.ts'

function item(
  id: string,
  reference: string,
  hypothesis: string,
  origin: EvalOrigin = 'synthetic',
): EvalItem {
  return { id, reference, hypothesis, origin }
}

function expectClose(actual: number | null, expected: number): void {
  assert.notEqual(actual, null)
  assert.ok(
    Math.abs((actual as number) - expected) < 1e-12,
    `expected ${String(actual)} to be close to ${String(expected)}`,
  )
}

const FILLERS = Array.from({ length: 100 }, (_, index) => `w${String(index + 1).padStart(3, '0')}`)
const GATE_TERMS = ['Hono', 'Codex']
const GATE_REFERENCE = `Hono Hono Hono Hono ${FILLERS.join(' ')}`
const GATE_BASELINE = `Hono Hono Codex Codex ${FILLERS.join(' ')}`
const GATE_CANDIDATE = `Hono Hono Hono Codex Codex Codex ${FILLERS.slice(0, 49).join(' ')} wrong ${FILLERS.slice(50).join(' ')}`
const GATE_ONE_U_ERROR = GATE_BASELINE.replace('w050', 'wrong')
const GATE_TWO_U_ERRORS = `Hono Hono Hono Codex Codex Codex ${FILLERS.slice(0, 49).join(' ')} wrong1 wrong2 ${FILLERS.slice(51).join(' ')}`

function gateScore(
  hypothesis: string,
  origin: EvalOrigin = 'owner_recording',
  id = 'owner-1',
): ReturnType<typeof scoreEval> {
  return scoreEval([item(id, GATE_REFERENCE, hypothesis, origin)], GATE_TERMS)
}

describe('normalizeForWer', () => {
  it('lower-cases, strips punctuation and collapses whitespace', () => {
    assert.deepEqual(normalizeForWer('  Привет,\n\tМИР!  '), ['привет', 'мир'])
    assert.deepEqual(normalizeForWer('«Цитата» — (тест).'), ['цитата', 'тест'])
  })

  it('maps ё to е after lower-casing', () => {
    assert.deepEqual(normalizeForWer('Ёлка, ещё — ВСЁ!'), ['елка', 'еще', 'все'])
    assert.deepEqual(normalizeForWer('ЁЖИК'), ['ежик'])
  })

  it('keeps a hyphen or apostrophe only inside a word', () => {
    assert.deepEqual(normalizeForWer("well-known don't 'quoted' -- x-y"), [
      'well-known',
      "don't",
      'quoted',
      'x-y',
    ])
    assert.deepEqual(normalizeForWer('word- -word'), ['word', 'word'])
  })

  it('keeps an intra-word hyphen ending and numbers', () => {
    assert.deepEqual(normalizeForWer('PR-а GPT-4'), ['pr-а', 'gpt-4'])
  })

  it('maps Unicode hyphens and apostrophes to their ASCII forms', () => {
    assert.deepEqual(normalizeForWer('PR\u2011а'), ['pr-а'])
    assert.deepEqual(normalizeForWer('PR\u2010ом'), ['pr-ом'])
    assert.deepEqual(normalizeForWer('don\u2019t'), ["don't"])
    assert.deepEqual(normalizeForWer('don\u02bct'), ["don't"])
  })

  it('keeps en and em dashes as token separators', () => {
    assert.deepEqual(normalizeForWer('PR\u2013а PR\u2014а'), ['pr', 'а', 'pr', 'а'])
  })

  it('returns no tokens for empty or punctuation-only text', () => {
    assert.deepEqual(normalizeForWer(''), [])
    assert.deepEqual(normalizeForWer('... --- !!!'), [])
  })

  it('normalises to NFC before tokenising', () => {
    assert.deepEqual(normalizeForWer('Cafe\u0301'), ['café'])
  })

  it('treats underscores and slashes as punctuation boundaries', () => {
    assert.deepEqual(normalizeForWer('foo_bar/baz'), ['foo', 'bar', 'baz'])
  })
})

describe('wordErrors', () => {
  it('reports an all-ok alignment for identical tokens', () => {
    assert.deepEqual(wordErrors(['a', 'b'], ['a', 'b']), {
      substitutions: 0,
      deletions: 0,
      insertions: 0,
      alignment: [
        { op: 'ok', ref: 'a', hyp: 'a' },
        { op: 'ok', ref: 'b', hyp: 'b' },
      ],
    })
  })

  it('reports substitutions', () => {
    assert.deepEqual(wordErrors(['a', 'b', 'c'], ['a', 'x', 'c']), {
      substitutions: 1,
      deletions: 0,
      insertions: 0,
      alignment: [
        { op: 'ok', ref: 'a', hyp: 'a' },
        { op: 'sub', ref: 'b', hyp: 'x' },
        { op: 'ok', ref: 'c', hyp: 'c' },
      ],
    })
  })

  it('reports reference deletions', () => {
    assert.deepEqual(wordErrors(['a', 'b', 'c'], ['a', 'c']), {
      substitutions: 0,
      deletions: 1,
      insertions: 0,
      alignment: [
        { op: 'ok', ref: 'a', hyp: 'a' },
        { op: 'del', ref: 'b' },
        { op: 'ok', ref: 'c', hyp: 'c' },
      ],
    })
  })

  it('reports hypothesis insertions', () => {
    assert.deepEqual(wordErrors(['a', 'c'], ['a', 'b', 'c']), {
      substitutions: 0,
      deletions: 0,
      insertions: 1,
      alignment: [
        { op: 'ok', ref: 'a', hyp: 'a' },
        { op: 'ins', hyp: 'b' },
        { op: 'ok', ref: 'c', hyp: 'c' },
      ],
    })
  })

  it('handles an empty reference as insertions only', () => {
    assert.deepEqual(wordErrors([], ['a', 'b']), {
      substitutions: 0,
      deletions: 0,
      insertions: 2,
      alignment: [
        { op: 'ins', hyp: 'a' },
        { op: 'ins', hyp: 'b' },
      ],
    })
  })

  it('handles an empty hypothesis as deletions only', () => {
    assert.deepEqual(wordErrors(['a', 'b'], []), {
      substitutions: 0,
      deletions: 2,
      insertions: 0,
      alignment: [
        { op: 'del', ref: 'a' },
        { op: 'del', ref: 'b' },
      ],
    })
  })

  it('handles two empty token arrays', () => {
    assert.deepEqual(wordErrors([], []), {
      substitutions: 0,
      deletions: 0,
      insertions: 0,
      alignment: [],
    })
  })

  it('breaks an ambiguous optimum deterministically toward diagonal steps', () => {
    const result = wordErrors(['a', 'b'], ['b', 'a'])
    assert.deepEqual(result, {
      substitutions: 2,
      deletions: 0,
      insertions: 0,
      alignment: [
        { op: 'sub', ref: 'a', hyp: 'b' },
        { op: 'sub', ref: 'b', hyp: 'a' },
      ],
    })
    assert.deepEqual(wordErrors(['a', 'b'], ['b', 'a']), result)
  })

  it('prefers a deletion over an insertion when both remain optimal', () => {
    assert.deepEqual(wordErrors(['a', 'b', 'a'], ['b', 'a', 'b']), {
      substitutions: 0,
      deletions: 1,
      insertions: 1,
      alignment: [
        { op: 'ins', hyp: 'b' },
        { op: 'ok', ref: 'a', hyp: 'a' },
        { op: 'ok', ref: 'b', hyp: 'b' },
        { op: 'del', ref: 'a' },
      ],
    })
  })
})

describe('scoreEval word error rate', () => {
  it('scores one substitution out of three reference words', () => {
    const score = scoreEval([item('one', 'one two three', 'one too three')], [])
    expectClose(score.wer, 1 / 3)
    assert.equal(score.bWer, null)
    expectClose(score.uWer, 1 / 3)
    assert.equal(score.termPrecision, null)
    assert.equal(score.termRecall, null)
    assert.equal(score.termF1, null)
    assert.equal(score.origin, 'synthetic')
  })

  it('scores a pure deletion as 1.0', () => {
    const score = scoreEval([item('one', 'a b', '')], [])
    assert.equal(score.wer, 1)
    assert.equal(score.counts.deletions, 2)
  })

  it('scores a pure insertion as 1.0 over two reference words', () => {
    const score = scoreEval([item('one', 'a b', 'a b c')], [])
    expectClose(score.wer, 0.5)
    assert.equal(score.counts.insertions, 1)
  })

  it('aggregates corpus counts instead of averaging item WERs', () => {
    const score = scoreEval(
      [item('one', 'a b c', 'a x c'), item('two', 'd e', 'd e f')],
      [],
    )
    assert.equal(score.counts.refWords, 5)
    assert.equal(score.counts.hypWords, 6)
    assert.equal(score.counts.errors, 2)
    expectClose(score.wer, 2 / 5)
  })

  it('returns null WER for an empty reference but still counts insertions', () => {
    const score = scoreEval([item('one', '', 'hello world')], [])
    assert.equal(score.wer, null)
    assert.equal(score.uWer, null)
    assert.equal(score.bWer, null)
    assert.equal(score.counts.refWords, 0)
    assert.equal(score.counts.hypWords, 2)
    assert.equal(score.counts.insertions, 2)
  })

  it('returns null WER for two empty texts', () => {
    const score = scoreEval([item('one', '', '')], [])
    assert.equal(score.wer, null)
    assert.equal(score.uWer, null)
    assert.equal(score.bWer, null)
    assert.equal(score.counts.refWords, 0)
    assert.equal(score.counts.hypWords, 0)
  })

  it('returns null metrics for an empty item list', () => {
    const score = scoreEval([], [])
    assert.equal(score.wer, null)
    assert.equal(score.bWer, null)
    assert.equal(score.uWer, null)
    assert.equal(score.termPrecision, null)
    assert.equal(score.termRecall, null)
    assert.equal(score.termF1, null)
    assert.equal(score.origin, 'empty')
    assert.deepEqual(score.itemIds, [])
    assert.deepEqual(score.counts, {
      items: 0,
      syntheticItems: 0,
      ownerRecordingItems: 0,
      refWords: 0,
      hypWords: 0,
      substitutions: 0,
      deletions: 0,
      insertions: 0,
      errors: 0,
      biasedRefWords: 0,
      unbiasedRefWords: 0,
      biasedSubstitutions: 0,
      biasedDeletions: 0,
      biasedInsertions: 0,
      unbiasedSubstitutions: 0,
      unbiasedDeletions: 0,
      unbiasedInsertions: 0,
      biasedErrors: 0,
      unbiasedErrors: 0,
      termRefOccurrences: 0,
      termHypOccurrences: 0,
      matchedTermOccurrences: 0,
    })
  })

  it('treats every word as unbiased when no glossary is supplied', () => {
    const score = scoreEval([item('one', 'a b', 'a c')], [])
    assert.equal(score.bWer, null)
    expectClose(score.uWer, 0.5)
    assert.equal(score.termF1, null)
  })
})

describe('scoreEval B-WER and U-WER', () => {
  it('scores a fully correct glossary sentence', () => {
    const score = scoreEval([item('one', 'Hono is fast', 'Hono is fast')], ['Hono'])
    assert.equal(score.wer, 0)
    assert.equal(score.uWer, 0)
    assert.equal(score.bWer, 0)
    assert.equal(score.counts.biasedRefWords, 1)
    assert.equal(score.counts.unbiasedRefWords, 2)
    assert.equal(score.termF1, 1)
  })

  it('charges an unbiased substitution to U-WER only', () => {
    const score = scoreEval([item('one', 'Hono is fast', 'Hono is slow')], ['Hono'])
    expectClose(score.wer, 1 / 3)
    assert.equal(score.bWer, 0)
    expectClose(score.uWer, 1 / 2)
    assert.equal(score.counts.unbiasedSubstitutions, 1)
    assert.equal(score.counts.biasedErrors, 0)
  })

  it('charges a biased deletion to B-WER only', () => {
    const score = scoreEval([item('one', 'Hono is fast', 'is fast')], ['Hono'])
    expectClose(score.wer, 1 / 3)
    assert.equal(score.bWer, 1)
    assert.equal(score.uWer, 0)
    assert.equal(score.counts.biasedDeletions, 1)
    assert.equal(score.counts.unbiasedErrors, 0)
  })

  it('charges a biased substitution to B-WER only', () => {
    const score = scoreEval([item('one', 'Hono is fast', 'Chono is fast')], ['Hono'])
    assert.equal(score.bWer, 1)
    assert.equal(score.uWer, 0)
    assert.equal(score.counts.biasedSubstitutions, 1)
  })

  it('charges a non-term insertion to U-WER', () => {
    const score = scoreEval([item('one', 'Hono is fast', 'Hono is very fast')], ['Hono'])
    expectClose(score.wer, 1 / 3)
    assert.equal(score.bWer, 0)
    expectClose(score.uWer, 1 / 2)
    assert.equal(score.counts.unbiasedInsertions, 1)
    assert.equal(score.counts.biasedInsertions, 0)
  })

  it('charges an inserted glossary term to B-WER', () => {
    const score = scoreEval([item('one', 'Hono is fast', 'Hono Hono is fast')], ['Hono'])
    expectClose(score.wer, 1 / 3)
    assert.equal(score.bWer, 1)
    assert.equal(score.uWer, 0)
    assert.equal(score.counts.biasedInsertions, 1)
    assert.equal(score.counts.unbiasedInsertions, 0)
  })

  it('keeps B-WER null when a term insertion has no biased reference word', () => {
    const score = scoreEval([item('one', 'is fast', 'Hono is fast')], ['Hono'])
    expectClose(score.wer, 0.5)
    assert.equal(score.counts.biasedInsertions, 1)
    assert.equal(score.counts.biasedRefWords, 0)
    assert.equal(score.bWer, null)
    assert.equal(score.uWer, 0)
    assert.equal(score.termPrecision, 0)
    assert.equal(score.termRecall, null)
    assert.equal(score.termF1, 0)
  })

  it('matches a D-157 hyphen ending as a biased reference word', () => {
    const score = scoreEval([item('one', 'PR-а это важно', 'PR-а это важно')], ['PR'])
    assert.equal(score.wer, 0)
    assert.equal(score.bWer, 0)
    assert.equal(score.uWer, 0)
    assert.equal(score.counts.biasedRefWords, 1)
    assert.equal(score.counts.unbiasedRefWords, 2)
    assert.equal(score.termF1, 1)
  })

  it('charges a substitution from a hyphen-ending term to B-WER', () => {
    const score = scoreEval([item('one', 'PR-а это важно', 'PR это важно')], ['PR'])
    assert.equal(score.counts.biasedSubstitutions, 1)
    assert.equal(score.bWer, 1)
    assert.equal(score.uWer, 0)
  })

  it('accepts a combining stress mark in a hyphen ending', () => {
    const text = 'PR-а\u0301 это важно'
    const score = scoreEval([item('one', text, text)], ['PR'])
    assert.equal(score.counts.biasedRefWords, 1)
    assert.equal(score.bWer, 0)
    assert.equal(score.termF1, 1)
  })

  it('applies a hyphen ending to the last token of a multi-word term', () => {
    const score = scoreEval(
      [item('one', 'Open AI-ах это', 'Open AI-ах это')],
      ['Open AI'],
    )
    assert.equal(score.counts.biasedRefWords, 2)
    assert.equal(score.counts.unbiasedRefWords, 1)
    assert.equal(score.bWer, 0)
    assert.equal(score.counts.termRefOccurrences, 1)
    assert.equal(score.termF1, 1)
  })

  it('matches a multi-word term as a token sequence', () => {
    const score = scoreEval(
      [item('one', 'Open AI is here', 'Open AI rocks here')],
      ['Open AI'],
    )
    assert.equal(score.counts.biasedRefWords, 2)
    assert.equal(score.counts.unbiasedRefWords, 2)
    assert.equal(score.bWer, 0)
    expectClose(score.uWer, 1 / 2)
    assert.equal(score.termF1, 1)
  })

  it('charges every inserted token of a multi-word term to B-WER', () => {
    const score = scoreEval([item('one', 'is fast', 'Open AI is fast')], ['Open AI'])
    assert.equal(score.counts.biasedInsertions, 2)
    assert.equal(score.counts.biasedRefWords, 0)
    assert.equal(score.bWer, null)
    assert.equal(score.uWer, 0)
  })

  it('does not transliterate a Cyrillic spoken form into a Latin term', () => {
    const score = scoreEval([item('one', 'хоно и Hono', 'хоно и Hono')], ['Hono'])
    assert.equal(score.counts.biasedRefWords, 1)
    assert.equal(score.counts.unbiasedRefWords, 2)
    assert.equal(score.wer, 0)
  })

  it('matches terms case-insensitively after normalisation', () => {
    const score = scoreEval([item('one', 'HONO is fast', 'hono is fast')], ['Hono'])
    assert.equal(score.wer, 0)
    assert.equal(score.bWer, 0)
    assert.equal(score.termF1, 1)
  })

  it('keeps the D-157 hyphen-ending rule to Latin term tokens', () => {
    const score = scoreEval([item('one', 'пиар-а это', 'пиар-а это')], ['пиар'])
    assert.equal(score.counts.biasedRefWords, 0)
    assert.equal(score.counts.termRefOccurrences, 0)
    assert.equal(score.termF1, null)
  })

  it('does not treat a Latin suffix as a D-157 inflection', () => {
    const score = scoreEval([item('x', 'pull-request here', 'pull-request here')], ['pull'])
    assert.equal(score.counts.biasedRefWords, 0)
    assert.equal(score.counts.termRefOccurrences, 0)
    assert.equal(score.counts.termHypOccurrences, 0)
    assert.equal(score.termF1, null)
  })

  it('returns null U-WER when every reference word is biased', () => {
    const score = scoreEval([item('one', 'Hono Codex', 'Hono Codex')], ['Hono', 'Codex'])
    assert.equal(score.bWer, 0)
    assert.equal(score.uWer, null)
    assert.equal(score.counts.biasedRefWords, 2)
    assert.equal(score.counts.unbiasedRefWords, 0)
  })
})

describe('scoreEval term precision, recall and F1', () => {
  it('scores a perfect term match', () => {
    const score = scoreEval([item('one', 'Hono rocks', 'Hono rocks')], ['Hono'])
    assert.equal(score.termPrecision, 1)
    assert.equal(score.termRecall, 1)
    assert.equal(score.termF1, 1)
    assert.equal(score.counts.matchedTermOccurrences, 1)
  })

  it('counts repeated terms with multiset matching', () => {
    const score = scoreEval([item('one', 'Hono Hono rocks', 'Hono rocks')], ['Hono'])
    assert.equal(score.counts.termRefOccurrences, 2)
    assert.equal(score.counts.termHypOccurrences, 1)
    assert.equal(score.counts.matchedTermOccurrences, 1)
    assert.equal(score.termPrecision, 1)
    assert.equal(score.termRecall, 0.5)
    expectClose(score.termF1, 2 / 3)
  })

  it('reports extra hypothesis terms as precision loss', () => {
    const score = scoreEval([item('one', 'Hono rocks', 'Hono Hono rocks')], ['Hono'])
    assert.equal(score.counts.termRefOccurrences, 1)
    assert.equal(score.counts.termHypOccurrences, 2)
    assert.equal(score.termPrecision, 0.5)
    assert.equal(score.termRecall, 1)
    expectClose(score.termF1, 2 / 3)
  })

  it('returns null precision and F1 0 when only the hypothesis has terms', () => {
    const score = scoreEval([item('one', 'rocks', 'Hono rocks')], ['Hono'])
    assert.equal(score.termPrecision, 0)
    assert.equal(score.termRecall, null)
    assert.equal(score.termF1, 0)
  })

  it('returns null recall and F1 0 when only the reference has terms', () => {
    const score = scoreEval([item('one', 'Hono rocks', 'rocks')], ['Hono'])
    assert.equal(score.termPrecision, null)
    assert.equal(score.termRecall, 0)
    assert.equal(score.termF1, 0)
  })

  it('returns null term metrics when no term occurs', () => {
    const score = scoreEval([item('one', 'rocks', 'rocks')], ['Hono'])
    assert.equal(score.termPrecision, null)
    assert.equal(score.termRecall, null)
    assert.equal(score.termF1, null)
    assert.equal(score.counts.termRefOccurrences, 0)
    assert.equal(score.counts.termHypOccurrences, 0)
  })

  it('scores disjoint reference and hypothesis terms as zero F1', () => {
    const score = scoreEval([item('one', 'Hono', 'Codex')], ['Hono', 'Codex'])
    assert.equal(score.termPrecision, 0)
    assert.equal(score.termRecall, 0)
    assert.equal(score.termF1, 0)
  })

  it('counts a multi-word term once', () => {
    const score = scoreEval([item('one', 'Open AI rocks', 'Open AI rocks')], ['Open AI'])
    assert.equal(score.counts.termRefOccurrences, 1)
    assert.equal(score.counts.termHypOccurrences, 1)
    assert.equal(score.termF1, 1)
  })

  it('counts D-157 hyphen endings as term occurrences', () => {
    const score = scoreEval([item('one', 'PR-а это', 'PR-ах это')], ['PR'])
    assert.equal(score.counts.termRefOccurrences, 1)
    assert.equal(score.counts.termHypOccurrences, 1)
    assert.equal(score.termF1, 1)
  })

  it('ignores duplicate normalised glossary terms', () => {
    const score = scoreEval([item('one', 'Hono', 'Hono')], ['Hono', 'hono', 'HONO'])
    assert.equal(score.counts.termRefOccurrences, 1)
    assert.equal(score.counts.termHypOccurrences, 1)
    assert.equal(score.termF1, 1)
  })

  it('prefers the longest term at the same start', () => {
    const score = scoreEval([item('one', 'Open AI', 'Open AI')], ['Open', 'Open AI'])
    assert.equal(score.counts.termRefOccurrences, 1)
    assert.equal(score.counts.termHypOccurrences, 1)
    assert.equal(score.termF1, 1)
  })

  it('aggregates term multisets across items', () => {
    const score = scoreEval(
      [item('one', 'Hono', ''), item('two', '', 'Hono')],
      ['Hono'],
    )
    assert.equal(score.counts.termRefOccurrences, 1)
    assert.equal(score.counts.termHypOccurrences, 1)
    assert.equal(score.termF1, 1)
  })
})

describe('scoreEval origin labelling', () => {
  it('labels an all-synthetic set and counts its items', () => {
    const score = scoreEval([item('one', 'a', 'a')], [])
    assert.equal(score.origin, 'synthetic')
    assert.equal(score.counts.syntheticItems, 1)
    assert.equal(score.counts.ownerRecordingItems, 0)
  })

  it('labels an all-owner set and counts its items', () => {
    const score = scoreEval([item('one', 'a', 'a', 'owner_recording')], [])
    assert.equal(score.origin, 'owner_recording')
    assert.equal(score.counts.syntheticItems, 0)
    assert.equal(score.counts.ownerRecordingItems, 1)
  })

  it('labels a mixed set', () => {
    const score = scoreEval(
      [
        item('one', 'a', 'a', 'synthetic'),
        item('two', 'b', 'b', 'owner_recording'),
      ],
      [],
    )
    assert.equal(score.origin, 'mixed')
    assert.equal(score.counts.syntheticItems, 1)
    assert.equal(score.counts.ownerRecordingItems, 1)
  })

  it('sorts item ids so report comparisons do not depend on item order', () => {
    const score = scoreEval([item('b', 'a', 'a'), item('a', 'b', 'b')], [])
    assert.deepEqual(score.itemIds, ['a', 'b'])
  })
})

describe('determinism', () => {
  it('returns the same score for repeated and reordered input', () => {
    const items = [
      item('one', 'Hono PR-а is fast', 'Hono PR-а is fast'),
      item('two', 'Open AI is here', 'Open AI is there', 'owner_recording'),
    ]
    const terms = ['Hono', 'PR', 'Open AI']
    const first = scoreEval(items, terms)
    assert.deepEqual(scoreEval(items, terms), first)
    assert.deepEqual(scoreEval([...items].reverse(), [...terms].reverse()), first)
  })

  it('returns the same comparison for repeated calls', () => {
    const baseline = gateScore(GATE_BASELINE)
    const candidate = gateScore(GATE_CANDIDATE)
    assert.deepEqual(compareEval(baseline, candidate), compareEval(baseline, candidate))
  })
})

describe('compareEval V1 gate and V2 pre-apply rule', () => {
  it('meets the V1 gate at exactly 10 term-F1 points and 1 U-WER point', () => {
    const baseline = gateScore(GATE_BASELINE)
    const candidate = gateScore(GATE_CANDIDATE)
    assert.equal(baseline.termF1, 0.5)
    assert.equal(candidate.termF1, 0.6)
    assert.equal(baseline.uWer, 0)
    assert.equal(candidate.uWer, 0.01)

    const comparison = compareEval(baseline, candidate)
    assert.equal(comparison.termF1DeltaPoints, 10)
    assert.equal(comparison.uWerDeltaPoints, 1)
    assert.deepEqual(comparison.v1Gate, {
      evaluated: true,
      reason: 'owner_recordings',
      met: true,
    })
    assert.deepEqual(comparison.v2Apply, { allowed: true, reason: 'within_bounds' })
  })

  it('fails the V1 gate when U-WER rises by more than 1 point', () => {
    const comparison = compareEval(gateScore(GATE_BASELINE), gateScore(GATE_TWO_U_ERRORS))
    assert.equal(comparison.termF1DeltaPoints, 10)
    assert.equal(comparison.uWerDeltaPoints, 2)
    assert.equal(comparison.v1Gate.evaluated, true)
    assert.equal(comparison.v1Gate.met, false)
    assert.deepEqual(comparison.v2Apply, { allowed: false, reason: 'u_wer_rise' })
  })

  it('fails the V1 gate when term F1 does not rise by 10 points', () => {
    const comparison = compareEval(gateScore(GATE_BASELINE), gateScore(GATE_ONE_U_ERROR))
    assert.equal(comparison.termF1DeltaPoints, 0)
    assert.equal(comparison.uWerDeltaPoints, 1)
    assert.equal(comparison.v1Gate.met, false)
    assert.deepEqual(comparison.v2Apply, { allowed: true, reason: 'within_bounds' })
  })

  it('refuses a synthetic gate and never auto-applies from it', () => {
    const comparison = compareEval(
      gateScore(GATE_BASELINE, 'synthetic'),
      gateScore(GATE_CANDIDATE, 'synthetic'),
    )
    assert.deepEqual(comparison.v1Gate, { evaluated: false, reason: 'synthetic_eval' })
    assert.deepEqual(comparison.v2Apply, { allowed: false, reason: 'synthetic_eval' })
  })

  it('refuses a mixed-origin gate', () => {
    const mixed = scoreEval(
      [
        item('m1', GATE_REFERENCE, GATE_BASELINE, 'owner_recording'),
        item('m2', 'a b', 'a b', 'synthetic'),
      ],
      GATE_TERMS,
    )
    const comparison = compareEval(mixed, mixed)
    assert.deepEqual(comparison.v1Gate, { evaluated: false, reason: 'mixed_origin' })
    assert.deepEqual(comparison.v2Apply, { allowed: false, reason: 'mixed_origin' })
  })

  it('refuses reports over different item ids', () => {
    const comparison = compareEval(
      gateScore(GATE_BASELINE, 'owner_recording', 'a'),
      gateScore(GATE_CANDIDATE, 'owner_recording', 'b'),
    )
    assert.deepEqual(comparison.v1Gate, { evaluated: false, reason: 'item_mismatch' })
    assert.deepEqual(comparison.v2Apply, { allowed: false, reason: 'item_mismatch' })
  })

  it('refuses an empty evaluation', () => {
    const comparison = compareEval(scoreEval([], []), scoreEval([], []))
    assert.deepEqual(comparison.v1Gate, { evaluated: false, reason: 'empty' })
    assert.deepEqual(comparison.v2Apply, { allowed: false, reason: 'empty' })
  })

  it('refuses V2 when term F1 drops on owner recordings', () => {
    const comparison = compareEval(gateScore(GATE_CANDIDATE), gateScore(GATE_BASELINE))
    assert.equal(comparison.termF1DeltaPoints, -10)
    assert.equal(comparison.v1Gate.met, false)
    assert.deepEqual(comparison.v2Apply, { allowed: false, reason: 'term_f1_drop' })
  })

  it('refuses V2 when metrics are unavailable', () => {
    const report = scoreEval([item('o', '', '', 'owner_recording')], [])
    const comparison = compareEval(report, report)
    assert.equal(comparison.termF1DeltaPoints, null)
    assert.equal(comparison.uWerDeltaPoints, null)
    assert.deepEqual(comparison.v1Gate, {
      evaluated: true,
      reason: 'owner_recordings',
      met: false,
    })
    assert.deepEqual(comparison.v2Apply, { allowed: false, reason: 'missing_metrics' })
  })

  it('evaluates the same ids when items arrive in a different order', () => {
    const baseline = scoreEval(
      [
        item('a', GATE_REFERENCE, GATE_BASELINE, 'owner_recording'),
        item('b', 'one two', 'one two', 'owner_recording'),
      ],
      GATE_TERMS,
    )
    const candidate = scoreEval(
      [
        item('b', 'one two', 'one two', 'owner_recording'),
        item('a', GATE_REFERENCE, GATE_CANDIDATE, 'owner_recording'),
      ],
      GATE_TERMS,
    )
    assert.equal(compareEval(baseline, candidate).v1Gate.evaluated, true)
  })
})
