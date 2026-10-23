import { isDeepStrictEqual } from 'node:util'

/** A small validator for the JSON Schema subset the relay sends (`type`, `const`, `enum`, `anyOf`, `properties`, `required`,
 * `additionalProperties`, `items`, `minLength`, `minItems`). It exists so a test can say what the grammar would accept without a
 * dependency, and it is deliberately not lenient: an unknown keyword is a test failure, not a silent pass. */
const KEYWORDS = new Set(['type', 'const', 'enum', 'anyOf', 'properties', 'required', 'additionalProperties', 'items', 'minLength', 'minItems'])
export function accepts(schema: Record<string, unknown>, value: unknown): boolean {
  for (const key of Object.keys(schema)) if (!KEYWORDS.has(key)) throw new Error(`schema-check: unsupported keyword ${key}`)
  if ('const' in schema) return isDeepStrictEqual(value, schema.const)
  if (Array.isArray(schema.enum)) return schema.enum.some(candidate => isDeepStrictEqual(candidate, value))
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some(option => accepts(option as Record<string, unknown>, value))
  switch (schema.type) {
    case undefined: return true
    case 'string': return typeof value === 'string' && (typeof schema.minLength !== 'number' || value.length >= schema.minLength)
    case 'integer': return Number.isInteger(value)
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    case 'array': return Array.isArray(value) && (typeof schema.minItems !== 'number' || value.length >= schema.minItems) &&
      value.every(item => schema.items === undefined || accepts(schema.items as Record<string, unknown>, item))
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
      const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>, record = value as Record<string, unknown>
      if (!((schema.required ?? []) as string[]).every(key => key in record)) return false
      return Object.entries(record).every(([key, v]) => key in properties ? accepts(properties[key]!, v)
        : schema.additionalProperties === undefined || (schema.additionalProperties !== false && accepts(schema.additionalProperties as Record<string, unknown>, v)))
    }
    default: throw new Error(`schema-check: unsupported type ${String(schema.type)}`)
  }
}
