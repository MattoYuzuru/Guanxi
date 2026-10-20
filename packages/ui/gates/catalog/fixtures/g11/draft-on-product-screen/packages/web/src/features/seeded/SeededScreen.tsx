// G11 seeded violation: a product screen uses a component whose review status is draft.
import { Button } from '@guanxi/ui'

export function SeededScreen({ label }: { label: string }) {
  return <Button>{label}</Button>
}
