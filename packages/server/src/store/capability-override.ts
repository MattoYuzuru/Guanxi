/**
 * Persistence for explicit positive user capability assertions (P2-I).
 *
 * One latest row belongs to one exact `(provider, canonical reference, digest,
 * runtime version, capability)`. Nothing here is derived from a provider
 * declaration or a probe result, and nothing here stores a prompt, a response,
 * reasoning, an endpoint, credentials, a path, a raw provider body or a note:
 * the whole row is the identity plus the fixed positive assertion.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  MODEL_CAPABILITY_OVERRIDE_VERSION,
  modelCapabilitySchema,
  type ModelCapability,
  type ModelCapabilityOverride,
} from '@alamo/contract'
import { normalizeOllamaModelReference } from '../runtime/observation-key.ts'
import type { Db } from './db.ts'

export const MODEL_CAPABILITY_OVERRIDE_KEY_VERSION = 1 as const
export const MODEL_CAPABILITY_OVERRIDE_SCHEMA_VERSION =
  MODEL_CAPABILITY_OVERRIDE_VERSION

/** The exact artifact/runtime identity an assertion is bound to. */
export interface ModelCapabilityOverrideIdentity {
  provider: 'ollama'
  normalizedModelReference: string
  artifactDigest: string
  runtimeVersion: string
  keyVersion?: typeof MODEL_CAPABILITY_OVERRIDE_KEY_VERSION
  overrideSchemaVersion?: typeof MODEL_CAPABILITY_OVERRIDE_SCHEMA_VERSION
}

export interface ModelCapabilityOverrideRecord {
  overrideKey: string
  identity: Required<ModelCapabilityOverrideIdentity>
  capability: ModelCapability
  createdAt: string
  updatedAt: string
}

interface OverrideRow {
  override_key: string
  key_version: number
  override_schema_version: number
  provider: string
  normalized_model_reference: string
  artifact_digest: string
  runtime_version: string
  capability: string
  source: string
  state: string
  value: string
  created_at: string
  updated_at: string
}

const timestampSchema = z.string().datetime()

function exactIdentity(
  identity: ModelCapabilityOverrideIdentity,
): Required<ModelCapabilityOverrideIdentity> {
  const exact = {
    ...identity,
    keyVersion: identity.keyVersion ?? MODEL_CAPABILITY_OVERRIDE_KEY_VERSION,
    overrideSchemaVersion:
      identity.overrideSchemaVersion ?? MODEL_CAPABILITY_OVERRIDE_SCHEMA_VERSION,
  }
  if (
    exact.provider !== 'ollama' ||
    // The reference must already be canonical. Accepting a merely non-empty
    // string would let two spellings of one model own two separate rows.
    normalizeOllamaModelReference(exact.normalizedModelReference)
      !== exact.normalizedModelReference ||
    exact.artifactDigest.trim().length === 0 ||
    exact.artifactDigest !== exact.artifactDigest.trim() ||
    /\s/u.test(exact.artifactDigest) ||
    exact.runtimeVersion.trim().length === 0 ||
    exact.runtimeVersion !== exact.runtimeVersion.trim() ||
    exact.keyVersion !== MODEL_CAPABILITY_OVERRIDE_KEY_VERSION ||
    exact.overrideSchemaVersion !== MODEL_CAPABILITY_OVERRIDE_SCHEMA_VERSION
  ) {
    throw new Error('Capability override identity is incomplete or incompatible')
  }
  return exact
}

