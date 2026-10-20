import type { EffectiveReviewStatus, StoredReviewStatus } from './approval/record.ts'

export interface ManifestProp {
  name: string
  type: string
  required: boolean
  description: string
}

export interface ManifestComponent {
  id: string
  title: string
  level: 'primitive' | 'pattern'
  folder: string
  exports: string[]
  componentExports: string[]
  states: string[]
  stories: string[]
  props: Record<string, ManifestProp[]>
  cssVariables: string[]
  sourceHash: string
  snapshotHashes: Record<string, string>
  storedStatus: StoredReviewStatus
  signature: 'absent' | 'valid' | 'invalid'
  status: EffectiveReviewStatus
  usage: { count: number; files: string[] }
  since: string | null
}

export interface CatalogManifest {
  $comment: string
  version: 1
  components: ManifestComponent[]
}
