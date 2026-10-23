import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setActiveLocale } from '../../src/lib/locale.ts'
import { percentText } from '../../src/features/notifications/model.ts'

const dir = resolve(process.cwd(), 'src/features/notifications')
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')

describe('notification copy', () => {
  it('joins no visible strings in code: every separator lives in a locale template', () => {
    for (const file of ['NotificationBell.tsx', 'NotificationsPage.tsx', 'NotificationRow.tsx', 'model.ts']) {
      const code = stripComments(readFileSync(resolve(dir, file), 'utf8'))
      expect(code.includes('·'), `${file} joins text with a separator`).toBe(false)
      expect(/\$\{[^}]*pluralText[^}]*\}\. /u.test(code), `${file} joins sentences`).toBe(false)
    }
  })

  it('formats a percentage with the locale\'s own percent format', () => {
    setActiveLocale('en')
    expect(percentText(10)).toBe(new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 }).format(0.1))
    expect(percentText(10)).toBe('10%')
    expect(percentText(100)).toBe('100%')
    expect(percentText(0)).toBe('0%')
    expect(percentText(12.5)).toBe('12.5%')
    setActiveLocale('ru')
    expect(percentText(10)).toBe(new Intl.NumberFormat('ru', { style: 'percent', maximumFractionDigits: 1 }).format(0.1))
    expect(percentText(10)).toMatch(/^10\s%$/u)
    setActiveLocale('en')
  })
})
