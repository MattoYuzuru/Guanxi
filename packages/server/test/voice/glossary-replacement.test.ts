import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  applyGlossary,
  compileGlossary,
  type GlossaryEntry,
} from '../../src/voice/glossary.ts'
import { foldKey } from '../../src/voice/translit.ts'

interface GoldenCase {
  input: string
  expected: string
  note: string
}

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/golden.json', import.meta.url), 'utf8'),
) as GoldenCase[]

const ENTRIES: GlossaryEntry[] = [
  { id: 'guanxi', canonical: 'Guanxi', variants: ['гуанси', 'гуаньси', 'гуанкси'], language: 'en' },
  { id: 'hono', canonical: 'Hono', variants: ['хоно', 'хона'], language: 'en' },
  { id: 'pr', canonical: 'PR', variants: ['пиар'], language: 'en' },
  {
    id: 'worktree',
    canonical: 'worktree',
    variants: ['воркт три', 'ворк три', 'вортри', 'ворктри'],
    language: 'en',
  },
  { id: 'deepseek', canonical: 'DeepSeek', variants: ['дипсик', 'дип сик'], language: 'en' },
  { id: 'codex', canonical: 'Codex', variants: ['кодекс'], language: 'en' },
  { id: 'claude', canonical: 'Claude', variants: ['клод'], language: 'en' },
  { id: 'sonnet', canonical: 'Sonnet', variants: ['сонет', 'соннет'], language: 'en' },
  { id: 'opus', canonical: 'Opus', variants: ['опус'], language: 'en' },
  { id: 'mcp', canonical: 'MCP', variants: ['эм си пи', 'эмсипи'], language: 'en' },
  { id: 'ollama', canonical: 'Ollama', variants: ['оллама', 'олама'], language: 'en' },
  { id: 'fedora', canonical: 'Fedora', variants: ['федора'], language: 'en' },
  { id: 'work', canonical: 'work', variants: ['ворк'], language: 'en' },
]

const glossary = compileGlossary(ENTRIES)

function expectTypeError(run: () => unknown, ...patterns: RegExp[]): void {
  assert.throws(run, (error: unknown) => {
    if (!(error instanceof TypeError)) return false
    for (const pattern of patterns) assert.match(error.message, pattern)
    return true
  })
}

describe('foldKey', () => {
  it('folds Cyrillic and Latin spellings to one key', () => {
    assert.equal(foldKey('хоно'), 'hono')
    assert.equal(foldKey('Hono'), 'hono')
    assert.equal(foldKey('гуанси'), 'guansi')
    assert.equal(foldKey('Guanxi'), 'guanksi')
    assert.equal(foldKey('гуанкси'), 'guanksi')
    assert.equal(foldKey('кодекс'), 'kodeks')
    assert.equal(foldKey('Codex'), 'kodeks')
    assert.equal(foldKey('й'), 'i')
    assert.equal(foldKey('юла'), 'yula')
    assert.equal(foldKey('яма'), 'yama')
    assert.equal(foldKey('чудо'), 'chudo')
    assert.equal(foldKey('щука'), 'schuka')
    assert.equal(foldKey('цена'), 'tsena')
  })

  it('normalises Latin phonetics', () => {
    assert.equal(foldKey('Khan'), 'han')
    assert.equal(foldKey('хан'), 'han')
    assert.equal(foldKey('phone'), 'fone')
    assert.equal(foldKey('wow'), 'vov')
    assert.equal(foldKey('cent'), 'sent')
    assert.equal(foldKey('cat'), 'kat')
    assert.equal(foldKey('cyan'), 'syan')
    assert.equal(foldKey('qatar'), 'katar')
    assert.equal(foldKey('box'), 'boks')
    assert.equal(foldKey('jazz'), 'dzhaz')
  })

  it('strips marks, doubles and non-word characters', () => {
    assert.equal(foldKey('café'), 'kafe')
    assert.equal(foldKey('cafe\u0301'), 'kafe')
    assert.equal(foldKey('Ёрш'), 'ersh')
    assert.equal(foldKey('ъь'), '')
    assert.equal(foldKey('Sonnet'), 'sonet')
    assert.equal(foldKey('Ollama'), 'olama')
    assert.equal(foldKey('Hono!'), 'hono')
    assert.equal(foldKey('GPT-4'), 'gpt4')
    assert.equal(foldKey(''), '')
  })

  it('keeps explicitly irregular spellings distinct', () => {
    assert.notEqual(foldKey('гуанси'), foldKey('Guanxi'))
    assert.notEqual(foldKey('пиар'), foldKey('PR'))
    assert.notEqual(foldKey('worktree'), foldKey('ворктри'))
  })
})

