import { describe, expect, it } from 'vitest'
import { GLOSSARY_ERROR_CODES, GLOSSARY_PREVIEW_MAX_CHARS, type StoredGlossaryEntryWire } from '@guanxi/contract'
import { voiceGlossaryEnglish, voiceGlossaryRussian } from '../../src/features/voice/messages.ts'
import {
  bodyFromDraft, changedFields, classify, draftFromEntry, emptyDraft, failureMessage, groupEntries, hasErrors, inView,
  overriddenAccountEntryIds, previewSegments, previewTooLong, splitVariants, validateDraft, type FailureCode,
} from '../../src/features/voice/model.ts'
import { LocalApiError, LocalApiShapeError } from '../../src/lib/local-api.ts'

const stored = (id: string, canonical: string, extra: Partial<StoredGlossaryEntryWire> & { variants?: string[] } = {}): StoredGlossaryEntryWire => ({
  id, scope: extra.scope ?? 'account', projectId: extra.projectId ?? null, active: extra.active ?? true, revision: extra.revision ?? 1, createdAt: 1, updatedAt: 1,
  entry: { id, canonical, variants: extra.variants ?? [], language: 'en' },
})

describe('draft to wire body', () => {
  it('splits spoken forms on lines, trims them and drops blank lines', () => {
    expect(splitVariants('  хоно \r\n\n хона\n   \n')).toEqual(['хоно', 'хона'])
  })

  it('sends a flag only when it differs from the default, and nothing else', () => {
    const draft = { ...emptyDraft(), canonical: ' Hono ', variants: 'хоно' }
    expect(bodyFromDraft(draft)).toEqual({ canonical: 'Hono', variants: ['хоно'], language: 'en' })
    expect(Object.keys(bodyFromDraft(draft)).sort()).toEqual(['canonical', 'language', 'variants'])
    expect(bodyFromDraft({ ...draft, caseSensitive: true, inflect: false })).toEqual({ canonical: 'Hono', variants: ['хоно'], language: 'en', caseSensitive: true, inflect: false })
  })

  it('round-trips a stored entry through a draft without gaining or losing a field', () => {
    const entry = stored('a', 'PR', { variants: ['пиар', 'пи ар'] })
    entry.entry.inflect = false
    entry.entry.caseSensitive = true
    expect(bodyFromDraft(draftFromEntry(entry))).toEqual({ canonical: 'PR', variants: ['пиар', 'пи ар'], language: 'en', caseSensitive: true, inflect: false })
    const plain = stored('b', 'Hono')
    expect(bodyFromDraft(draftFromEntry(plain))).toEqual({ canonical: 'Hono', variants: [], language: 'en' })
  })

  it('defaults a new draft to the chosen project, or to the account when there is none', () => {
    expect(emptyDraft()).toMatchObject({ scope: 'account', projectId: '' })
    expect(emptyDraft('p1')).toMatchObject({ scope: 'project', projectId: 'p1' })
  })
})

describe('validation uses the contract limits', () => {
  it('accepts a valid draft with no errors', () => {
    expect(validateDraft({ ...emptyDraft(), canonical: 'Hono' }, false)).toEqual({})
  })

  it('requires a canonical term and a project for a project entry, nothing else', () => {
    const errors = validateDraft({ ...emptyDraft('p1'), projectId: '', scope: 'project' }, true)
    expect(errors.canonical?.key).toBe('voiceGlossary.validation.canonical.required')
    expect(errors.project?.key).toBe('voiceGlossary.validation.project.required')
    expect(errors.variants).toBeUndefined()
  })

  it('reports the exact contract limit for a long term, a long spoken form (with its line) and too many forms', () => {
    const long = validateDraft({ ...emptyDraft(), canonical: 'x'.repeat(201) }, false)
    expect(long.canonical).toEqual({ key: 'voiceGlossary.validation.canonical.long', values: { limit: 200 } })
    expect(validateDraft({ ...emptyDraft(), canonical: 'x'.repeat(200) }, false)).toEqual({})
    const variant = validateDraft({ ...emptyDraft(), canonical: 'a', variants: `one\ntwo\n${'y'.repeat(201)}` }, false)
    expect(variant.variants).toEqual({ key: 'voiceGlossary.validation.variants.long', values: { limit: 200, line: 3 } })
    const many = validateDraft({ ...emptyDraft(), canonical: 'a', variants: Array.from({ length: 201 }, (_, index) => `v${index}`).join('\n') }, false)
    expect(many.variants).toEqual({ key: 'voiceGlossary.validation.variants.many', values: { limit: 200 } })
    expect(validateDraft({ ...emptyDraft(), canonical: 'a', variants: Array.from({ length: 200 }, (_, index) => `v${index}`).join('\n') }, false)).toEqual({})
    expect(hasErrors(many)).toBe(true)
    expect(hasErrors({})).toBe(false)
  })
})

