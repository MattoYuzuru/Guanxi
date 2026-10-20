// G16 seeded violation: a looping spinner with no reduced-motion rule.
import type { Story, StoryMeta } from '../../../../../src/story-kit/index.tsx'
import './g16.css'

function LoopingSpinner() {
  return <span className="gx-seeded-spinner" aria-hidden="true" />
}

const meta = { title: 'Gate fixtures/G16', component: LoopingSpinner } satisfies StoryMeta<object>

export default meta

export const LoopingSpinnerStory: Story<object> = { name: 'looping-spinner' }
