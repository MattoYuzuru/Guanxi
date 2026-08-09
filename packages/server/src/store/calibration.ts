import type { ModelObservationKey } from '@alamo/contract'
import type { CalibrationSample } from '../hardware/fit.ts'
import type { Db } from './db.ts'

interface CalibrationRow {
  context_length: number
  size_bytes: number
}

interface ExactCalibrationRow extends CalibrationRow {
  provider: string
  normalized_model_reference: string
  artifact_digest: string
  runtime_backend_fingerprint: string
  hardware_fingerprint: string
  size_vram_bytes: number
  measured_at: string
}

export interface ExactCalibrationObservation {
  contextLength: number
  sizeBytes: number
  sizeVramBytes: number
  measuredAt: string
}

type CompleteObservationKey = Extract<ModelObservationKey, { state: 'complete' }>

/** Durable measured samples are accepted and queried only through one exact key boundary. */
export class CalibrationStore {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  /** Shared composition-owned database for adjacent exact model evidence stores. */
  get database(): Db {
    return this.db
  }

  samples(key: ModelObservationKey): CalibrationSample[] {
    if (key.state !== 'complete') return []
    const components = key.components
    const rows = this.db
      .prepare(
        `SELECT context_length, size_bytes
         FROM model_calibration_observations
         WHERE provider = ?
           AND normalized_model_reference = ?
           AND artifact_digest = ?
           AND runtime_backend_fingerprint = ?
           AND hardware_fingerprint = ?
         ORDER BY context_length`,
      )
      .all(
        components.provider,
        components.normalizedModelReference,
        components.artifactDigest,
        components.runtimeBackend.fingerprint,
        components.hardware.fingerprint,
      ) as unknown as CalibrationRow[]

    return rows.map((row) => ({ contextLength: row.context_length, sizeBytes: row.size_bytes }))
  }

  exact(key: ModelObservationKey): CalibrationSample | null {
    if (key.state !== 'complete') return null
    const row = this.db
      .prepare(
        `SELECT context_length, size_bytes
         FROM model_calibration_observations
         WHERE observation_key = ?`,
      )
      .get(key.id) as CalibrationRow | undefined
    return row ? { contextLength: row.context_length, sizeBytes: row.size_bytes } : null
  }

  exactObservation(key: ModelObservationKey): ExactCalibrationObservation | null {
    if (key.state !== 'complete') return null
    const row = this.db
      .prepare(
        `SELECT provider, normalized_model_reference, artifact_digest,
                context_length, runtime_backend_fingerprint, hardware_fingerprint,
                size_bytes, size_vram_bytes, measured_at
         FROM model_calibration_observations
         WHERE observation_key = ?`,
      )
      .get(key.id) as ExactCalibrationRow | undefined
    if (
      !row
      || row.provider !== key.components.provider
      || row.normalized_model_reference !== key.components.normalizedModelReference
      || row.artifact_digest !== key.components.artifactDigest
      || row.context_length !== key.components.contextLength
      || row.runtime_backend_fingerprint !== key.components.runtimeBackend.fingerprint
      || row.hardware_fingerprint !== key.components.hardware.fingerprint
      || !Number.isSafeInteger(row.context_length)
      || row.context_length <= 0
      || !Number.isSafeInteger(row.size_bytes)
      || row.size_bytes <= 0
      || !Number.isSafeInteger(row.size_vram_bytes)
      || row.size_vram_bytes < 0
      || Number.isNaN(Date.parse(row.measured_at))
      || new Date(row.measured_at).toISOString() !== row.measured_at
    ) {
      return null
    }
    return {
      contextLength: row.context_length,
      sizeBytes: row.size_bytes,
      sizeVramBytes: row.size_vram_bytes,
      measuredAt: row.measured_at,
    }
  }

  /** Same exact observation replaces itself; another context/digest/runtime/host is a new row. */
  record(
    key: ModelObservationKey,
    sizeBytes: number,
    sizeVramBytes: number,
    measuredAt = new Date().toISOString(),
  ): boolean {
    if (
      key.state !== 'complete' ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes <= 0 ||
      !Number.isSafeInteger(sizeVramBytes) ||
      sizeVramBytes < 0
    ) {
      return false
    }
    this.upsertComplete(key, sizeBytes, sizeVramBytes, measuredAt)
    return true
  }

  private upsertComplete(
    key: CompleteObservationKey,
    sizeBytes: number,
    sizeVramBytes: number,
    measuredAt: string,
  ): void {
    const components = key.components
    this.db
      .prepare(
        `INSERT INTO model_calibration_observations (
           observation_key, key_version, provider, normalized_model_reference,
           artifact_digest, context_length, runtime_backend_fingerprint,
           hardware_fingerprint, size_bytes, size_vram_bytes, measured_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (observation_key) DO UPDATE SET
           size_bytes = excluded.size_bytes,
           size_vram_bytes = excluded.size_vram_bytes,
           measured_at = excluded.measured_at`,
      )
      .run(
        key.id,
        key.version,
        components.provider,
        components.normalizedModelReference,
        components.artifactDigest,
        components.contextLength,
        components.runtimeBackend.fingerprint,
        components.hardware.fingerprint,
        sizeBytes,
        sizeVramBytes,
        measuredAt,
      )
  }
}
