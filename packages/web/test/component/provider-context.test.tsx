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
