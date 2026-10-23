import { createHash } from 'node:crypto'
import { RELAY_RESPONSE_SCHEMA_BYTES } from '@guanxi/contract/federation'
import type { ZodTypeAny } from 'zod'
import { RelayError } from './types.ts'

/** A JSON Schema document as plain data: it is signed, hashed and sent as JSON, never interpreted by a library. */
export type JsonSchema = Record<string, unknown>

/** Largest schema a relay call may carry. A federation message is one 1 MiB body that also holds the prompt, so the schema is
 * kept far below it; the contract enforces the same bound on the wire. */
export const MAX_RESPONSE_SCHEMA_BYTES = RELAY_RESPONSE_SCHEMA_BYTES

interface Def { typeName: string; [key: string]: unknown }
const def = (schema: ZodTypeAny): Def => schema._def as Def
const unsupported = (): never => { throw new RelayError('json_schema_unsupported') }

/** Converts the subset of Zod 3 that the relay's model-facing schemas use into a JSON Schema that llama.cpp's grammar builder
 * accepts (`const`, `enum`, `required`, `additionalProperties`, `anyOf`, `minLength`, `minItems`). Numeric bounds are not emitted: the
 * grammar only has to fix the shape and the types, and the Zod schema still validates every parsed value. Any other Zod construct
 * throws at construction, so an unsupported schema can never reach a model silently weakened. */
export function toJsonSchema(schema: ZodTypeAny): JsonSchema {
  const d = def(schema)
  switch (d.typeName) {
    case 'ZodString': {
      const min = (d.checks as Array<{ kind: string; value?: number }>).find(c => c.kind === 'min')
      return { type: 'string', ...(min?.value ? { minLength: min.value } : {}) }
    }
    case 'ZodNumber': return { type: (d.checks as Array<{ kind: string }>).some(c => c.kind === 'int') ? 'integer' : 'number' }
    case 'ZodBoolean': return { type: 'boolean' }
    case 'ZodLiteral': return { const: d.value }
    case 'ZodEnum': return { enum: [...(d.values as string[])] }
    case 'ZodUnknown': case 'ZodAny': return {}
    case 'ZodNullable': return { anyOf: [toJsonSchema(d.innerType as ZodTypeAny), { type: 'null' }] }
    case 'ZodOptional': return toJsonSchema(d.innerType as ZodTypeAny)
    case 'ZodArray': {
      const min = (d.minLength as { value: number } | null)?.value
      return { type: 'array', items: toJsonSchema(d.type as ZodTypeAny), ...(min ? { minItems: min } : {}) }
    }
    case 'ZodRecord': return { type: 'object', additionalProperties: toJsonSchema(d.valueType as ZodTypeAny) }
    case 'ZodUnion': return { anyOf: (d.options as ZodTypeAny[]).map(toJsonSchema) }
    case 'ZodDiscriminatedUnion': return { anyOf: [...(d.options as ZodTypeAny[])].map(toJsonSchema) }
    case 'ZodObject': {
      const shape = (d.shape as () => Record<string, ZodTypeAny>)()
      // An object that tolerates unknown keys would let the model invent them; only strict objects are constrained.
      if (d.unknownKeys !== 'strict') unsupported()
      const properties: Record<string, JsonSchema> = {}, required: string[] = []
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = toJsonSchema(value)
        if (!value.isOptional()) required.push(key)
      }
      return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }
    }
    default: return unsupported()
  }
}

/** A plain JSON copy (no symbols, no undefined, no shared references). Typebox objects carry symbol keys that must not travel. */
export function plainSchema(schema: unknown): JsonSchema {
  const copy = JSON.parse(JSON.stringify(schema)) as unknown
  if (copy === null || typeof copy !== 'object' || Array.isArray(copy)) throw new RelayError('json_schema_invalid')
  if (Buffer.byteLength(JSON.stringify(copy)) > MAX_RESPONSE_SCHEMA_BYTES) throw new RelayError('json_schema_too_large')
  return copy as JsonSchema
}

/** A tool parameter object as a strict JSON Schema object (every tool argument must be named by the tool). */
export function strictParameters(parameters: unknown): JsonSchema {
  const plain = plainSchema(parameters)
  if (plain.type !== 'object') throw new RelayError('json_schema_invalid')
  return { ...plain, additionalProperties: false }
}

const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`
    : JSON.stringify(value)
/** SHA-256 of a schema's stable form (sorted keys), the identity both nodes of a remote call compute. It is the same text as the federation's
 * canonical form for JSON data; a test asserts that, so the two cannot drift apart. */
export function schemaDigest(schema: JsonSchema): string { return createHash('sha256').update(stable(schema)).digest('hex') }

/** The schema a prepared request asks decoding to follow, or none. `format: 'json'` and anything that is not a bounded JSON object is not a
 * schema a runtime will send: it would be a request the home never pinned. */
export function requestSchema(format: unknown): JsonSchema | undefined {
  if (format === undefined) return undefined
  if (format === null || typeof format !== 'object' || Array.isArray(format) || Buffer.byteLength(JSON.stringify(format)) > MAX_RESPONSE_SCHEMA_BYTES) throw new RelayError('runtime_request_changed')
  return format as JsonSchema
}
