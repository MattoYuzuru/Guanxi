import { machine, type Story, type StoryMeta } from '../../story-kit/index.tsx'
import { ProvenanceLabel, type ProvenanceLabelProps } from './provenance-label.tsx'

const NOW = '2026-10-20T14:08:00.000Z'

const meta = {
  title: 'Patterns/ProvenanceLabel',
  component: ProvenanceLabel,
  args: {
    source: machine('ollama /api/ps'),
    observedAt: '2026-10-20T14:07:48.000Z',
    now: NOW,
  },
} satisfies StoryMeta<ProvenanceLabelProps>

export default meta

export const Fresh: Story<ProvenanceLabelProps> = { name: 'fresh' }

export const Aged: Story<ProvenanceLabelProps> = {
  name: 'aged',
  args: { observedAt: '2026-10-20T14:02:00.000Z', source: machine('node mac-studio') },
}

export const Unknown: Story<ProvenanceLabelProps> = {
  name: 'unknown',
  args: { observedAt: null, source: machine('model metadata') },
}

export const Estimated: Story<ProvenanceLabelProps> = {
  name: 'estimated',
  args: { estimated: true, confidence: 'medium', source: machine('guanxi meter') },
}