describe('golden glossary replacement cases', () => {
  for (const [index, testCase] of golden.entries()) {
    it(`case ${String(index + 1).padStart(2, '0')}: ${testCase.note}`, () => {
      const result = applyGlossary(glossary, testCase.input)
      assert.equal(result.text, testCase.expected)

      let previousEnd = 0
      for (const replacement of result.replacements) {
        assert.ok(replacement.start < replacement.end)
        assert.ok(replacement.start >= previousEnd, 'replacements must not overlap')
        assert.equal(
          testCase.input.slice(replacement.start, replacement.end),
          replacement.original,
        )
        previousEnd = replacement.end
      }
    })
  }

  it('has at least forty golden cases', () => {
    assert.ok(golden.length >= 40)
  })
})

describe('replacement offsets', () => {
  it('reports original offsets and originals in ascending order', () => {
    const source = 'хоно, гуанси и кодекс'
    const result = applyGlossary(glossary, source)
    assert.equal(result.text, 'Hono, Guanxi и Codex')
    assert.deepEqual(result.replacements, [
      { start: 0, end: 4, original: 'хоно', replacement: 'Hono', entryId: 'hono' },
      { start: 6, end: 12, original: 'гуанси', replacement: 'Guanxi', entryId: 'guanxi' },
      { start: 15, end: 21, original: 'кодекс', replacement: 'Codex', entryId: 'codex' },
    ])
    for (const replacement of result.replacements) {
      assert.equal(source.slice(replacement.start, replacement.end), replacement.original)
    }
  })

  it('spans a multi-word original including its single space', () => {
    const source = 'воркт три и дип сик'
    const result = applyGlossary(glossary, source)
    assert.equal(result.text, 'worktree и DeepSeek')
    assert.deepEqual(
      result.replacements.map((replacement) => [
        replacement.start,
        replacement.end,
        replacement.original,
        replacement.replacement,
      ]),
      [
        [0, 9, 'воркт три', 'worktree'],
        [12, 19, 'дип сик', 'DeepSeek'],
      ],
    )
  })

  it('emits no replacement when the original already equals the canonical output', () => {
    const result = applyGlossary(glossary, 'Hono')
    assert.deepEqual(result, { text: 'Hono', replacements: [] })
  })

  it('preserves spacing, punctuation and newlines byte-for-byte', () => {
    const source = '  Хоно,\n\nгуанси!  '
    assert.equal(applyGlossary(glossary, source).text, '  Hono,\n\nGuanxi!  ')
  })
})

describe('overlap prevention', () => {
  it('does not match a shorter entry inside an already replaced span', () => {
    const noOverlap = compileGlossary([
      { id: 'deepseek', canonical: 'DeepSeek', variants: ['дип сик'], language: 'en' },
      { id: 'sik', canonical: 'Sick', variants: ['сик'], language: 'en' },
    ])
    const result = applyGlossary(noOverlap, 'дип сик')
    assert.equal(result.text, 'DeepSeek')
    assert.deepEqual(result.replacements, [
      { start: 0, end: 7, original: 'дип сик', replacement: 'DeepSeek', entryId: 'deepseek' },
    ])
  })
})

describe('case-sensitive matching', () => {
  const caseSensitive = compileGlossary([
    {
      id: 'hono',
      canonical: 'Hono',
      variants: ['hono'],
      language: 'en',
      caseSensitive: true,
    },
  ])

  it('matches exact forms only and always outputs canonical casing', () => {
    assert.equal(applyGlossary(caseSensitive, 'hono').text, 'Hono')
    assert.equal(applyGlossary(caseSensitive, 'Hono').text, 'Hono')
    assert.equal(applyGlossary(caseSensitive, 'HONO').text, 'HONO')
    assert.equal(applyGlossary(caseSensitive, 'хоно').text, 'хоно')
  })

  it('does not inflect a case-sensitive entry', () => {
    const pr = compileGlossary([
      {
        id: 'pr',
        canonical: 'PR',
        variants: ['пиар'],
        language: 'en',
        caseSensitive: true,
      },
    ])
    assert.equal(applyGlossary(pr, 'пиар').text, 'PR')
    assert.equal(applyGlossary(pr, 'пиара').text, 'пиара')
  })
})

