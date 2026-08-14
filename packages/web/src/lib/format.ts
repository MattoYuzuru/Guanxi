/** Locale-aware common formatting. Units remain base-1024 compatibility labels. */
import { getActiveLocale, translate, type LocaleKey } from './locale.ts'

const NBSP = ' '

export function formatBytes(bytes: number | null | undefined, digits?: number): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  if (bytes === 0) return `0${NBSP}${translate('format.bytes.byte')}`

  const units = [
    'format.bytes.byte',
    'format.bytes.kibibyte',
    'format.bytes.mebibyte',
    'format.bytes.gibibyte',
    'format.bytes.tebibyte',
  ] as const satisfies readonly LocaleKey[]
  const exp = Math.min(Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exp
  // Байты и килобайты дробями показывать незачем.
  const precision = digits ?? (exp <= 1 ? 0 : value < 10 ? 2 : 1)
  return `${trimZeros(value.toFixed(precision))}${NBSP}${translate(units[exp]!)}`
}

export function formatBytesPerSecond(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '—'
  return translate('format.rate.perSecond', { value: formatBytes(bps) })
}

/** Длительности показываем по-разному: миллисекунды важны при попадании в кэш. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  const millisecond = translate('format.duration.millisecond')
  const second = translate('format.duration.second')
  const minute = translate('format.duration.minute')
  const hour = translate('format.duration.hour')
  if (ms < 1) return `<1${NBSP}${millisecond}`
  if (ms < 1000) return `${Math.round(ms)}${NBSP}${millisecond}`
  if (ms < 10_000) return `${trimZeros((ms / 1000).toFixed(1))}${NBSP}${second}`
  if (ms < 60_000) return `${Math.round(ms / 1000)}${NBSP}${second}`

  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}${NBSP}${minute}${seconds ? ` ${seconds}${NBSP}${second}` : ''}`

  const hours = Math.floor(minutes / 60)
  return `${hours}${NBSP}${hour}${minutes % 60 ? ` ${minutes % 60}${NBSP}${minute}` : ''}`
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '—'
  }
  return formatDuration(seconds * 1000)
}

export function formatTokens(count: number | null | undefined): string {
  if (count === null || count === undefined || !Number.isFinite(count)) return '—'
  if (Math.abs(count) < 1000) return String(Math.round(count))
  if (Math.abs(count) < 100_000) {
    return translate('format.compact.thousand', {
      value: trimZeros((count / 1000).toFixed(1)),
    })
  }
  return translate('format.compact.thousand', { value: Math.round(count / 1000) })
}

/** Размер окна: 32768 → «32k». Точные значения тут только путают. */
export function formatContextLength(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens)) return '—'
  if (tokens >= 1_048_576) {
    return translate('format.compact.million', {
      value: trimZeros((tokens / 1_048_576).toFixed(1)),
    })
  }
  if (tokens >= 1024) {
    return translate('format.compact.thousand', {
      value: trimZeros((tokens / 1024).toFixed(tokens % 1024 === 0 ? 0 : 1)),
    })
  }
  return String(tokens)
}

export function formatInteger(value: number): string {
  return new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 0 }).format(value)
}

export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${trimZeros(value.toFixed(digits))}%`
}

/** utilization приходит как 0..1+, показываем процентами. */
export function formatUtilization(utilization: number): string {
  return formatPercent(utilization * 100, utilization < 0.1 ? 1 : 0)
}

export function formatTokensPerSecond(tps: number | null | undefined): string {
  if (tps === null || tps === undefined || !Number.isFinite(tps)) return '—'
  return translate('format.tokensPerSecond', { value: trimZeros(tps.toFixed(1)) })
}

const RELATIVE_STEPS: Array<[limit: number, divisor: number, unit: Intl.RelativeTimeFormatUnit]> = [
  [60_000, 1000, 'second'],
  [3_600_000, 60_000, 'minute'],
  [86_400_000, 3_600_000, 'hour'],
  [604_800_000, 86_400_000, 'day'],
  [2_592_000_000, 604_800_000, 'week'],
  [31_536_000_000, 2_592_000_000, 'month'],
]

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return '—'

  const diff = timestamp - Date.now()
  const abs = Math.abs(diff)
  const locale = currentLocale()
  if (abs < 45_000) return translate('format.relative.justNow')
  const relativeFormatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })

  for (const [limit, divisor, unit] of RELATIVE_STEPS) {
    if (abs < limit) return relativeFormatter.format(Math.round(diff / divisor), unit)
  }
  return relativeFormatter.format(Math.round(diff / 31_536_000_000), 'year')
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return '—'
  return new Intl.DateTimeFormat(currentLocale(), {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return '—'
  return new Intl.DateTimeFormat(currentLocale(), {
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

/** Путь для узкой колонки: /Users/me/Projects/app → …/Projects/app */
export function shortenPath(path: string, segments = 2): string {
  const parts = path.split('/').filter(Boolean)
  if (parts.length <= segments) return path
  return `…/${parts.slice(-segments).join('/')}`
}

export function pluralize(count: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(count) % 100
  const mod10 = mod100 % 10
  if (mod100 >= 11 && mod100 <= 14) return many
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

export function formatCount(count: number, one: string, few: string, many: string): string {
  return `${count}${NBSP}${pluralize(count, one, few, many)}`
}

function trimZeros(value: string): string {
  return value.replace(/\.?0+$/, '')
}

function currentLocale(): 'en' | 'ru' {
  return getActiveLocale()
}

export { NBSP }
