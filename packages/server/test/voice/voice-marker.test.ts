import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  glossaryRevisionHash,
  validateVoiceOrigin,
  voiceBlock,
  type VoiceOrigin,
} from '../../src/voice/marker.ts'

const FINAL_TEXT = 'Привет, Hono и ворктри!'
const HONO_START = FINAL_TEXT.indexOf('Hono')
const WORKTREE_START = FINAL_TEXT.indexOf('ворктри')

function validOrigin(): VoiceOrigin {
  return {
    origin: 'voice',
    backend: 'whisper.cpp',
    model: 'large-v3',
    language: 'ru',
    confidenceSpans: [
      { start: HONO_START, end: HONO_START + 4, confidence: 0.42 },
      { start: WORKTREE_START, end: WORKTREE_START + 7, confidence: 0.5 },
    ],
    replacements: [
      {
        start: HONO_START,
        end: HONO_START + 4,
        original: 'хоно',
        replacement: 'Hono',
        entryId: 'hono',
      },
    ],
    glossaryRevision: 'a'.repeat(64),
  }
}

function expectTypeError(run: () => unknown): void {
  assert.throws(run, TypeError)
}

describe('validateVoiceOrigin', () => {
  it('accepts a valid origin and returns the same typed fields', () => {
    const input = validOrigin()
    const validated = validateVoiceOrigin(input, FINAL_TEXT)
    assert.deepEqual(validated, input)
    assert.deepEqual(Object.getOwnPropertySymbols(validated), [])
  })

  it('accepts null language and an empty confidence/replacement list', () => {
    const input = { ...validOrigin(), language: null, confidenceSpans: [], replacements: [] }
    assert.deepEqual(validateVoiceOrigin(input, FINAL_TEXT), input)
  })

  it('rejects non-objects and a wrong origin', () => {
    expectTypeError(() => validateVoiceOrigin(null, FINAL_TEXT))
    expectTypeError(() => validateVoiceOrigin([], FINAL_TEXT))
    expectTypeError(() => validateVoiceOrigin('voice', FINAL_TEXT))
    expectTypeError(() => validateVoiceOrigin({ ...validOrigin(), origin: 'text' }, FINAL_TEXT))
    expectTypeError(() => validateVoiceOrigin(validOrigin(), 5 as unknown as string))
  })

  it('rejects bad identity fields', () => {
    for (const [field, value] of [
      ['backend', ''],
      ['backend', 5],
      ['model', ''],
      ['model', null],
      ['language', ''],
      ['language', 5],
      ['glossaryRevision', ''],
      ['glossaryRevision', null],
    ] as const) {
      expectTypeError(() => validateVoiceOrigin({ ...validOrigin(), [field]: value }, FINAL_TEXT))
    }
  })

  it('rejects confidence spans outside the final text or out of order', () => {
    const cases: unknown[] = [
      { start: -1, end: 2, confidence: 0.5 },
      { start: 2, end: 1, confidence: 0.5 },
      { start: 0, end: FINAL_TEXT.length + 1, confidence: 0.5 },
      { start: 0.5, end: 2, confidence: 0.5 },
      { start: '0', end: 2, confidence: 0.5 },
      { start: 0, end: 2, confidence: Number.NaN },
      { start: 0, end: 2, confidence: Number.POSITIVE_INFINITY },
      { start: 0, end: 2, confidence: -0.1 },
      { start: 0, end: 2, confidence: 1.1 },
      { start: 0, end: 2, confidence: '0.5' },
    ]
    for (const span of cases) {
      expectTypeError(() => validateVoiceOrigin(
        { ...validOrigin(), confidenceSpans: [span] },
        FINAL_TEXT,
      ))
    }
    expectTypeError(() => validateVoiceOrigin(
      {
        ...validOrigin(),
        confidenceSpans: [
          { start: 5, end: 8, confidence: 0.5 },
          { start: 2, end: 4, confidence: 0.5 },
        ],
      },
      FINAL_TEXT,
    ))
    expectTypeError(() => validateVoiceOrigin(
      {
        ...validOrigin(),
        confidenceSpans: [
          { start: 2, end: 8, confidence: 0.5 },
          { start: 7, end: 9, confidence: 0.5 },
        ],
      },
      FINAL_TEXT,
    ))
    expectTypeError(() => validateVoiceOrigin(
      { ...validOrigin(), confidenceSpans: 'none' as unknown as [] },
      FINAL_TEXT,
    ))
  })

  it('rejects zero-length confidence spans', () => {
    for (const start of [0, HONO_START, FINAL_TEXT.length]) {
      expectTypeError(() => validateVoiceOrigin(
        {
          ...validOrigin(),
          confidenceSpans: [{ start, end: start, confidence: 0.5 }],
        },
        FINAL_TEXT,
      ))
    }
  })

  it('rejects unsorted or overlapping replacement spans', () => {
    const hono = validOrigin().replacements[0]!
    const worktree = {
      start: WORKTREE_START,
      end: WORKTREE_START + 7,
      original: 'ворктри',
      replacement: 'ворктри',
      entryId: 'worktree',
    }
    expectTypeError(() => validateVoiceOrigin(
      { ...validOrigin(), replacements: [worktree, hono] },
      FINAL_TEXT,
    ))
    expectTypeError(() => validateVoiceOrigin(
      {
        ...validOrigin(),
        replacements: [
          hono,
          {
            start: HONO_START + 2,
            end: HONO_START + 4,
            original: 'no',
            replacement: 'no',
            entryId: 'hono',
          },
        ],
      },
      FINAL_TEXT,
    ))
    assert.equal(
      validateVoiceOrigin(
        { ...validOrigin(), replacements: [hono, worktree] },
        FINAL_TEXT,
      ).replacements.length,
      2,
    )
  })

  it('rejects replacements whose slice does not match the final text', () => {
    expectTypeError(() => validateVoiceOrigin(
      {
        ...validOrigin(),
        replacements: [{
          start: HONO_START,
          end: HONO_START + 4,
          original: 'хоно',
          replacement: 'Хоно',
          entryId: 'hono',
        }],
      },
      FINAL_TEXT,
    ))
    expectTypeError(() => validateVoiceOrigin(
      {
        ...validOrigin(),
        replacements: [{
          start: HONO_START,
          end: HONO_START + 4,
          original: 5,
          replacement: 'Hono',
          entryId: 'hono',
        } as unknown as VoiceOrigin['replacements'][number]],
      },
      FINAL_TEXT,
    ))
    expectTypeError(() => validateVoiceOrigin(
      {
        ...validOrigin(),
        replacements: [{
          start: HONO_START,
          end: HONO_START + 4,
          original: 'хоно',
          replacement: 'Hono',
          entryId: '',
        }],
      },
      FINAL_TEXT,
    ))
    expectTypeError(() => validateVoiceOrigin(
      {
        ...validOrigin(),
        replacements: [{
          start: FINAL_TEXT.length - 1,
          end: FINAL_TEXT.length + 1,
          original: '!',
          replacement: '!',
          entryId: 'hono',
        }],
      },
      FINAL_TEXT,
    ))
    expectTypeError(() => validateVoiceOrigin(
      { ...validOrigin(), replacements: 'none' as unknown as [] },
      FINAL_TEXT,
    ))
  })
})

