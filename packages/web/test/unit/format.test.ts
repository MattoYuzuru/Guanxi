import { afterEach, describe, expect, it } from 'vitest'
import { formatBytes, formatPercent } from '../../src/lib/format.ts'
import { setActiveLocale } from '../../src/lib/locale.ts'

const NBSP = ' '

describe('number formatting keeps integer zeros', () => {
  afterEach(() => setActiveLocale('en'))

  it('formats whole percentages without dropping trailing zeros', () => {
    expect(formatPercent(10)).toBe('10%')
    expect(formatPercent(100)).toBe('100%')
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(12.5, 1)).toBe('12.5%')
    expect(formatPercent(12, 2)).toBe('12%')
  })

  it('formats byte sizes without dropping integer zeros', () => {
    setActiveLocale('en')
    expect(formatBytes(10 * 1024).startsWith(`10${NBSP}`)).toBe(true)
    expect(formatBytes(100).startsWith(`100${NBSP}`)).toBe(true)
    expect(formatBytes(2.5 * 1024 ** 2).startsWith(`2.5${NBSP}`)).toBe(true)
    expect(formatBytes(2 * 1024 ** 3).startsWith(`2${NBSP}`)).toBe(true)
  })
})
