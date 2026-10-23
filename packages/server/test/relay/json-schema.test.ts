import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { hash as federationHash } from '../../src/federation/crypto.ts'
import { MAX_RESPONSE_SCHEMA_BYTES, plainSchema, requestSchema, schemaDigest, strictParameters, toJsonSchema } from '../../src/relay/json-schema.ts'
import { actionResponseSchema, actionSchema, GENERIC_TOOLS, LOCAL_TOOLS, PROBE_PROMPT, probeAnswerSchema, probeResponseSchema, workPrompt, type RelayToolSpec } from '../../src/relay/response-schemas.ts'
import { judgeResultJsonSchema } from '../../src/relay/judge-cascade.ts'
import { nativeTools } from '../../src/native-agent/tools.ts'
import { accepts } from './schema-check.ts'

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected
const FILE_READ: RelayToolSpec = { name: 'file_read', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, offset: { type: 'string' } } } }
const SHELL: RelayToolSpec = { name: 'shell', parameters: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } } }

test('the converter maps the used Zod subset exactly and refuses anything it cannot express', () => {
  assert.deepEqual(toJsonSchema(z.object({
    a: z.string().min(1), b: z.number().int().nullable(), c: z.enum(['x', 'y']), d: z.literal('k'), e: z.array(z.boolean()).min(1), f: z.record(z.unknown()).optional(), g: z.number(),
  }).strict()), {
    type: 'object', additionalProperties: false, required: ['a', 'b', 'c', 'd', 'e', 'g'],
    properties: { a: { type: 'string', minLength: 1 }, b: { anyOf: [{ type: 'integer' }, { type: 'null' }] }, c: { enum: ['x', 'y'] }, d: { const: 'k' },
      e: { type: 'array', items: { type: 'boolean' }, minItems: 1 }, f: { type: 'object', additionalProperties: {} }, g: { type: 'number' } },
  })
  assert.deepEqual(toJsonSchema(z.discriminatedUnion('k', [z.object({ k: z.literal('a') }).strict(), z.object({ k: z.literal('b'), v: z.string() }).strict()])),
    { anyOf: [{ type: 'object', properties: { k: { const: 'a' } }, required: ['k'], additionalProperties: false }, { type: 'object', properties: { k: { const: 'b' }, v: { type: 'string' } }, required: ['k', 'v'], additionalProperties: false }] })
  assert.deepEqual(toJsonSchema(z.union([z.string(), z.null()])), { anyOf: [{ type: 'string' }, { type: 'null' }] })
  assert.deepEqual(toJsonSchema(z.unknown()), {})
  // An object that would tolerate unknown keys, and constructs the grammar cannot carry, never reach a model silently weakened.
  for (const unsupported of [z.object({ a: z.string() }), z.object({ a: z.string() }).passthrough(), z.date(), z.tuple([z.string()]), z.string().transform(v => v), z.bigint(), z.map(z.string(), z.string())]) {
    assert.throws(() => toJsonSchema(unsupported as never), code('json_schema_unsupported'))
  }
})