describe('voiceBlock', () => {
  it('states dictation, lists replacements and quotes low-confidence fragments', () => {
    const origin = validOrigin()
    const block = voiceBlock(origin, FINAL_TEXT, 400)

    assert.match(block, /dictated/)
    assert.match(block, /whisper\.cpp/)
    assert.match(block, /large-v3/)
    assert.match(block, /language "ru"/)
    assert.match(block, /Glossary revision a{64}/)
    assert.match(block, /"хоно" → "Hono"/)
    assert.match(block, /"Hono"/)
    assert.match(block, /"ворктри"/)
    assert.doesNotMatch(block, /audio\/|base64|secret|api[_-]?key/i)
  })

  it('never exceeds maxChars, including tiny bounds', () => {
    const origin = validOrigin()
    for (const limit of [0, 1, 2, 10, 40, 80, 120, 400]) {
      const block = voiceBlock(origin, FINAL_TEXT, limit)
      assert.ok(block.length <= limit, `limit ${limit} produced ${block.length} characters`)
    }
    assert.equal(voiceBlock(origin, FINAL_TEXT, 0), '')
    assert.equal(voiceBlock(origin, FINAL_TEXT, 1), '…')
    expectTypeError(() => voiceBlock(origin, FINAL_TEXT, Number.NaN))
    expectTypeError(() => voiceBlock(origin, FINAL_TEXT, Number.POSITIVE_INFINITY))
  })

  it('caps the listed replacements and low-confidence fragments', () => {
    const finalText = Array.from({ length: 7 }, () => 'Hono').join(' ')
    const origin: VoiceOrigin = {
      ...validOrigin(),
      replacements: Array.from({ length: 7 }, (_, index) => ({
        start: index * 5,
        end: index * 5 + 4,
        original: `original-${index}`,
        replacement: 'Hono',
        entryId: 'hono',
      })),
      confidenceSpans: Array.from({ length: 7 }, (_, index) => ({
        start: index * 5,
        end: index * 5 + 4,
        confidence: 0.4,
      })),
    }
    const block = voiceBlock(origin, finalText, 400)

    assert.match(block, /\+2 more/)
    assert.doesNotMatch(block, /"original-5"/)
  })

  it('produces the same block for spread and structuredClone origins', () => {
    const origin = validOrigin()
    const block = voiceBlock(origin, FINAL_TEXT)
    assert.equal(voiceBlock({ ...origin }, FINAL_TEXT), block)
    assert.equal(voiceBlock(structuredClone(origin), FINAL_TEXT), block)
  })

  it('validates the origin and final text before rendering', () => {
    const origin = validOrigin()
    expectTypeError(() => voiceBlock(origin, 5 as unknown as string))
    expectTypeError(() => voiceBlock({ ...origin, backend: '' }, FINAL_TEXT))
    expectTypeError(() => voiceBlock(origin, 'другой текст'))
  })
})

