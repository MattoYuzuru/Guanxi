import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ContextChip, ContextPanel } from '../../src/features/context/ContextPanel.tsx'
import type { ContextState } from '@guanxi/contract'

for (const limit of [null, 128_000]) it(`shows provider context ${limit ?? 'unknown'} with provenance and no compaction`, () => {
  const context: ContextState = { usedTokens: 20, allocatedTokens: limit, percent: limit ? 20 / limit * 100 : null,
    cacheHit: false, cachedTokens: 0, compactable: false, estimatedRepefillMs: 0,
    providerContext: { value: limit, source: 'provider.fixture', observedAt: '2026-10-23T10:00:00.000Z', confidence: limit ? 'medium' : 'unknown' } }
  const compact = vi.fn()
  render(<><ContextChip context={context} /><ContextPanel context={context} usage={null} compacting={false} onCompact={compact} /></>)
  expect(screen.getByText(/Источник: provider.fixture/).textContent).toContain('2026-10-23T10:00:00.000Z')
  expect(screen.getByText('Компакция у провайдера недоступна.')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.getAllByText(limit ? /Окно контекста провайдера:/ : 'Окно контекста провайдера неизвестно.')).toHaveLength(2)
  expect(document.body.textContent).not.toContain('4096')
  expect(compact).not.toHaveBeenCalled()
})

it('reads an unknown provider window as a word, and shows no cache dot before any tokens (round 4 review nits)', () => {
  const unknown: ContextState = { usedTokens: 0, allocatedTokens: null, percent: null, cacheHit: false, cachedTokens: 0, compactable: false, estimatedRepefillMs: 0,
    providerContext: { value: null, source: 'provider.fixture', observedAt: '2026-10-23T10:00:00.000Z', confidence: 'unknown' } }
  const { container, unmount } = render(<ContextChip context={unknown} />)
  expect(container.querySelector('.context-chip-value')?.textContent).toBe('неизвестно')
  unmount()
  const fresh: ContextState = { usedTokens: 0, allocatedTokens: 8192, percent: 0, cacheHit: false, cachedTokens: 0, compactable: false, estimatedRepefillMs: 0 }
  const view = render(<ContextChip context={fresh} />)
  expect(view.container.querySelectorAll('.context-chip-cache')).toHaveLength(0)
  view.unmount()
  const used: ContextState = { ...fresh, usedTokens: 120, percent: 1.5 }
  expect(render(<ContextChip context={used} />).container.querySelectorAll('.context-chip-cache')).toHaveLength(1)
})
