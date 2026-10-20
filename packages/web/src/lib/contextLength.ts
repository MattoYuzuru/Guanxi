import type { ModelContextLimit } from '@guanxi/contract'

export function parsePositiveSafeInteger(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function exceedsDeclaredContextLimit(
  value: number,
  limit: ModelContextLimit | null | undefined,
): boolean {
  return limit?.state === 'declared' && value > limit.value
}
