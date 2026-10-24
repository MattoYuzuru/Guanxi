import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { FitVerdict } from '@guanxi/contract'
import { FitIndicator } from '../../src/features/models/FitIndicator.tsx'
import { formatBytes } from '../../src/lib/format.ts'
import { setActiveLocale } from '../../src/lib/locale.ts'

const CYRILLIC = /[Ѐ-ӿ]/u
const verdict = (patch: Partial<FitVerdict>): FitVerdict => ({
  level: 'green',
  // The node's own prose is Russian; the English interface must not show it.
  summary: '4.0 ГБ из 8.0 ГБ — запас есть',
  contextLength: 8_192,
  modelBytes: 3_000_000_000,
  kvCacheBytes: 1_000_000_000,
  requiredBytes: 4_000_000_000,
  usableBytes: 8_000_000_000,
  utilization: 0.5,
  basis: 'estimate',
  measured: null,
  ...patch,
})

afterEach(() => { cleanup(); setActiveLocale('ru') })

describe('fit text is localised from the reason code', () => {
  it('renders the English reason, never the node summary, in the English interface', () => {
    setActiveLocale('en')
    const { container } = render(<FitIndicator fit={verdict({ reason: 'headroom' })} />)
    expect(container.textContent).toContain(`${formatBytes(4_000_000_000)} of ${formatBytes(8_000_000_000)} with headroom`)
    expect(container.textContent).not.toMatch(CYRILLIC)
    expect(container.textContent).not.toContain('запас есть')
  })

  it('renders the Russian reason in the Russian interface', () => {
    setActiveLocale('ru')
    const { container } = render(<FitIndicator fit={verdict({ level: 'red', reason: 'loaded_partial_gpu', measured: { sizeBytes: 9_000_000_000, gpuPercent: 40, processorLabel: '40% GPU / 60% CPU' } })} />)
    expect(container.textContent).toContain('На ускорителе только 40%')
  })

  it('falls back to the localised level when an older node sends no reason', () => {
    setActiveLocale('en')
    const { container } = render(<FitIndicator fit={verdict({ reason: undefined })} compact />)
    expect(container.textContent).not.toMatch(CYRILLIC)
  })
})
