import { G11CycleA } from '../g11-cycle-a/index.ts'

export function G11CycleB() {
  return <span>cycle</span>
}

export function G11CycleBBack() {
  return <G11CycleA />
}
