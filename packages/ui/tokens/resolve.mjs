import { readFile } from 'node:fs/promises'
import { resolve, relative, dirname } from 'node:path'

export const tokenRoot = dirname(new URL(import.meta.url).pathname)
export const readJSON = async path => JSON.parse(await readFile(path, 'utf8'))

function merge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b) || '$value' in b) return structuredClone(b)
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = merge(out[k], v)
  return out
}

// The authored subset uses local file references, same-document sets, and ordered modifiers.
// Unsupported constructs fail explicitly rather than being silently ignored.
export async function resolveTokens(input = {}, { root = tokenRoot, read = readJSON } = {}) {
  const file = resolve(root, 'guanxi.resolver.json')
  const resolver = await read(file)
  if (resolver.version !== '2025.10') throw Error('Expected DTCG Resolver 2025.10')
  const modes = Object.fromEntries(Object.entries(resolver.modifiers).map(([name, modifier]) => {
    const value = input[name] ?? modifier.default
    if (!Object.hasOwn(modifier.contexts, value)) throw Error(`Unknown ${name} context: ${value}`)
    return [name, value]
  }))
  for (const name of Object.keys(input)) if (!(name in modes)) throw Error(`Unknown modifier: ${name}`)
  let result = {}
  async function sources(items, stack = []) {
    for (const item of items) {
      if (!item.$ref) { result = merge(result, item); continue }
      if (Object.keys(item).length !== 1) throw Error('Reference overrides are not supported')
      const ref = item.$ref
      if (stack.includes(ref)) throw Error(`Circular source reference: ${ref}`)
      if (ref.startsWith('#/sets/')) {
        const set = resolver.sets?.[ref.slice(7)]
        if (!set) throw Error(`Missing set: ${ref}`)
        await sources(set.sources, [...stack, ref])
      } else {
        if (ref.includes('#') || ref.includes(':')) throw Error(`Unsupported source reference: ${ref}`)
        const path = resolve(root, ref)
        if (relative(root, path).startsWith('..')) throw Error(`Source escapes token root: ${ref}`)
        result = merge(result, await read(path))
      }
    }
  }
  const seen = new Set()
  for (const entry of resolver.resolutionOrder) {
    const match = /^#\/(sets|modifiers)\/([^/]+)$/.exec(entry.$ref ?? '')
    if (!match || seen.has(entry.$ref)) throw Error(`Invalid resolution entry: ${JSON.stringify(entry)}`)
    seen.add(entry.$ref)
    const [, kind, name] = match
    const definition = resolver[kind]?.[name]
    if (!definition) throw Error(`Missing resolution entry: ${entry.$ref}`)
    await sources(kind === 'sets' ? definition.sources : definition.contexts[modes[name]])
  }
  for (const name of Object.keys(modes)) if (!seen.has(`#/modifiers/${name}`)) throw Error(`Unused modifier: ${name}`)
  return { tokens: result, modes }
}

export function flatten(tokens, path = [], inheritedType) {
  return Object.entries(tokens).flatMap(([name, value]) => {
    if (name.startsWith('$') && name !== '$root') return []
    const parts = name === '$root' ? path : [...path, name]
    const type = value.$type ?? inheritedType
    return '$value' in value
      ? [{ ...value, $type: type, path: parts, name: parts.join('.') }]
      : flatten(value, parts, type)
  })
}

export function resolvedFlat(tokens) {
  const flat = flatten(tokens)
  const map = new Map(flat.map(t => [t.name, t]))
  function resolveToken(t, stack = []) {
    if (stack.includes(t.name)) throw Error(`Circular alias: ${[...stack, t.name].join(' → ')}`)
    const match = typeof t.$value === 'string' && /^\{([^{}]+)\}$/.exec(t.$value)
    if (!match) return t.$value
    const target = map.get(match[1])
    if (!target) throw Error(`Broken alias ${t.name}: ${match[1]}`)
    if (t.$type !== target.$type) throw Error(`Alias type mismatch: ${t.name} → ${target.name}`)
    return resolveToken(target, [...stack, t.name])
  }
  return flat.map(t => ({ ...t, $value: resolveToken(t) }))
}

export async function permutations(options) {
  const { modifiers } = await (options?.read ?? readJSON)(resolve(options?.root ?? tokenRoot, 'guanxi.resolver.json'))
  let modes = [{}]
  for (const [name, modifier] of Object.entries(modifiers)) {
    modes = modes.flatMap(mode => Object.keys(modifier.contexts).map(value => ({ ...mode, [name]: value })))
  }
  return modes
}