export function modelCapabilityOverrideKey(
  identity: ModelCapabilityOverrideIdentity,
  capability: ModelCapability,
): string {
  const exact = exactIdentity(identity)
  const exactCapability = modelCapabilitySchema.parse(capability)
  const canonical = JSON.stringify([
    exact.keyVersion,
    exact.overrideSchemaVersion,
    exact.provider,
    exact.normalizedModelReference,
    exact.artifactDigest,
    exact.runtimeVersion,
    exactCapability,
  ])
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

/** Fail closed: an unreadable row must never become a visible user assertion. */
function parseRow(row: OverrideRow): ModelCapabilityOverrideRecord {
  if (
    row.key_version !== MODEL_CAPABILITY_OVERRIDE_KEY_VERSION ||
    row.override_schema_version !== MODEL_CAPABILITY_OVERRIDE_SCHEMA_VERSION ||
    row.provider !== 'ollama' ||
    row.source !== 'user_override' ||
    row.state !== 'overridden' ||
    row.value !== 'present'
  ) {
    throw new Error('Capability override row is incompatible')
  }
  const capability = modelCapabilitySchema.parse(row.capability)
  const identity = exactIdentity({
    provider: 'ollama',
    normalizedModelReference: row.normalized_model_reference,
    artifactDigest: row.artifact_digest,
    runtimeVersion: row.runtime_version,
    keyVersion: MODEL_CAPABILITY_OVERRIDE_KEY_VERSION,
    overrideSchemaVersion: MODEL_CAPABILITY_OVERRIDE_SCHEMA_VERSION,
  })
  if (modelCapabilityOverrideKey(identity, capability) !== row.override_key) {
    throw new Error('Capability override row key does not match its exact identity')
  }
  const createdAt = timestampSchema.parse(row.created_at)
  const updatedAt = timestampSchema.parse(row.updated_at)
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error('Capability override row contains invalid timestamps')
  }
  return { overrideKey: row.override_key, identity, capability, createdAt, updatedAt }
}

