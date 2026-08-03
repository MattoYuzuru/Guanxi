import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Db } from './db.ts'

export const INSTALLED_EVIDENCE_CACHE_KEY_VERSION = 1 as const
export const INSTALLED_EVIDENCE_SCHEMA_VERSION = 1 as const
export const INSTALLED_EVIDENCE_FRESH_TTL_MS = 15 * 60 * 1_000
export const INSTALLED_EVIDENCE_STALE_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000

const positiveFinite = z.number().finite().positive()

/**
 * Deliberately smaller than OllamaShowResponse. It cannot contain raw provider
 * bodies, endpoints, paths, templates, system prompts, licenses or errors.
 */
export const safeInstalledEvidenceSchema = z
  .object({
    capabilities: z
      .array(z.enum(['completion', 'tools', 'vision', 'insert', 'thinking', 'embedding']))
      .optional(),
    contextLength: z.number().int().positive().safe().optional(),
    architecture: z
      .object({
        name: z.string().min(1).max(128),
        blockCount: positiveFinite.optional(),
        headCount: positiveFinite.optional(),
        headCountKv: positiveFinite.optional(),
        keyLength: positiveFinite.optional(),
        embeddingLength: positiveFinite.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
export type SafeInstalledEvidence = z.infer<typeof safeInstalledEvidenceSchema>

/** Normalize the allowlisted subset immediately; raw provider data never enters the store. */
export function safeInstalledEvidenceFromProvider(input: {
  capabilities?: unknown
  details?: { context_length?: unknown }
  model_info?: Record<string, unknown>
}): SafeInstalledEvidence {
  const value: SafeInstalledEvidence = {}
  const capabilities = z
    .array(z.enum(['completion', 'tools', 'vision', 'insert', 'thinking', 'embedding']))
    .safeParse(input.capabilities)
  if (capabilities.success) value.capabilities = capabilities.data

  const contextCandidates = [
    input.details?.context_length,
    ...Object.entries(input.model_info ?? {})
      .filter(([key]) => key.endsWith('.context_length'))
      .map(([, candidate]) => candidate),
  ].filter((candidate): candidate is number => Number.isSafeInteger(candidate) && Number(candidate) > 0)
  const distinctContexts = [...new Set(contextCandidates)]
  if (distinctContexts.length === 1) value.contextLength = distinctContexts[0]

  const info = input.model_info ?? {}
  const architectureName = info['general.architecture']
  if (typeof architectureName === 'string' && architectureName.length > 0 && architectureName.length <= 128) {
    const positive = (suffix: string): number | undefined => {
      const candidate = info[`${architectureName}.${suffix}`]
      return typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
        ? candidate
        : undefined
    }
    value.architecture = {
      name: architectureName,
      ...(positive('block_count') === undefined ? {} : { blockCount: positive('block_count') }),
      ...(positive('attention.head_count') === undefined
        ? {}
        : { headCount: positive('attention.head_count') }),
      ...(positive('attention.head_count_kv') === undefined
        ? {}
        : { headCountKv: positive('attention.head_count_kv') }),
      ...(positive('attention.key_length') === undefined
        ? {}
        : { keyLength: positive('attention.key_length') }),
      ...(positive('embedding_length') === undefined
        ? {}
        : { embeddingLength: positive('embedding_length') }),
    }
  }
  return safeInstalledEvidenceSchema.parse(value)
}

export interface InstalledEvidenceCacheIdentity {
  provider: 'ollama'
  normalizedModelReference: string
  artifactDigest: string
  runtimeVersion: string
  keyVersion?: typeof INSTALLED_EVIDENCE_CACHE_KEY_VERSION
  evidenceSchemaVersion?: typeof INSTALLED_EVIDENCE_SCHEMA_VERSION
}

export interface InstalledEvidenceCacheRecord {
  cacheKey: string
  identity: Required<InstalledEvidenceCacheIdentity>
  evidence: SafeInstalledEvidence
  observedAt: string
  fetchedAt: string
  validatedAt: string
  expiresAt: string
  staleUntil: string
}

export type InstalledEvidenceCacheRead =
  | { state: 'miss' }
  | { state: 'fresh' | 'stale' | 'expired'; record: InstalledEvidenceCacheRecord }

interface CacheRow {
  cache_key: string
  key_version: number
  evidence_schema_version: number
  provider: string
  normalized_model_reference: string
  artifact_digest: string
  runtime_version: string
  safe_evidence_json: string
  observed_at: string
  fetched_at: string
  validated_at: string
  expires_at: string
  stale_until: string
}

function completeIdentity(
  identity: InstalledEvidenceCacheIdentity,
): Required<InstalledEvidenceCacheIdentity> {
  return {
    ...identity,
    keyVersion: identity.keyVersion ?? INSTALLED_EVIDENCE_CACHE_KEY_VERSION,
    evidenceSchemaVersion:
      identity.evidenceSchemaVersion ?? INSTALLED_EVIDENCE_SCHEMA_VERSION,
  }
}

export function installedEvidenceCacheKey(identity: InstalledEvidenceCacheIdentity): string {
  const exact = completeIdentity(identity)
  const canonical = JSON.stringify([
    exact.keyVersion,
    exact.evidenceSchemaVersion,
    exact.provider,
    exact.normalizedModelReference,
    exact.artifactDigest,
    exact.runtimeVersion,
  ])
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

function parseIso(value: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error('Installed evidence cache contains an invalid time')
  return parsed
}

function parseRow(row: CacheRow): InstalledEvidenceCacheRecord {
  if (
    row.key_version !== INSTALLED_EVIDENCE_CACHE_KEY_VERSION ||
    row.evidence_schema_version !== INSTALLED_EVIDENCE_SCHEMA_VERSION ||
    row.provider !== 'ollama'
  ) {
    throw new Error('Installed evidence cache row is incompatible')
  }
  const identity: Required<InstalledEvidenceCacheIdentity> = {
    provider: 'ollama',
    normalizedModelReference: row.normalized_model_reference,
    artifactDigest: row.artifact_digest,
    runtimeVersion: row.runtime_version,
    keyVersion: INSTALLED_EVIDENCE_CACHE_KEY_VERSION,
    evidenceSchemaVersion: INSTALLED_EVIDENCE_SCHEMA_VERSION,
  }
  if (installedEvidenceCacheKey(identity) !== row.cache_key) {
    throw new Error('Installed evidence cache key does not match its identity')
  }
  const evidence = safeInstalledEvidenceSchema.parse(JSON.parse(row.safe_evidence_json))
  for (const value of [
    row.observed_at,
    row.fetched_at,
    row.validated_at,
    row.expires_at,
    row.stale_until,
  ]) {
    parseIso(value)
  }
  return {
    cacheKey: row.cache_key,
    identity,
    evidence,
    observedAt: row.observed_at,
    fetchedAt: row.fetched_at,
    validatedAt: row.validated_at,
    expiresAt: row.expires_at,
    staleUntil: row.stale_until,
  }
}

export class InstalledEvidenceCacheStore {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  read(identity: InstalledEvidenceCacheIdentity, now = Date.now()): InstalledEvidenceCacheRead {
    const key = installedEvidenceCacheKey(identity)
    const row = this.db
      .prepare(
        `SELECT cache_key, key_version, evidence_schema_version, provider,
                normalized_model_reference, artifact_digest, runtime_version,
                safe_evidence_json, observed_at, fetched_at, validated_at,
                expires_at, stale_until
         FROM installed_model_evidence_cache
         WHERE cache_key = ?`,
      )
      .get(key) as CacheRow | undefined
    if (!row) return { state: 'miss' }
    const record = parseRow(row)
    if (now <= parseIso(record.expiresAt)) return { state: 'fresh', record }
    if (now <= parseIso(record.staleUntil)) return { state: 'stale', record }
    return { state: 'expired', record }
  }

  /**
   * A validated replacement is one transaction: incompatible rows for the
   * canonical reference are invalidated before the new exact row is committed.
   */
  write(input: {
    identity: InstalledEvidenceCacheIdentity
    evidence: SafeInstalledEvidence
    observedAt: string
    fetchedAt?: string
    validatedAt: string
    freshTtlMs?: number
    staleWindowMs?: number
  }): InstalledEvidenceCacheRecord {
    const identity = completeIdentity(input.identity)
    const evidence = safeInstalledEvidenceSchema.parse(input.evidence)
    const observedAtMs = parseIso(input.observedAt)
    const fetchedAt = input.fetchedAt ?? input.observedAt
    parseIso(fetchedAt)
    const validatedAtMs = parseIso(input.validatedAt)
    const freshTtlMs = input.freshTtlMs ?? INSTALLED_EVIDENCE_FRESH_TTL_MS
    const staleWindowMs = input.staleWindowMs ?? INSTALLED_EVIDENCE_STALE_WINDOW_MS
    if (freshTtlMs <= 0 || staleWindowMs < 0 || observedAtMs > validatedAtMs) {
      throw new Error('Installed evidence cache timing policy is invalid')
    }
    const expiresAt = new Date(validatedAtMs + freshTtlMs).toISOString()
    const staleUntil = new Date(validatedAtMs + freshTtlMs + staleWindowMs).toISOString()
    const cacheKey = installedEvidenceCacheKey(identity)
    const evidenceJson = JSON.stringify(evidence)

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `DELETE FROM installed_model_evidence_cache
           WHERE provider = ? AND normalized_model_reference = ? AND cache_key <> ?`,
        )
        .run(identity.provider, identity.normalizedModelReference, cacheKey)
      this.db
        .prepare(
          `INSERT INTO installed_model_evidence_cache (
             cache_key, key_version, evidence_schema_version, provider,
             normalized_model_reference, artifact_digest, runtime_version,
             safe_evidence_json, observed_at, fetched_at, validated_at,
             expires_at, stale_until
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (cache_key) DO UPDATE SET
             safe_evidence_json = excluded.safe_evidence_json,
             observed_at = excluded.observed_at,
             fetched_at = excluded.fetched_at,
             validated_at = excluded.validated_at,
             expires_at = excluded.expires_at,
             stale_until = excluded.stale_until`,
        )
        .run(
          cacheKey,
          identity.keyVersion,
          identity.evidenceSchemaVersion,
          identity.provider,
          identity.normalizedModelReference,
          identity.artifactDigest,
          identity.runtimeVersion,
          evidenceJson,
          input.observedAt,
          fetchedAt,
          input.validatedAt,
          expiresAt,
          staleUntil,
        )
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    return {
      cacheKey,
      identity,
      evidence,
      observedAt: input.observedAt,
      fetchedAt,
      validatedAt: input.validatedAt,
      expiresAt,
      staleUntil,
    }
  }
}
