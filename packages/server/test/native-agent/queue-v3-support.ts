/**
 * Shared support for the queue v3 native reader tests: fixtures with a store
 * hook, seeders for historical v1 and v3 snapshots with real blobs, and small oracles.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  INPUT_INLINE_BYTES, SESSION_EVENT_VERSION, SESSION_EVENT_VERSION_3, SESSION_INPUT_TEXT_MEDIA_TYPE, type SessionEvent,
} from '@guanxi/contract'
import { SessionInputStore, utf8Excerpt, type SessionInputStoreHooks } from '../../src/session-log/input-artifacts.ts'
import { fixture } from './fixture.ts'

export type Fixture = Awaited<ReturnType<typeof fixture>>
export type Respond = NonNullable<Parameters<typeof fixture>[1]>
export const peer = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((ok) => { resolve = ok })
  return { promise, resolve }
}
export const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
export const big = (tag: string) => `${'a'.repeat(INPUT_INLINE_BYTES)}${tag}`
export const sha = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`

export async function build(t: Parameters<typeof fixture>[0], respond?: Respond, hooks?: SessionInputStoreHooks): Promise<Fixture> {
  return fixture(t, respond, undefined, undefined, undefined, {
    inputArtifacts: (db, dataDir) => new SessionInputStore({ dataDir, db, hooks }),
  })
}

export type Seed = { id: string; text: string } | { id: string; bytes: Uint8Array }

/** Seeds historical v1 data between turns, while no native attempt owns the writer. */
export async function seedV1(f: Fixture, sessionId: string, items: { id: string; text: string }[]): Promise<void> {
  const handle = f.log.open(sessionId, { kind: 'agent' })
  try { handle.append({ type: 'agent.queue', data: { items } }, { eventVersion: SESSION_EVENT_VERSION }) } finally { handle.close() }
}

/** Writes blobs then appends one v3 snapshot between turns as the single writer. */
export async function seedV3(f: Fixture, sessionId: string, items: Seed[]): Promise<void> {
  const data: unknown[] = []
  for (const item of items) {
    if ('text' in item && Buffer.byteLength(item.text, 'utf8') <= INPUT_INLINE_BYTES) {
      data.push({ id: item.id, kind: 'inline', text: item.text })
      continue
    }
    const content = 'text' in item ? item.text : item.bytes
    const written = await f.agents().inputArtifacts.write(sessionId, content, SESSION_INPUT_TEXT_MEDIA_TYPE)
    const excerpt = 'text' in item ? utf8Excerpt(item.text) : ''
    data.push({ id: item.id, kind: 'artifact', input: { ...written, mediaType: SESSION_INPUT_TEXT_MEDIA_TYPE, excerpt } })
  }
  const handle = f.log.open(sessionId, { kind: 'agent' })
  try { handle.append({ type: 'agent.queue', data: { items: data } } as never, { eventVersion: SESSION_EVENT_VERSION_3 }) } finally { handle.close() }
}

/** A completed first turn, ready for a v3 snapshot to be seeded. */
export async function started(f: Fixture, options: Record<string, unknown> = {}): Promise<string> {
  const { sessionId } = await f.agents().create({ ...f.input, prompt: 'seed turn', ...options })
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  return sessionId
}

export const events = (f: Fixture, sessionId: string) => f.log.readAll(sessionId, 'person')
export const prompts = (all: readonly SessionEvent[]) => all.filter((e): e is Extract<SessionEvent, { type: 'prompt' }> => e.type === 'prompt')
export const runIds = (all: readonly SessionEvent[]) => new Set(all.flatMap((e) => e.type === 'run.lifecycle' ? [e.data.runId] : []))
export const blobPath = (f: Fixture, sessionId: string, text: string) => join(f.agents().inputArtifacts.directoryFor(sessionId), sha(text).slice(7))