export function modelCapabilityOverrideProjection(
  record: ModelCapabilityOverrideRecord,
): ModelCapabilityOverride {
  return {
    version: MODEL_CAPABILITY_OVERRIDE_VERSION,
    source: 'user_override',
    state: 'overridden',
    value: 'present',
    capability: record.capability,
    provider: record.identity.provider,
    normalizedModelReference: record.identity.normalizedModelReference,
    artifactDigest: record.identity.artifactDigest,
    runtimeVersion: record.identity.runtimeVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/**
 * Exact overrides for one descriptor identity. An incomplete identity or an
 * unreadable/absent table projects nothing: absence of an override is not
 * `unsupported`, so failing closed here can neither invent nor hide a claim.
 */
export function exactCapabilityOverrides(
  store: Pick<ModelCapabilityOverrideStore, 'listReadable'>,
  identity: {
    normalizedModelReference: string | null
    artifactDigest: string | null
    runtimeVersion: string | null
  },
): ModelCapabilityOverride[] {
  if (
    identity.normalizedModelReference === null ||
    identity.artifactDigest === null ||
    identity.runtimeVersion === null
  ) {
    return []
  }
  try {
    return store
      .listReadable({
        provider: 'ollama',
        // The descriptor observes raw provider values; normalize and trim here so
        // a padded `/api/version` string cannot desynchronize the read key from
        // the key the mutation wrote.
        normalizedModelReference:
          normalizeOllamaModelReference(identity.normalizedModelReference)
          ?? identity.normalizedModelReference,
        artifactDigest: identity.artifactDigest.trim(),
        runtimeVersion: identity.runtimeVersion.trim(),
      })
      .records.map(modelCapabilityOverrideProjection)
  } catch {
    return []
  }
}

const SELECT_COLUMNS = `override_key, key_version, override_schema_version, provider,
         normalized_model_reference, artifact_digest, runtime_version, capability,
         source, state, value, created_at, updated_at`

export class ModelCapabilityOverrideStore {
  private readonly db: Db
  /** `listLocal` reads once per installed model, so the statement is reused. */
  private listStatement: ReturnType<Db['prepare']> | null = null

  constructor(db: Db) {
    this.db = db
  }

  private listRows(exact: Required<ModelCapabilityOverrideIdentity>): OverrideRow[] {
    this.listStatement ??= this.db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM model_capability_user_overrides
         WHERE provider = ? AND normalized_model_reference = ?
           AND artifact_digest = ? AND runtime_version = ?
           AND override_schema_version = ?
         ORDER BY capability ASC`,
    )
    return this.listStatement.all(
      exact.provider,
      exact.normalizedModelReference,
      exact.artifactDigest,
      exact.runtimeVersion,
      exact.overrideSchemaVersion,
    ) as unknown as OverrideRow[]
  }

  /**
   * Every readable exact override for one identity, ordered by capability so the
   * response and the exported projection stay deterministic across reads.
   *
   * An unreadable row is skipped rather than thrown, so one corrupted row cannot
   * hide — or permanently wedge — every other capability of the same identity.
   * Skipping still fails closed: a row that cannot be verified never becomes a
   * visible assertion. `unreadable` reports how many rows were dropped so a
   * caller can distinguish "nothing asserted" from "something is corrupt".
   */
  listReadable(identity: ModelCapabilityOverrideIdentity): {
    records: ModelCapabilityOverrideRecord[]
    unreadable: number
  } {
    const rows = this.listRows(exactIdentity(identity))
    const records: ModelCapabilityOverrideRecord[] = []
    let unreadable = 0
    for (const row of rows) {
      try {
        records.push(parseRow(row))
      } catch {
        unreadable += 1
      }
    }
    return { records, unreadable }
  }

  /**
   * Strict variant: any unreadable row throws. Used where a caller must not act
   * on a partially readable identity.
   */
  list(identity: ModelCapabilityOverrideIdentity): ModelCapabilityOverrideRecord[] {
    return this.listRows(exactIdentity(identity)).map(parseRow)
  }

  read(
    identity: ModelCapabilityOverrideIdentity,
    capability: ModelCapability,
  ): ModelCapabilityOverrideRecord | null {
    const row = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS}
         FROM model_capability_user_overrides WHERE override_key = ?`,
      )
      .get(modelCapabilityOverrideKey(identity, capability)) as OverrideRow | undefined
    return row ? parseRow(row) : null
  }

  /**
   * Idempotent: a repeated identical assertion keeps the original timestamps, so
   * "already asserted" never looks like a fresh decision.
   */
  write(input: {
    identity: ModelCapabilityOverrideIdentity
    capability: ModelCapability
    now: string
  }): ModelCapabilityOverrideRecord {
    const identity = exactIdentity(input.identity)
    const capability = modelCapabilitySchema.parse(input.capability)
    const now = timestampSchema.parse(input.now)
    const key = modelCapabilityOverrideKey(identity, capability)
    this.db
      .prepare(
        `INSERT INTO model_capability_user_overrides (
           override_key, key_version, override_schema_version, provider,
           normalized_model_reference, artifact_digest, runtime_version, capability,
           source, state, value, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user_override', 'overridden', 'present', ?, ?)
         ON CONFLICT (override_key) DO NOTHING`,
      )
      .run(
        key,
        identity.keyVersion,
        identity.overrideSchemaVersion,
        identity.provider,
        identity.normalizedModelReference,
        identity.artifactDigest,
        identity.runtimeVersion,
        capability,
        now,
        now,
      )
    const stored = this.read(identity, capability)
    if (!stored) throw new Error('Capability override was not persisted')
    return stored
  }

  /** Removes only the exact row; every adjacent identity and capability is untouched. */
  clear(input: {
    identity: ModelCapabilityOverrideIdentity
    capability: ModelCapability
  }): { removed: boolean } {
    const identity = exactIdentity(input.identity)
    const capability = modelCapabilitySchema.parse(input.capability)
    const result = this.db
      .prepare('DELETE FROM model_capability_user_overrides WHERE override_key = ?')
      .run(modelCapabilityOverrideKey(identity, capability))
    return { removed: Number(result.changes) > 0 }
  }
}
