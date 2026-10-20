/**
 * +40% pseudo-locale for G15: accents every Latin letter and pads the string, keeping
 * {placeholders} intact, so clipping and hard-coded text show up in the catalog.
 */
const ACCENTED: Record<string, string> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ď', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ', k: 'ķ',
  l: 'ĺ', m: 'ɱ', n: 'ñ', o: 'ó', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'ú', v: 'ṽ',
  w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž', A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ď', E: 'É', F: 'Ƒ', G: 'Ĝ',
  H: 'Ĥ', I: 'Í', J: 'Ĵ', K: 'Ķ', L: 'Ĺ', M: 'Ṁ', N: 'Ñ', O: 'Ó', P: 'Þ', Q: 'Ǫ', R: 'Ŕ',
  S: 'Š', T: 'Ţ', U: 'Ú', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
}

export const PSEUDO_EXPANSION = 0.4

export function pseudoLocalize(text: string): string {
  let visible = 0
  const accented = text.replace(/\{[^}]*\}|[A-Za-z]/g, (match) => {
    if (match.startsWith('{')) return match
    visible += 1
    return ACCENTED[match] ?? match
  })
  const others = text.replace(/\{[^}]*\}/g, '').replace(/[A-Za-z]/g, '').length
  const padding = Math.ceil((visible + others) * PSEUDO_EXPANSION)
  return `⟦${accented}${'·'.repeat(Math.max(padding - 2, 0))}⟧`
}