describe('inflection controls', () => {
  it('does not inflect when inflect is false', () => {
    const noInflect = compileGlossary([
      { id: 'pr', canonical: 'PR', variants: ['пиар'], language: 'en', inflect: false },
    ])
    assert.equal(applyGlossary(noInflect, 'пиар').text, 'PR')
    assert.equal(applyGlossary(noInflect, 'пиара').text, 'пиара')
  })

  it('only inflects Latin English canonicals in Cyrillic text', () => {
    const russian = compileGlossary([
      { id: 'opus', canonical: 'Opus', variants: ['опус'], language: 'ru' },
    ])
    assert.equal(applyGlossary(russian, 'опус').text, 'Opus')
    assert.equal(applyGlossary(russian, 'опуса').text, 'опуса')

    const anyLanguage = compileGlossary([
      { id: 'opus', canonical: 'Opus', variants: ['опус'], language: 'any' },
    ])
    assert.equal(applyGlossary(anyLanguage, 'опуса').text, 'опуса')
  })

  it('does not inflect a mixed-script candidate', () => {
    assert.equal(applyGlossary(glossary, 'PRа').text, 'PRа')
    assert.equal(applyGlossary(glossary, 'пиаRа').text, 'пиаRа')
  })

  it('matches an inflection ending after a combining stress mark', () => {
    assert.equal(applyGlossary(glossary, 'пиара\u0301').text, 'PR-а\u0301')
  })

  it('requires a stem of at least two letters', () => {
    const oneLetter = compileGlossary([
      { id: 'pr', canonical: 'PR', variants: ['п'], language: 'en' },
    ])
    assert.equal(applyGlossary(oneLetter, 'па').text, 'па')
    assert.equal(applyGlossary(oneLetter, 'п').text, 'PR')
  })

  it('prefers a full direct match over inflecting another entry', () => {
    const directWins = compileGlossary([
      { id: 'early', canonical: 'Hono', variants: ['хон'], language: 'en' },
      { id: 'late', canonical: 'Hona', variants: ['хона'], language: 'en' },
    ])
    const result = applyGlossary(directWins, 'хона')
    assert.equal(result.text, 'Hona')
    assert.equal(result.replacements[0]?.entryId, 'late')
  })
})

describe('validation', () => {
  it('rejects duplicate ids', () => {
    expectTypeError(
      () =>
        compileGlossary([
          { id: 'same', canonical: 'One', variants: [], language: 'en' },
          { id: 'same', canonical: 'Two', variants: [], language: 'en' },
        ]),
      /duplicate id/i,
      /same/,
    )
  })

  it('rejects an empty id and an empty canonical term', () => {
    expectTypeError(
      () =>
        compileGlossary([
          { id: '   ', canonical: 'Hono', variants: [], language: 'en' },
        ]),
      /empty id/i,
    )
    expectTypeError(
      () =>
        compileGlossary([
          { id: 'hono', canonical: '   ', variants: [], language: 'en' },
        ]),
      /empty canonical/i,
      /hono/,
    )
  })

  it('rejects a variant whose fold key is empty', () => {
    expectTypeError(
      () =>
        compileGlossary([
          { id: 'hono', canonical: 'Hono', variants: ['!!!'], language: 'en' },
        ]),
      /variant/i,
      /empty fold key/i,
      /hono/,
    )
  })

  it('rejects a canonical term whose fold key is empty', () => {
    expectTypeError(
      () => compileGlossary([{ id: 'symbols', canonical: '!!!', variants: [], language: 'en' }]),
      /canonical/i,
      /empty fold key/i,
      /symbols/,
    )
  })

  it('rejects key collisions across entries and names both ids', () => {
    expectTypeError(
      () =>
        compileGlossary([
          { id: 'first', canonical: 'Hono', variants: [], language: 'en' },
          { id: 'second', canonical: 'Other', variants: ['хоно'], language: 'en' },
        ]),
      /collision/i,
      /first/,
      /second/,
    )
  })

  it('allows duplicate keys inside one entry', () => {
    const oneEntry = compileGlossary([
      { id: 'hono', canonical: 'Hono', variants: ['hono', 'хоно'], language: 'en' },
    ])
    assert.equal(applyGlossary(oneEntry, 'хоно').text, 'Hono')
  })

  it('rejects invalid language and boolean flags', () => {
    expectTypeError(
      () =>
        compileGlossary([
          {
            id: 'bad-language',
            canonical: 'Hono',
            variants: [],
            language: 'de' as 'en',
          },
        ]),
      /invalid language/i,
      /bad-language/,
    )
    expectTypeError(
      () =>
        compileGlossary([
          {
            id: 'bad-flag',
            canonical: 'Hono',
            variants: [],
            language: 'en',
            caseSensitive: 'yes' as unknown as boolean,
          },
        ]),
      /caseSensitive/i,
      /bad-flag/,
    )
  })

  it('rejects non-array input', () => {
    expectTypeError(
      () => compileGlossary(null as unknown as GlossaryEntry[]),
      /must be an array/i,
    )
  })
})

