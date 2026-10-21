// G11 seed: a draft component reached through a root alias.
import { ConfirmButton } from '@guanxi/ui'

export function Confirm({ label }: { label: string }) {
  return <ConfirmButton>{label}</ConfirmButton>
}