test('every schema the relay sends agrees with the Zod schema that validates the reply', () => {
  const tools = [...LOCAL_TOOLS, FILE_READ, SHELL], action = actionResponseSchema(tools)
  const valid: unknown[] = [
    { action: 'tool', name: 'file_read', args: { path: 'SPEC.md' } }, { action: 'tool', name: 'file_read', args: { path: 'SPEC.md', offset: '4096' } },
    { action: 'tool', name: 'shell', args: { command: 'ls' } }, { action: 'tool', name: 'work.query', args: {} }, { action: 'tool', name: 'work.query', args: { offset: '0' } },
    { action: 'tool', name: 'notes.search', args: { query: 'x' } },
    { action: 'note', kind: 'decision', text: 't', items: ['I01'], expiresAt: null }, { action: 'note', kind: 'lesson', text: '', items: [], expiresAt: 5 },
    { action: 'propose', text: 'p' }, { action: 'verify', item: 'I01' }, { action: 'checkpoint' }, { action: 'handoff' }, { action: 'finish' },
  ]
  for (const value of valid) { assert.ok(actionSchema.safeParse(value).success, JSON.stringify(value)); assert.ok(accepts(action, value), JSON.stringify(value)) }
  // Shapes the model really produced, and their near misses: both validators refuse them.
  const refused: unknown[] = [
    'text', null, [], {}, { action: 'tool' }, { action: 'tool', name: 'file_read' }, { action: 'note', kind: 'idea', text: 't', items: [], expiresAt: null },
    { action: 'note', kind: 'decision', text: 't', items: [], expiresAt: 1.5 }, { action: 'verify' }, { action: 'checkpoint', extra: 1 }, { action: 'finish', item: 'x' },
    { name: 'file_read', args: { path: 'SPEC.md', offset: 120 } },
  ]
  for (const value of refused) { assert.equal(actionSchema.safeParse(value).success, false, JSON.stringify(value)); assert.equal(accepts(action, value), false, JSON.stringify(value)) }
  // The grammar is deliberately narrower than the validator where the tool list says more: an unlisted tool, an argument the tool does not
  // have, a missing required argument, a number where the tool takes a string.
  for (const value of [{ action: 'tool', name: 'rm_rf', args: {} }, { action: 'tool', name: 'file_read', args: { path: 'a', extra: '1' } }, { action: 'tool', name: 'file_read', args: {} },
    { action: 'tool', name: 'file_read', args: { path: 'a', offset: 120 } }, { action: 'tool', name: 'shell', args: { path: 'a' } }, { action: 'tool', name: 'work.query', args: { offset: 5 } }]) {
    assert.equal(accepts(action, value), false, JSON.stringify(value))
  }
  assert.ok(actionSchema.safeParse({ action: 'tool', name: 'rm_rf', args: {} }).success, 'the Zod validator keeps naming no tool; an unknown tool is refused when it runs')
  const probe = probeResponseSchema(), answer = { ledgerHash: 'a'.repeat(64), head: 'b'.repeat(40), revision: 'r1', nextItem: 'I01', nextStatus: 'open' as const }
  for (const value of [answer, { ...answer, nextItem: null, nextStatus: null }, { ...answer, nextStatus: 'verification_requested' }]) {
    assert.ok(probeAnswerSchema.safeParse(value).success); assert.ok(accepts(probe, value))
  }
  // The five values that made the first real runs fail: right keys, wrong status vocabulary, missing keys, extra keys.
  for (const value of [{ ...answer, nextItem: null, nextStatus: 'completed' }, { ...answer, nextStatus: 'done' }, { ledgerHash: answer.ledgerHash }, { ...answer, extra: 1 }, { ...answer, head: 5 }, {}]) {
    assert.equal(probeAnswerSchema.safeParse(value).success, false, JSON.stringify(value)); assert.equal(accepts(probe, value), false, JSON.stringify(value))
  }
  const verdict = { taxonomy: 'progress', verdict: 'consistent', evidenceRefs: ['plan'], diagnosisHint: 'ok' }
  assert.ok(accepts(judgeResultJsonSchema, verdict))
  for (const value of [{ ...verdict, taxonomy: 'great' }, { ...verdict, evidenceRefs: [] }, { ...verdict, evidenceRefs: [''] }, { ...verdict, extra: true }, { taxonomy: 'progress' }]) {
    assert.equal(accepts(judgeResultJsonSchema, value), false, JSON.stringify(value))
  }
})

test('the action schema is built from exactly the tools it is given and refuses a duplicated or malformed name', () => {
  const schema = actionResponseSchema([FILE_READ, SHELL]) as { anyOf: Array<{ properties: { name?: { const: string } } }> }
  assert.deepEqual(schema.anyOf.flatMap(v => v.properties.name ? [v.properties.name.const] : []), ['file_read', 'shell'])
  assert.throws(() => actionResponseSchema([FILE_READ, FILE_READ]), code('json_schema_invalid'))
  assert.throws(() => actionResponseSchema([{ name: 'file read', parameters: { type: 'object' } }]), code('json_schema_invalid'))
  // A workspace that lists no tool schema is constrained to the known names only; its arguments are not guessed.
  assert.ok(accepts(actionResponseSchema(GENERIC_TOOLS), { action: 'tool', name: 'shell', args: { anything: 1 } }))
  assert.equal(accepts(actionResponseSchema(GENERIC_TOOLS), { action: 'tool', name: 'rm', args: {} }), false)
})

test('the real native tool list yields a bounded schema that names every callable tool and no session tool', () => {
  const policy = { mode: 'full-access' as const, scratch: '/scratch', roots: ['/root'], attachments: [], protectedPaths: [], domains: [] }
  const listed = nativeTools({ policy, log: {} as never, handle: { sessionId: 's' } as never, scrubber: { scrub: <T>(v: T) => v } as never, queue() {} })
    .filter(t => !['plan', 'queue', 'note_add'].includes(t.name)).map(t => ({ name: t.name, parameters: strictParameters(t.parameters) }))
  assert.deepEqual(listed.map(t => t.name), ['tool_output_read', 'project_info', 'file_read', 'file_write', 'shell', 'search', 'repo_map', 'fetch', 'attachments', 'session_log_query'])
  const schema = actionResponseSchema([...LOCAL_TOOLS, ...listed])
  assert.ok(Buffer.byteLength(JSON.stringify(schema)) < MAX_RESPONSE_SCHEMA_BYTES / 4)
  assert.ok(accepts(schema, { action: 'tool', name: 'file_read', args: { path: 'SPEC.md', offset: '8192' } }))
  assert.equal(accepts(schema, { action: 'tool', name: 'plan', args: { items: '[]' } }), false)
  assert.equal(accepts(schema, { action: 'tool', name: 'file_read', args: { path: 'SPEC.md', offset: 8192 } }), false, 'tool arguments are strings in the tool schema')
  const fileRead = listed.find(t => t.name === 'file_read')!
  assert.deepEqual(fileRead.parameters, { type: 'object', required: ['path'], properties: { path: { type: 'string' }, offset: { type: 'string' } }, additionalProperties: false })
})

