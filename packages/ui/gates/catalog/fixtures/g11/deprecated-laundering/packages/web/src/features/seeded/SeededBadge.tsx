// G11 seeded violation: an unsigned "deprecated" record must not let a draft onto a product screen.
import { Badge } from '@guanxi/ui'

export function SeededBadge({ label }: { label: string }) {
  return <Badge>{label}</Badge>
}
