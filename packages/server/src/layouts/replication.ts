import { layoutScopeKey, type LayoutClock, type LayoutDocument, type LayoutGeometry, type LayoutQuery, type LayoutScope } from '@guanxi/contract'
import type { SignedConfigOperation } from '@guanxi/contract/federation'
import { compareConfigOperations, type SharedConfig } from '../federation/config.ts'
import { FederationError } from '../federation/crypto.ts'
import type { Db } from '../store/db.ts'
import { LayoutStore } from './store.ts'
import { layoutOperationKey } from './operation.ts'
import { initializeLayoutReplicationSchema } from './schema.ts'

export type LayoutRepository = Pick<LayoutStore, 'list' | 'save' | 'geometry' | 'saveGeometry'>

/** Portable documents travel only as admitted F1 operations. Geometry never enters this path. */
export class ReplicatedLayouts implements LayoutRepository {
  private readonly store: LayoutStore
  private readonly db: Db
  readonly account: string
  private readonly config: SharedConfig
  private readonly assertReady: () => void
  private lastProjection: { origin: string; counter: number; result: ReturnType<LayoutStore['save']> } | undefined
  constructor(db: Db, account: string, config: SharedConfig, assertReady: () => void) {
    this.store = new LayoutStore(db); this.db = db; this.account = account; this.config = config; this.assertReady = assertReady
    initializeLayoutReplicationSchema(db)
  }

  private own(account: string): void {
    this.assertReady()
    if (account !== this.account) throw new FederationError('owner_mismatch', 403)
  }

  /** Called only after signature/identity admission, inside the operation's transaction. */
  project(signed: SignedConfigOperation): void {
    const operation = signed.operation
    if (operation.value.kind !== 'layout') return
    const { document, activate, basedOn } = operation.value
    this.own(document.scope.account)
    const scope = layoutScopeKey(document.scope)
    // Activation chooses between named IDs using the signed configuration clock. Never let
    // network delivery order choose which named layout is active on a receiving device.
    const previous = this.db.prepare('SELECT wall,logical,origin,counter FROM layout_activation_clock WHERE scope_key=?').get(scope) as
      { wall: number; logical: number; origin: string; counter: number } | undefined
    const activates = activate && (!previous || compareConfigOperations(operation, { ...previous, clock: previous }) > 0)
    const result = this.store.applyWithinTransaction(document, activates, basedOn)
    if (activates) this.db.prepare(`INSERT INTO layout_activation_clock VALUES (?,?,?,?,?)
      ON CONFLICT(scope_key) DO UPDATE SET wall=excluded.wall,logical=excluded.logical,origin=excluded.origin,counter=excluded.counter`)
      .run(scope, operation.clock.wall, operation.clock.logical, operation.origin, operation.counter)
    this.lastProjection = { origin: operation.origin, counter: operation.counter, result }
  }

  list(query: LayoutQuery) { this.own(query.account); return this.store.list(query) }
  save(document: LayoutDocument, activate: boolean, basedOn?: LayoutClock) {
    this.own(document.scope.account)
    this.lastProjection = undefined
    const signed = this.config.create(layoutOperationKey(document), {
      kind: 'layout', document, activate, ...(basedOn ? { basedOn } : {}),
    })
    const projected = this.lastProjection as { origin: string; counter: number; result: ReturnType<LayoutStore['save']> } | undefined
    if (projected?.origin !== signed.operation.origin || projected.counter !== signed.operation.counter) throw new Error('layout_projection_missing')
    return projected.result
  }
  geometry(scope: LayoutScope, device: string, layoutId: string) {
    this.own(scope.account); return this.store.geometry(scope, device, layoutId)
  }
  saveGeometry(scope: LayoutScope, device: string, layoutId: string, geometry: LayoutGeometry) {
    this.own(scope.account); this.store.saveGeometry(scope, device, layoutId, geometry)
  }
}

