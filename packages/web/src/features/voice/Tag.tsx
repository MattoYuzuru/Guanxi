import type { ReactNode } from 'react'

const TONES = {
  neutral: 'border-divider text-secondary',
  warning: 'border-warning text-warning',
  info: 'border-info text-info',
} as const

/** A short fact about an entry. The words carry the meaning; the border colour only echoes it. */
export function Tag({ tone = 'neutral', children, ...props }: { tone?: keyof typeof TONES; children: ReactNode; 'aria-describedby'?: string }) {
  return <span {...props} className={`inline-flex min-h-5 max-w-full items-center rounded-control border px-2 text-12 ${TONES[tone]}`}>{children}</span>
}
