import Color from 'colorjs.io'
import { resolvedFlat } from './resolve.mjs'

const finite = n => typeof n === 'number' && Number.isFinite(n)
export function validateTokens(tokens) {
  const flat = resolvedFlat(tokens)
  const errors = []
  for (const t of flat) {
    const v = t.$value
    let valid = false
    switch (t.$type) {
      case 'color': {
        valid = v?.colorSpace === 'oklch' && v.components?.length === 3 && v.components.every(finite)
          && v.components[0] >= 0 && v.components[0] <= 1 && v.components[1] >= 0
          && /^#[0-9a-f]{6}$/i.test(v.hex) && (v.alpha === undefined || (finite(v.alpha) && v.alpha >= 0 && v.alpha <= 1))
        if (valid) {
          const hex = new Color('oklch', v.components).to('srgb').toString({ format: 'hex' }).toLowerCase()
          valid = hex === v.hex.toLowerCase()
        }
        break
      }
      case 'dimension': valid = finite(v?.value) && ['px', 'rem'].includes(v.unit); break
      case 'duration': valid = finite(v?.value) && v.value >= 0 && ['ms', 's'].includes(v.unit); break
      case 'number': valid = finite(v); break
      case 'fontFamily': valid = (typeof v === 'string' && v.length > 0) || (Array.isArray(v) && v.length > 0 && v.every(n => typeof n === 'string' && n.length > 0)); break
      case 'fontWeight': valid = finite(v) && v >= 1 && v <= 1000; break
      case 'cubicBezier': valid = Array.isArray(v) && v.length === 4 && v.every(finite) && v[0] >= 0 && v[0] <= 1 && v[2] >= 0 && v[2] <= 1; break
      case 'shadow': {
        valid = (Array.isArray(v) ? v : [v]).every(s => {
          try {
            validateTokens({ color: { $type: 'color', $value: s.color }, ...Object.fromEntries(['offsetX', 'offsetY', 'blur', 'spread'].map(k => [k, { $type: 'dimension', $value: s[k] }])) })
            return true
          } catch { return false }
        })
        break
      }
      default: errors.push(`${t.name}: unsupported type ${t.$type}`); continue
    }
    if (!valid) errors.push(`${t.name}: invalid ${t.$type} value`)
  }
  if (errors.length) throw Error(errors.join('\n'))
  const cssNames = flat.map(t => t.path.join('-'))
  if (new Set(cssNames).size !== cssNames.length) throw Error('CSS token name collision')
  return flat
}
