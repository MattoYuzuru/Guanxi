/**
 * Lane DS1-b gates, in the order the shared runner should run them. DS1-a's registry appends
 * `...catalogGates` (one import, no other edits); see docs/plans/lanes/DS1-b.handoff.md.
 */
import { g10 } from './g10-catalog-complete.ts'
import { g11 } from './g11-status-policy.ts'
import { g12 } from './g12-approval-integrity.ts'
import { g15 } from './g15-i18n-literals.ts'
import { browserGates } from './browser/gates.ts'
import type { CatalogGate } from './types.ts'

export const catalogGates: CatalogGate[] = [g10, g11, g12, g15, ...browserGates]
