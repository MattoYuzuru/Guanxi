/**
 * Palette candidate generator (UI redesign lane, D-201). Builds the twelve-step neutral ramps,
 * accent and status colours for each candidate in OKLCH, solves lightness so the FOUNDATIONS
 * contrast floors hold against BOTH the chrome canvas (step 2) and the session surface (step 1),
 * and prints JSON. `--apply <id>` is consumed by apply.mjs; this file never writes tokens.
 *
 *   node packages/ui/tokens/palettes/generate.mjs            # all candidates, JSON report
 */
import Color from 'colorjs.io'

const hex = c => new Color(c).to('srgb').toGamut({ space: 'srgb' }).toString({ format: 'hex', collapse: false }).toUpperCase()
const oklch = (l, c, h) => new Color('oklch', [l, c, h])
const contrast = (a, b) => Number(new Color(a).contrast(new Color(b), 'WCAG21').toFixed(2))
const mix = (from, to, amount) => {
  const ch = h => h.slice(1).match(/../g).map(v => parseInt(v, 16))
  const [a, b] = [ch(from), ch(to)]
  return '#' + a.map((v, i) => Math.round(v * (1 - amount) + b[i] * amount).toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** Smallest change of lightness from `start` (moving `dir`) that reaches `ratio` against all bgs. */
function solve(start, dir, c, h, bgs, ratio) {
  for (let l = start; l > 0 && l < 1; l += dir * 0.0025) {
    const value = hex(oklch(l, c, h))
    if (bgs.every(bg => contrast(value, bg) >= ratio)) return value
  }
  throw new Error(`cannot reach ${ratio}`)
}

export const candidates = [
  {
    id: 'porcelain-cobalt',
    name: 'Porcelain + Cobalt',
    summary: 'Cool porcelain chrome, white session surface, saturated cobalt accent. Crisp and technical.',
    neutral: { hue: 255, chroma: 0.008, darkHue: 260, darkChroma: 0.010 },
    accent: { hue: 263, chroma: 0.19, darkChroma: 0.13 },
  },
  {
    id: 'mist-indigo',
    name: 'Mist + Indigo',
    summary: 'Faintly violet mist chrome, white surface, indigo-blue accent. Softer and calmer.',
    neutral: { hue: 285, chroma: 0.010, darkHue: 285, darkChroma: 0.012 },
    accent: { hue: 274, chroma: 0.17, darkChroma: 0.12 },
  },
  {
    id: 'linen-azure',
    name: 'Linen + Azure',
    summary: 'Warm linen chrome, white surface, clear azure accent. Warm frame, cool signal.',
    neutral: { hue: 75, chroma: 0.007, darkHue: 70, darkChroma: 0.006 },
    accent: { hue: 252, chroma: 0.17, darkChroma: 0.12 },
  },
]

// Fill and border lightness targets (OKLCH L) for steps 3–8; 1, 2 are surfaces; 9–12 are solved.
const lightL = { 1: 1, 2: 0.962, 3: 0.948, 4: 0.928, 5: 0.905, 6: 0.88, 7: 0.84, 8: 0.74 }
const darkL = { 1: 0.212, 2: 0.17, 3: 0.248, 4: 0.272, 5: 0.298, 6: 0.33, 7: 0.375, 8: 0.45 }

export function build(candidate) {
  const out = {}
  for (const theme of ['light', 'dark']) {
    const dark = theme === 'dark'
    const h = dark ? candidate.neutral.darkHue : candidate.neutral.hue
    const c = dark ? candidate.neutral.darkChroma : candidate.neutral.chroma
    const L = dark ? darkL : lightL
    const ramp = {}
    for (const step of [1, 2, 3, 4, 5, 6, 7, 8]) ramp[step] = hex(oklch(L[step], step === 1 && !dark ? 0 : c, h))
    const bgs = [ramp[1], ramp[2]]
    const dir = dark ? 1 : -1
    ramp[9] = solve(dark ? 0.5 : 0.7, dir, c, h, bgs, 3.2)
    ramp[10] = solve(dark ? 0.6 : 0.6, dir, c, h, bgs, 4.7)
    ramp[11] = solve(dark ? 0.7 : 0.5, dir, c, h, bgs, 7.4)
    ramp[12] = hex(oklch(dark ? 0.955 : 0.21, c * 1.2, h))
    const a = candidate.accent
    const accentChroma = dark ? a.darkChroma : a.chroma
    const accent = solve(dark ? 0.62 : 0.6, dir, accentChroma, a.hue, bgs, dark ? 6.5 : 5.2)
    const onAccent = dark ? ramp[2] : '#FFFFFF'
    const status = {
      accent,
      success: solve(dark ? 0.7 : 0.58, dir, dark ? 0.13 : 0.13, 150, bgs, dark ? 7 : 4.9),
      warning: solve(dark ? 0.75 : 0.6, dir, dark ? 0.13 : 0.12, 70, bgs, dark ? 7 : 4.9),
      danger: solve(dark ? 0.68 : 0.58, dir, dark ? 0.14 : 0.18, 26, bgs, dark ? 6.5 : 4.9),
      info: solve(dark ? 0.7 : 0.56, dir, dark ? 0.1 : 0.12, 235, bgs, dark ? 7 : 4.9),
    }
    const toward = dark ? '#FFFFFF' : ramp[12]
    const states = { hover: mix(accent, toward, 0.12), pressed: mix(accent, toward, 0.24) }
    out[theme] = {
      ramp, status, onAccent, states,
      contrast: {
        textOnCanvas: contrast(ramp[12], ramp[2]), textOnSurface: contrast(ramp[12], ramp[1]),
        secondary: Math.min(contrast(ramp[11], ramp[2]), contrast(ramp[11], ramp[1])),
        muted: Math.min(contrast(ramp[10], ramp[2]), contrast(ramp[10], ramp[1])),
        controlBorder: Math.min(contrast(ramp[9], ramp[2]), contrast(ramp[9], ramp[1])),
        accentOnCanvas: contrast(accent, ramp[2]), accentOnSurface: contrast(accent, ramp[1]),
        onAccent: contrast(onAccent, accent), onAccentHover: contrast(onAccent, states.hover), onAccentPressed: contrast(onAccent, states.pressed),
        success: contrast(status.success, ramp[2]), warning: contrast(status.warning, ramp[2]),
        danger: contrast(status.danger, ramp[2]), info: contrast(status.info, ramp[2]),
        canvasVsSurface: contrast(ramp[1], ramp[2]),
      },
    }
  }
  return out
}

/** Semantic roles (FOUNDATIONS §1.1–§1.3) expressed as CSS for a scoped preview of one candidate. */
export function scopedCss(candidate) {
  const built = build(candidate)
  let css = ''
  for (const theme of ['light', 'dark']) {
    const { ramp, status, onAccent, states } = built[theme]
    const vars = {
      'background-primary': ramp[2], 'background-secondary': ramp[1], 'background-tertiary': ramp[3],
      'background-hover': ramp[4], 'background-pressed': ramp[5], 'background-disabled': ramp[5],
      'background-inverse': built[theme === 'light' ? 'dark' : 'light'].ramp[2],
      'background-accent': status.accent, 'background-accent-hover': states.hover, 'background-accent-pressed': states.pressed,
      'background-success': status.success, 'background-warning': status.warning, 'background-danger': status.danger, 'background-info': status.info,
      'text-primary': ramp[12], 'text-secondary': ramp[11], 'text-tertiary': ramp[10], 'text-disabled': ramp[10],
      'text-inverse': built[theme === 'light' ? 'dark' : 'light'].ramp[12], 'text-on-accent': onAccent,
      'text-accent': status.accent, 'text-success': status.success, 'text-warning': status.warning, 'text-danger': status.danger, 'text-info': status.info,
      'border-primary': ramp[7], 'border-control': ramp[9], 'border-accent': status.accent,
      'border-success': status.success, 'border-warning': status.warning, 'border-danger': status.danger, 'border-info': status.info,
      'ring-primary': status.accent,
    }
    css += `[data-gx-palette='${candidate.id}'][data-theme='${theme}'] {\n`
    for (const [name, value] of Object.entries(vars)) css += `  --color-${name}: ${value};\n`
    css += `  --material-glass-fill: ${theme === 'light' ? ramp[1] : ramp[3]};\n  --material-tinted-fill: ${theme === 'light' ? ramp[1] : ramp[3]};\n`
    css += `  --material-solid-fill: ${theme === 'light' ? ramp[1] : ramp[3]};\n  --material-solid-border: ${ramp[8]};\n}\n\n`
  }
  return css
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--write')) {
    const { writeFileSync } = await import('node:fs')
    const data = candidates.map(c => ({ id: c.id, name: c.name, summary: c.summary, ...build(c) }))
    const css = candidates.map(scopedCss).join('')
    // The catalog preview reads one TypeScript module inside src/ (source-hash rule of the manifest).
    const module = '/* Generated by packages/ui/tokens/palettes/generate.mjs --write; do not edit. Palette candidates (D-201). */\n' +
      `export const paletteCandidates = ${JSON.stringify(data, null, 2)} as const\n\n` +
      `export const paletteCandidateCss = ${JSON.stringify(css)}\n`
    writeFileSync(new URL('../../src/components/palette-preview/candidates.ts', import.meta.url), module)
    writeFileSync(new URL('./candidates.json', import.meta.url), JSON.stringify(data, null, 2) + '\n')
  } else {
    console.log(JSON.stringify(candidates.map(c => ({ id: c.id, name: c.name, summary: c.summary, ...build(c) })), null, 2))
  }
}
