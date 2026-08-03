import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Db } from './db.ts'

export const COMPLETION_PROBE_KEY_VERSION = 1 as const
export const COMPLETION_PROBE_DEFINITION_VERSION = 1 as const

export const storedCompletionProbeOutcomeSchema = z
  .object({
    status: z.enum(['verified', 'degraded', 'unknown']),
    reason: z.enum([
      'terminal_response',
      'provider_unavailable',
      'connect_timeout',
      'load_timeout',
      'response_timeout',
      'provider_error',
      'runtime_protocol',
      'empty_response',
    ]),
    source: z.literal('runtime_probe'),
    confidence: z.enum(['verified', 'degraded', 'unknown']),
  })
  .strict()
export type StoredCompletionProbeOutcome = z.infer<
  typeof storedCompletionProbeOutcomeSchema
>

export interface CompletionProbeIdentity {
  provider: 'ollama'
  normalizedModelReference: string
  artifactDigest: string
  runtimeVersion: string
  contextLength: number
  keyVersion?: typeof COMPLETION_PROBE_KEY_VERSION
  probeDefinitionVersion?: typeof COMPLETION_PROBE_DEFINITION_VERSION
}

export interface CompletionProbeRecord {
  probeKey: string
  identity: Required<CompletionProbeIdentity>
  outcome: StoredCompletionProbeOutcome
  observedAt: string
  completedAt: string
  durationMs: number
}

interface ProbeRow {
  probe_key: string
  key_version: number
  probe_definition_version: number
  provider: string
  normalized_model_reference: string
  artifact_digest: string
  runtime_version: string
  context_length: number
  outcome: string
  reason: string
  source: string
  confidence: string
  observed_at: string
  completed_at: string
  duration_ms: number
}

function exactIdentity(
  identity: CompletionProbeIdentity,
): Required<CompletionProbeIdentity> {
  const exact = {
    ...identity,
    keyVersion: identity.keyVersion ?? COMPLETION_PROBE_KEY_VERSION,
    probeDefinitionVersion:
      identity.probeDefinitionVersion ?? COMPLETION_PROBE_DEFINITION_VERSION,
  }
  if (
    exact.provider !== 'ollama' ||
    exact.normalizedModelReference.trim().length === 0 ||
    exact.artifactDigest.trim().length === 0 ||
    exact.runtimeVersion.trim().length === 0 ||
    !Number.isSafeInteger(exact.contextLength) ||
    exact.contextLength <= 0 ||
    exact.keyVersion !== COMPLETION_PROBE_KEY_VERSION ||
    exact.probeDefinitionVersion !== COMPLETION_PROBE_DEFINITION_VERSION
  ) {
    throw new Error('Completion probe identity is incomplete or incompatible')
  }
  return exact
}

export function completionProbeKey(identity: CompletionProbeIdentity): string {
  const exact = exactIdentity(identity)
  const canonical = JSON.stringify([
    exact.keyVersion,
    exact.probeDefinitionVersion,
    exact.provider,
    exact.normalizedModelReference,
    exact.artifactDigest,
    exact.runtimeVersion,
    exact.contextLength,
  ])
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

function parseTime(value: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error('Completion probe row contains invalid timing')
  return parsed
}

function validateTiming(observedAt: string, completedAt: string, durationMs: number): void {
  const observed = parseTime(observedAt)
  const completed = parseTime(completedAt)
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0 ||
    completed < observed ||
    completed - observed !== durationMs
  ) {
    throw new Error('Completion probe row contains invalid timing')
  }
}

function parseRow(row: ProbeRow): CompletionProbeRecord {
  const identity = exactIdentity({
    provider: row.provider as 'ollama',
    normalizedModelReference: row.normalized_model_reference,
    artifactDigest: row.artifact_digest,
    runtimeVersion: row.runtime_version,
    contextLength: row.context_length,
    keyVersion: row.key_version as 1,
    probeDefinitionVersion: row.probe_definition_version as 1,
  })
  if (completionProbeKey(identity) !== row.probe_key) {
    throw new Error('Completion probe row key does not match its exact identity')
  }
  const outcome = storedCompletionProbeOutcomeSchema.parse({
    status: row.outcome,
    reason: row.reason,
    source: row.source,
    confidence: row.confidence,
  })
  validateTiming(row.observed_at, row.completed_at, row.duration_ms)
  return {
    probeKey: row.probe_key,
    identity,
    outcome,
    observedAt: row.observed_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
  }
}

export class CompletionProbeStore {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  read(identity: CompletionProbeIdentity): CompletionProbeRecord | null {
    const row = this.db
      .prepare(
        `SELECT probe_key, key_version, probe_definition_version, provider,
                normalized_model_reference, artifact_digest, runtime_version,
                context_length, outcome, reason, source, confidence,
                observed_at, completed_at, duration_ms
         FROM completion_probe_evidence WHERE probe_key = ?`,
      )
      .get(completionProbeKey(identity)) as ProbeRow | undefined
    return row ? parseRow(row) : null
  }

  write(input: {
    identity: CompletionProbeIdentity
    outcome: StoredCompletionProbeOutcome
    observedAt: string
    completedAt: string
    durationMs: number
  }): CompletionProbeRecord {
    const identity = exactIdentity(input.identity)
    const outcome = storedCompletionProbeOutcomeSchema.parse(input.outcome)
    try {
      validateTiming(input.observedAt, input.completedAt, input.durationMs)
    } catch {
      throw new Error('Completion probe timing is invalid')
    }
    const key = completionProbeKey(identity)
    this.db
      .prepare(
        `INSERT INTO completion_probe_evidence (
           probe_key, key_version, probe_definition_version, provider,
           normalized_model_reference, artifact_digest, runtime_version,
           context_length, outcome, reason, source, confidence,
           observed_at, completed_at, duration_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (probe_key) DO UPDATE SET
           outcome = excluded.outcome,
           reason = excluded.reason,
           source = excluded.source,
           confidence = excluded.confidence,
           observed_at = excluded.observed_at,
           completed_at = excluded.completed_at,
           duration_ms = excluded.duration_ms`,
      )
      .run(
        key,
        identity.keyVersion,
        identity.probeDefinitionVersion,
        identity.provider,
        identity.normalizedModelReference,
        identity.artifactDigest,
        identity.runtimeVersion,
        identity.contextLength,
        outcome.status,
        outcome.reason,
        outcome.source,
        outcome.confidence,
        input.observedAt,
        input.completedAt,
        input.durationMs,
      )
    return this.read(identity)!
  }
}
