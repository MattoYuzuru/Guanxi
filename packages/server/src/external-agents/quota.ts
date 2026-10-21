import type { QuotaWindow } from './types.ts'

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const percent = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const reset = (value: unknown) => {
  const ms = typeof value === 'number' ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(ms) && ms >= 0 && ms <= 8.64e15 ? new Date(ms).toISOString() : null
}
/** Only documented numeric facts are accepted; absent/malformed values remain unknown. */
export function claudeRateLimits(statusline: unknown): QuotaWindow[] {
  const limits = object(object(statusline).rate_limits)
  return ['five_hour', 'seven_day'].map(name => {
    const window = object(limits[name])
    return { name, usedPercent: percent(window.used_percentage), resetsAt: reset(window.resets_at) }
  })
}
export function codexRateLimits(input: unknown): QuotaWindow[] {
  const report = object(input)
  const byId = object(report.rateLimitsByLimitId)
  const limitId = typeof object(report.rateLimits).limitId === 'string' ? String(object(report.rateLimits).limitId) : 'codex'
  const groups = Object.keys(byId).length ? Object.entries(byId) : [[limitId, report.rateLimits]] as const
  return groups.flatMap(([id, raw]) => ['primary', 'secondary'].map(name => {
    const window = object(object(raw)[name])
    return { name: `${id}.${name}`, usedPercent: percent(window.usedPercent), resetsAt: reset(window.resetsAt) }
  }))
}
export { object as protocolObject }