describe('glossaryRevisionHash', () => {
  it('is a stable sha256 over ids and revisions regardless of order', () => {
    const entries = [
      { id: 'hono', revision: 2 },
      { id: 'pr', revision: 1 },
    ]
    const hash = glossaryRevisionHash(entries)
    assert.match(hash, /^[0-9a-f]{64}$/)
    assert.equal(hash, glossaryRevisionHash([...entries].reverse()))
    assert.equal(hash, glossaryRevisionHash(entries.map((entry) => ({ ...entry }))))
    assert.equal(
      hash,
      glossaryRevisionHash([
        { id: 'hono', revision: 2, canonical: 'Hono' } as { id: string; revision: number },
        { id: 'pr', revision: 1 },
      ]),
    )
  })

  it('changes when an id or revision changes', () => {
    const base = glossaryRevisionHash([{ id: 'hono', revision: 2 }])
    assert.notEqual(base, glossaryRevisionHash([{ id: 'hono', revision: 3 }]))
    assert.notEqual(base, glossaryRevisionHash([{ id: 'pr', revision: 2 }]))
    assert.notEqual(
      base,
      glossaryRevisionHash([{ id: 'hono', revision: 2 }, { id: 'pr', revision: 1 }]),
    )
  })

  it('rejects malformed input', () => {
    expectTypeError(() => glossaryRevisionHash('nope' as unknown as []))
    expectTypeError(() => glossaryRevisionHash([{ id: '', revision: 1 }]))
    expectTypeError(() => glossaryRevisionHash([{ id: 'hono', revision: 0 }]))
    expectTypeError(() => glossaryRevisionHash([{ id: 'hono', revision: 1.5 }]))
    expectTypeError(() => glossaryRevisionHash([
      { id: 'hono', revision: 1 },
      { id: 'hono', revision: 2 },
    ]))
  })
})