describe('view grouping and derived marks', () => {
  const names = new Map([['p1', 'Zeta'], ['p2', 'alpha']])
  it('puts account entries first, then projects by name, and sorts entries by term', () => {
    const groups = groupEntries([
      stored('1', 'Zed', { scope: 'project', projectId: 'p1' }), stored('2', 'beta'), stored('3', 'Alpha'),
      stored('4', 'Mid', { scope: 'project', projectId: 'p2' }), stored('5', 'Orphan', { scope: 'project', projectId: 'gone' }),
    ], names)
    expect(groups.map((group) => group.key)).toEqual(['account', 'project:p2', 'project:gone', 'project:p1'])
    expect(groups[0]?.entries.map((entry) => entry.entry.canonical)).toEqual(['Alpha', 'beta'])
  })

  it('marks an account entry overridden only by an active entry of that project with the same term, ignoring case', () => {
    const entries = [
      stored('a1', 'Hono'), stored('a2', 'Vite'), stored('a3', 'Sqlite', { active: false }),
      stored('p1-hono', 'hono', { scope: 'project', projectId: 'p1' }),
      stored('p1-off', 'Vite', { scope: 'project', projectId: 'p1', active: false }),
      stored('p2-sqlite', 'SQLite', { scope: 'project', projectId: 'p2' }),
    ]
    expect([...overriddenAccountEntryIds(entries, 'p1')]).toEqual(['a1'])
    expect([...overriddenAccountEntryIds(entries, 'p2')]).toEqual([])
    expect([...overriddenAccountEntryIds(entries, 'other')]).toEqual([])
  })

  it('decides whether an entry belongs in a view', () => {
    const account = stored('a', 'A'), p1 = stored('b', 'B', { scope: 'project', projectId: 'p1' }), off = stored('c', 'C', { active: false })
    expect(inView(account, '', true) && inView(p1, '', true)).toBe(true)
    expect(inView(p1, 'p2', true)).toBe(false)
    expect(inView(p1, 'p1', true)).toBe(true)
    expect(inView(account, 'p1', true)).toBe(true)
    expect(inView(off, '', false)).toBe(false)
    expect(inView(off, '', true)).toBe(true)
  })
})

describe('preview highlighting', () => {
  const replacement = (start: number, end: number, original: string, value: string) => ({ start, end, original, replacement: value, entryId: 'e' })
  it('maps offsets in the original text onto the replaced text, even when lengths change', () => {
    const view = previewSegments({ text: 'и PR-а, Hono', replacements: [replacement(2, 7, 'пиара', 'PR-а'), replacement(9, 13, 'хоно', 'Hono')] })
    expect(view.highlighted).toBe(true)
    expect(view.segments).toEqual([
      { text: 'и ', replaced: false }, { text: 'PR-а', replaced: true }, { text: ', ', replaced: false }, { text: 'Hono', replaced: true },
    ])
    expect(view.segments.map((segment) => segment.text).join('')).toBe('и PR-а, Hono')
  })

  it('returns the text as one plain run when nothing was replaced', () => {
    expect(previewSegments({ text: 'ничего', replacements: [] })).toEqual({ segments: [{ text: 'ничего', replaced: false }], highlighted: false })
  })

  it('refuses to highlight when the offsets do not describe the returned text', () => {
    const view = previewSegments({ text: 'wrong place', replacements: [replacement(0, 4, 'хоно', 'Hono')] })
    expect(view).toEqual({ segments: [{ text: 'wrong place', replaced: false }], highlighted: false })
    expect(previewSegments({ text: 'ab', replacements: [replacement(1, 0, 'x', 'b')] }).highlighted).toBe(false)
    expect(previewSegments({ text: 'ab', replacements: [replacement(0, 2, 'xx', 'a'), replacement(1, 2, 'x', 'b')] }).highlighted).toBe(false)
  })

  it('knows the transport budget exactly', () => {
    expect(previewTooLong('x'.repeat(GLOSSARY_PREVIEW_MAX_CHARS))).toBe(false)
    expect(previewTooLong('x'.repeat(GLOSSARY_PREVIEW_MAX_CHARS + 1))).toBe(true)
  })
})

