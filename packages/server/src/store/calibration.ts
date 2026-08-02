/**
 * Замеры «размер окна → занятая память» по каждой модели.
 *
 * Каждая загрузка модели бесплатно даёт одну точку. Со второй точки вердикт по
 * железу перестаёт быть прикидкой по формуле и становится расчётом по факту —
 * зависимость строго линейная, это проверено замерами при 4k/16k/32k.
 */
import type { CalibrationSample } from '../hardware/fit.ts'
import type { Db } from './db.ts'

interface CalibrationRow {
  context_length: number
  size_bytes: number
}

export class CalibrationStore {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  samples(model: string): CalibrationSample[] {
    const rows = this.db
      .prepare('SELECT context_length, size_bytes FROM model_calibration WHERE model = ? ORDER BY context_length')
      .all(model) as unknown as CalibrationRow[]

    return rows.map((row) => ({ contextLength: row.context_length, sizeBytes: row.size_bytes }))
  }

  /** Запоминает точку. Повторный замер того же окна перезаписывает прошлый. */
  record(model: string, contextLength: number, sizeBytes: number, sizeVramBytes: number): void {
    if (contextLength <= 0 || sizeBytes <= 0) return

    this.db
      .prepare(
        `INSERT INTO model_calibration (model, context_length, size_bytes, size_vram_bytes, measured_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (model, context_length) DO UPDATE SET
           size_bytes = excluded.size_bytes,
           size_vram_bytes = excluded.size_vram_bytes,
           measured_at = excluded.measured_at`,
      )
      .run(model, contextLength, sizeBytes, sizeVramBytes, new Date().toISOString())
  }

  /** Все замеры разом — чтобы построить список моделей одним проходом. */
  allSamples(): Map<string, CalibrationSample[]> {
    const rows = this.db
      .prepare('SELECT model, context_length, size_bytes FROM model_calibration ORDER BY model, context_length')
      .all() as unknown as (CalibrationRow & { model: string })[]

    const grouped = new Map<string, CalibrationSample[]>()
    for (const row of rows) {
      const list = grouped.get(row.model) ?? []
      list.push({ contextLength: row.context_length, sizeBytes: row.size_bytes })
      grouped.set(row.model, list)
    }
    return grouped
  }
}
