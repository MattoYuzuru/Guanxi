/**
 * Script- and phonetics-aware folding key for glossary matching.
 *
 * The key deliberately bridges scripts and common English/Russian phonetic drift; it is not a
 * general transliteration. Irregular spellings still need explicit glossary variants.
 */

const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = Object.freeze({
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
})

const SOFT_VOWELS = new Set(['e', 'i', 'y'])

/**
 * Fold one word or phrase to its matching key.
 *
 * Order: lower-case, NFC then NFKD, drop combining marks, map Cyrillic to Latin, normalise
 * Latin phonetics, collapse doubled letters, keep only Unicode letters and digits.
 *
 * Cyrillic is mapped inline and its Latin output is not fed back through the Latin phonetic
 * rules: `ч` stays `ch` rather than becoming `kh` through the soft-`c` rule. Digraphs split
 * across a script boundary (`c` + Cyrillic `е`, `п` + `х`) are therefore not bridged; explicit
 * glossary variants cover such mixed-script spellings.
 */
export function foldKey(value: string): string {
  const normalized = value
    .toLowerCase()
    .normalize('NFC')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/ё/gu, 'е')

  let latin = ''
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!
    const cyrillic = CYRILLIC_TO_LATIN[character]
    if (cyrillic !== undefined) {
      latin += cyrillic
      continue
    }
    if (character === 'k' && normalized[index + 1] === 'h') {
      latin += 'h'
      index += 1
      continue
    }
    if (character === 'p' && normalized[index + 1] === 'h') {
      latin += 'f'
      index += 1
      continue
    }
    if (character === 'w') {
      latin += 'v'
      continue
    }
    if (character === 'c') {
      const next = normalized[index + 1]
      latin += next !== undefined && SOFT_VOWELS.has(next) ? 's' : 'k'
      continue
    }
    if (character === 'q') {
      latin += 'k'
      continue
    }
    if (character === 'x') {
      latin += 'ks'
      continue
    }
    if (character === 'j') {
      latin += 'dzh'
      continue
    }
    latin += character
  }

  return latin.replace(/(\p{L})\1+/gu, '$1').replace(/[^\p{L}\p{N}]/gu, '')
}
