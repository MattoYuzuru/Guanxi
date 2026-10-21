import { createHash } from 'node:crypto'
import { compareLayouts, layoutDocumentSchema, layoutScopeKey, layoutClock, type LayoutClock, type LayoutDocument, type LayoutQuery, type LayoutScope, type LayoutGeometry, type LayoutList } from '@guanxi/contract'
import type { Db } from '../store/db.ts'
import { initializeLayoutSchema } from './schema.ts'

function canonical(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}
export class LayoutStore {
  private readonly db: Db
  constructor(db: Db) { this.db = db; initializeLayoutSchema(db) }

  list(query: LayoutQuery): LayoutList {
    const documents = (this.db.prepare('SELECT document FROM layout_documents ORDER BY scope_key, id').all() as { document: string }[])
      .map(row => layoutDocumentSchema.parse(JSON.parse(row.document)))
      .filter(doc => doc.scope.account === query.account && doc.scope.mode === query.mode && doc.scope.deviceClass === query.deviceClass && (!doc.scope.project || doc.scope.project === query.project) && (!doc.scope.device || doc.scope.device === query.device))
    const active = (this.db.prepare('SELECT scope_key, layout_id FROM layout_active').all() as { scope_key: string; layout_id: string }[])
      .flatMap(row => {
        const doc = documents.find(d => d.id === row.layout_id && layoutScopeKey(d.scope) === row.scope_key)
        return doc ? [{ scope: doc.scope, layoutId: doc.id }] : []
      })
    return { documents, active }
  }

  save(input: LayoutDocument, activate: boolean, basedOn?: LayoutClock) {
    const document = layoutDocumentSchema.parse(input)
    const scope = layoutScopeKey(document.scope)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT document FROM layout_documents WHERE scope_key = ? AND id = ?').get(scope, document.id) as { document: string } | undefined
      const previous = row ? layoutDocumentSchema.parse(JSON.parse(row.document)) : undefined
      let winner = document
      const recovered: LayoutDocument[] = []
      const sequential = previous && basedOn && canonical(layoutClock(previous)) === canonical(basedOn) && compareLayouts(document, previous) > 0
      if (previous && !sequential && canonical(previous) !== canonical(document)) {
        const order = compareLayouts(previous, document)
        // Equal clocks with different contents are malformed replication, not an
        // opportunity for delivery-order-dependent convergence.
        if (order === 0) throw new Error('layout_clock_collision')
        winner = order > 0 ? previous : document
        const loser = order > 0 ? document : previous
        const digest = createHash('sha256').update(canonical(loser)).digest('hex')
        const inserted = this.db.prepare('INSERT OR IGNORE INTO layout_recoveries VALUES (?, ?, ?)').run(scope, document.id, digest)
        if (inserted.changes) {
          const copy = { ...loser, id: `recovered/${digest}`, name: 'Recovered layout' }
          this.db.prepare('INSERT OR IGNORE INTO layout_documents VALUES (?, ?, ?)').run(scope, copy.id, canonical(copy))
          recovered.push(copy)
        }
      }
      this.db.prepare('INSERT INTO layout_documents VALUES (?, ?, ?) ON CONFLICT(scope_key, id) DO UPDATE SET document=excluded.document').run(scope, document.id, canonical(winner))
      if (activate) this.db.prepare('INSERT INTO layout_active VALUES (?, ?) ON CONFLICT(scope_key) DO UPDATE SET layout_id=excluded.layout_id').run(scope, document.id)
      this.db.exec('COMMIT')
      return { document: winner, recovered }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  geometry(scope: LayoutScope, device: string, layoutId: string): LayoutGeometry {
    const row = this.db.prepare('SELECT geometry FROM layout_geometry WHERE scope_key=? AND device=? AND layout_id=?').get(layoutScopeKey(scope), device, layoutId) as { geometry: string } | undefined
    return row ? JSON.parse(row.geometry) as LayoutGeometry : {}
  }
  saveGeometry(scope: LayoutScope, device: string, layoutId: string, geometry: LayoutGeometry): void {
    this.db.prepare('INSERT INTO layout_geometry VALUES (?, ?, ?, ?) ON CONFLICT(scope_key, device, layout_id) DO UPDATE SET geometry=excluded.geometry').run(layoutScopeKey(scope), device, layoutId, JSON.stringify(geometry))
  }
}
