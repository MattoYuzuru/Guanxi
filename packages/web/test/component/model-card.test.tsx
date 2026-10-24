import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { localModelSchema } from '@guanxi/contract'
import { ModelCard } from '../../src/features/models/ModelCard.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'
import { formatBytes } from '../../src/lib/format.ts'
import { factPairs } from '../helpers/facts.ts'

const local = localModelSchema.parse({
  name: 'fixture:7b',
  digest: 'sha256:fixture',
  sizeBytes: 4_000_000_000,
  modifiedAt: '2026-10-20T00:00:00.000Z',
  family: 'qwen2',
  parameterSize: '7.6B',
  quantization: 'Q4_K_M',
  contextLength: 32_768,
  contextLimit: { state: 'declared', value: 32_768, source: 'ollama_api_show', observedAt: '2026-10-20T00:00:00.000Z', confidence: 'declared' },
  capabilities: ['completion'],
  isCloud: false,
  fit: {
    level: 'green', summary: 'запас есть', reason: 'headroom', contextLength: 8_192, modelBytes: 4_000_000_000,
    kvCacheBytes: 500_000_000, requiredBytes: 4_500_000_000, usableBytes: 12_000_000_000, utilization: 0.375,
    basis: 'estimate', measured: null,
  },
})

afterEach(() => { cleanup(); setActiveLocale('ru') })

describe('model card (visual pass)', () => {
  it('lists the model as facts, not a row of badges', () => {
    setActiveLocale('en')
    const { container } = render(<ModelCard data={{ kind: 'local', model: local }} />)
    const card = container.querySelector('article')!
    expect(card.querySelectorAll('.legacy-badge')).toHaveLength(0)
    // At most four key facts on the card (visual pass 3); the family and the rest are in the details.
    expect(factPairs(card)).toEqual([['Parameters', '7.6B'], ['Quantization', 'Q4_K_M'], ['Context window', '32k'], ['On disk', formatBytes(4_000_000_000)]])
    expect(within(card).getAllByRole('button', { name: 'Model details' })).toHaveLength(1)
    expect(card.textContent).not.toMatch(/[Ѐ-ӿ]/u)
  })

  it('offers one primary action; the name is the way to the profile', () => {
    setActiveLocale('en')
    const { container } = render(<ModelCard data={{ kind: 'local', model: local }} />)
    const card = container.querySelector('article')!
    const links = within(card).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(['fixture:7b', 'Start chat'])
    expect(within(card).queryByRole('link', { name: 'Profile' })).toBeNull()
  })

  it('explains facts through design popovers, never native title tooltips (round 4 review 7)', async () => {
    setActiveLocale('en')
    const cloud = localModelSchema.parse({ ...local, name: 'cloud-model:latest', isCloud: true })
    const { container } = render(<><ModelCard data={{ kind: 'local', model: local }} /><ModelCard data={{ kind: 'local', model: cloud }} /></>)
    expect([...container.querySelectorAll('[title]')].map(node => `${node.tagName}:${node.getAttribute('title')}`)).toEqual([])
    const card = container.querySelector('article')!
    // The context fact's explanation opens from a named icon, by keyboard or touch alike.
    fireEvent.click(within(card).getByRole('button', { name: 'About Context window' }))
    expect((await screen.findByRole('dialog')).textContent).toContain('declared')
  })
})