test('a schema is a plain bounded JSON object: copies, no symbols, no oversize, and a request carries one only as an object', () => {
  const copy = plainSchema({ type: 'object', properties: { a: { type: 'string' } } })
  assert.deepEqual(copy, { type: 'object', properties: { a: { type: 'string' } } })
  assert.throws(() => plainSchema('text'), code('json_schema_invalid'))
  assert.throws(() => plainSchema([]), code('json_schema_invalid'))
  assert.throws(() => plainSchema({ enum: ['x'.repeat(MAX_RESPONSE_SCHEMA_BYTES)] }), code('json_schema_too_large'))
  assert.throws(() => strictParameters({ type: 'string' }), code('json_schema_invalid'))
  assert.equal(requestSchema(undefined), undefined)
  assert.deepEqual(requestSchema({ type: 'object' }), { type: 'object' })
  for (const bad of ['json', null, [], 5, { enum: ['x'.repeat(MAX_RESPONSE_SCHEMA_BYTES)] }]) assert.throws(() => requestSchema(bad), code('runtime_request_changed'), JSON.stringify(bad)?.slice(0, 20))
})

test('the schema digest ignores key order and is the federation canonical hash, so two nodes cannot disagree about it', () => {
  const a = { type: 'object', properties: { x: { const: 1 }, y: { enum: ['b', 'a'] } }, required: ['x'] }, b = { required: ['x'], properties: { y: { enum: ['b', 'a'] }, x: { const: 1 } }, type: 'object' }
  assert.equal(schemaDigest(a), schemaDigest(b))
  assert.notEqual(schemaDigest(a), schemaDigest({ ...a, required: [] }), 'array order and content matter')
  assert.notEqual(schemaDigest(a), schemaDigest({ ...a, properties: { ...a.properties, y: { enum: ['a', 'b'] } } }))
  for (const schema of [a, actionResponseSchema([...LOCAL_TOOLS, FILE_READ]), probeResponseSchema(), judgeResultJsonSchema]) assert.equal(schemaDigest(schema), federationHash(schema))
})

test('the work prompt lists exactly the tools it is given, with valid JSON examples that cannot be mistaken for turns already taken', () => {
  const prompt = workPrompt([...LOCAL_TOOLS, FILE_READ, SHELL])
  assert.ok(prompt.includes('Tools (every argument is a string; a result with more:true continues with offset=nextOffset): work.query(offset?), notes.search(query, offset?), file_read(path, offset?), shell(command).'))
  assert.equal(prompt.includes('file_write'), false, 'a tool that is not offered is not listed')
  assert.equal(workPrompt(GENERIC_TOOLS).includes('file_write('), true)
  // Every example in the prompt is valid JSON and a valid action: the model copies the shape it is shown (it answered with unquoted keys when
  // the prompt showed {action:tool,name,args}).
  const examples: string[] = []
  for (let at = prompt.indexOf('{"action"'); at >= 0; at = prompt.indexOf('{"action"', at + 1)) {
    let depth = 0, end = at
    for (; end < prompt.length; end++) { if (prompt[end] === '{') depth++; if (prompt[end] === '}' && --depth === 0) break }
    examples.push(prompt.slice(at, end + 1))
  }
  assert.equal(examples.length, 7, 'one example per action kind')
  for (const example of examples) assert.ok(actionSchema.safeParse(JSON.parse(example)).success, example)
  // The relay's own turns are compact JSON; an example with the same bytes would make a script or a model think the turn was taken.
  assert.equal(prompt.includes('"action":"'), false)
})

test('the probe prompt defines every key it asks for and keeps the prefix the executor and its fixtures recognise', () => {
  assert.ok(PROBE_PROMPT.startsWith('Answer these five critical ledger probes as JSON.'))
  for (const key of ['ledgerHash', 'head', 'revision', 'nextItem', 'nextStatus']) assert.ok(PROBE_PROMPT.includes(key), key)
  assert.ok(PROBE_PROMPT.includes('the strip current item'), 'nextItem is the strip\'s current item, not the strip\'s next')
  assert.ok(PROBE_PROMPT.includes('All fields are required'))
})
