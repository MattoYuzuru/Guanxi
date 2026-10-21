import { layoutScopeKey, type LayoutDocument } from '@guanxi/contract'
import type { ConfigOperation } from '@guanxi/contract/federation'
import { FederationError, hash } from '../federation/crypto.ts'

export function layoutOperationKey(document: LayoutDocument): string {
  return `layout:${hash([layoutScopeKey(document.scope), document.id])}`
}

export function validateLayoutOperation(operation: ConfigOperation): void {
  if (operation.value.kind !== 'layout') return
  if (operation.value.document.scope.account !== operation.accountId) throw new FederationError('owner_mismatch', 403)
  if (operation.key !== layoutOperationKey(operation.value.document)) throw new FederationError('invalid_layout_key', 400)
}