describe('history diff', () => {
  it('lists exactly the fields that changed and nothing for a first revision', () => {
    const before = stored('a', 'Hono', { variants: ['хоно'] }).entry
    expect(changedFields(null, before)).toEqual([])
    expect(changedFields(before, { ...before })).toEqual([])
    expect(changedFields(before, { ...before, canonical: 'Hono.js', variants: ['хоно', 'хона'], language: 'any', caseSensitive: true, inflect: false }))
      .toEqual(['canonical', 'variants', 'language', 'caseSensitive', 'inflect'])
    expect(changedFields(before, { ...before, inflect: true })).toEqual([])
  })
})

describe('failures', () => {
  const codes: FailureCode[] = [...GLOSSARY_ERROR_CODES, 'unexpected_response', 'shape', 'unreachable']
  it('classifies transport, shape and contract errors', () => {
    expect(classify(new LocalApiError(422, 'glossary_invalid'))).toBe('glossary_invalid')
    expect(classify(new LocalApiError(500, 'unexpected_response'))).toBe('unexpected_response')
    expect(classify(new LocalApiShapeError('/x', []))).toBe('shape')
    expect(classify(new TypeError('Failed to fetch'))).toBe('unreachable')
  })

  it('has a message in both locales for every code the node can answer with', () => {
    for (const code of codes) {
      for (const intent of ['read', 'write'] as const) {
        const key = failureMessage(code, intent)
        expect(voiceGlossaryEnglish[key], `${code}/${intent}`).toMatch(/\S/u)
        expect(voiceGlossaryRussian[key], `${code}/${intent} ru`).toMatch(/\S/u)
      }
    }
  })

  it('never makes an error message mention the user\'s terms: no message carries a placeholder', () => {
    for (const code of codes) for (const intent of ['read', 'write'] as const) expect(voiceGlossaryEnglish[failureMessage(code, intent)]).not.toMatch(/\{/u)
  })

  it('tells an unknown write outcome apart from a read failure', () => {
    expect(failureMessage('unreachable', 'write')).not.toBe(failureMessage('unreachable', 'read'))
    expect(voiceGlossaryEnglish[failureMessage('unreachable', 'write')]).toMatch(/unknown whether/u)
  })
})

describe('locale catalogue', () => {
  const placeholders = (text: string) => [...text.matchAll(/\{([A-Za-z]+)\}/gu)].map((match) => match[1]).sort()
  it('has a curated Russian string with the same placeholders for every English key', () => {
    for (const key of Object.keys(voiceGlossaryEnglish) as Array<keyof typeof voiceGlossaryEnglish>) {
      expect(voiceGlossaryRussian[key], key).toMatch(/\S/u)
      expect(placeholders(voiceGlossaryRussian[key]), key).toEqual(placeholders(voiceGlossaryEnglish[key]))
    }
    expect(Object.keys(voiceGlossaryRussian).length).toBe(Object.keys(voiceGlossaryEnglish).length)
  })

  it('shows the D-157 inflection example in both languages', () => {
    expect(voiceGlossaryEnglish['voiceGlossary.field.variants.example']).toContain('PR-а')
    expect(voiceGlossaryRussian['voiceGlossary.field.variants.example']).toContain('PR-а')
  })
})