describe('purity and determinism', () => {
  it('produces identical results for repeated applications and recompilations', () => {
    const source = 'Кодекс и хоно, дип сик. `гуанси`'
    const first = applyGlossary(glossary, source)
    const second = applyGlossary(glossary, source)
    assert.deepEqual(second, first)

    const recompiled = compileGlossary(ENTRIES)
    assert.deepEqual(applyGlossary(recompiled, source), first)
  })

  it('does not retain mutable references to the input entries', () => {
    const entries: GlossaryEntry[] = [
      { id: 'hono', canonical: 'Hono', variants: ['хоно'], language: 'en' },
    ]
    const compiled = compileGlossary(entries)
    entries[0]!.canonical = 'Changed'
    entries[0]!.variants.push('другое')
    assert.equal(compiled.entries[0]!.canonical, 'Hono')
    assert.equal(applyGlossary(compiled, 'хоно').text, 'Hono')
    assert.equal(applyGlossary(compiled, 'другое').text, 'другое')
  })

  it('accepts an empty glossary', () => {
    const empty = compileGlossary([])
    assert.deepEqual(applyGlossary(empty, 'хоно'), { text: 'хоно', replacements: [] })
  })
})

describe('performance', () => {
  it('processes 50 KB with 500 entries under the 200 ms bound (2x CI cap)', () => {
    const entries: GlossaryEntry[] = Array.from({ length: 500 }, (_, index) => ({
      id: `term-${index}`,
      canonical: `Term${index}`,
      variants: [`терм${index}`],
      language: 'en',
    }))
    const bigGlossary = compileGlossary(entries)
    const unit = 'У нас терм0 и Term1, потом просто текст без терминов. '
    let source = ''
    while (source.length < 50_000) source += unit

    const started = performance.now()
    const result = applyGlossary(bigGlossary, source)
    const elapsed = performance.now() - started

    assert.ok(result.replacements.length > 0)
    // The contract is <200 ms. Allow 2x for shared/CI machines; local runs are far below.
    assert.ok(elapsed < 400, `expected <400 ms with the 2x CI margin, got ${elapsed.toFixed(1)} ms`)
  })

  it('processes 50 KB with 500 long multi-word entries under the 200 ms bound (2x CI cap)', () => {
    const suffixes = ['', ' для', ' для проверки']
    const entries: GlossaryEntry[] = Array.from({ length: 500 }, (_, index) => ({
      id: `long-term-${index}`,
      canonical: `LongTerm${index}`,
      variants: [`очень длинное название термина номер ${index}${suffixes[index % 3]}`],
      language: 'en',
    }))
    const bigGlossary = compileGlossary(entries)
    const unit = 'очень длинное название термина номер 0 и просто текст без терминов для проверки '
    let source = ''
    while (source.length < 50_000) source += unit

    const started = performance.now()
    const result = applyGlossary(bigGlossary, source)
    const elapsed = performance.now() - started

    assert.ok(result.replacements.length > 0)
    // The contract is <200 ms. Allow 2x for shared/CI machines; local runs are far below.
    assert.ok(elapsed < 400, `expected <400 ms with the 2x CI margin, got ${elapsed.toFixed(1)} ms`)
  })
})
