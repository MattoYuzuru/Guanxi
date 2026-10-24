/** Types for the plain-ESM copy inventory, so its tests are typechecked. */
export interface CopyViolation {
  file: string
  line: number
  column: number
  kind: string
  value: string
}

export function collectLocalizedCopyViolations(
  sourceText: string,
  fileName?: string,
  externalValues?: Map<string, readonly string[]>,
): CopyViolation[]

export function collectDynamicCopyViolations(sourceText: string, fileName?: string): CopyViolation[]

export function scanLocalizedWebCopy(sourceDirectory: string): CopyViolation[]
