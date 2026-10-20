// G16 seeded violations: motion that ignores reduced motion — a loop, a finite entry rotation,
// and a thumb that slides when the switch is toggled.
import { useState } from 'react'
import type { Story, StoryMeta } from '../../../../../src/story-kit/index.tsx'
import './g16.css'

function LoopingSpinner() {
  return <span className="gx-seeded-spinner" aria-hidden="true" />
}

function FiniteEntry() {
  return <span className="gx-seeded-entry" aria-hidden="true" />
}

function SlidingToggle() {
  const [on, setOn] = useState(false)
  return (
    <button type="button" role="switch" aria-checked={on} aria-label="seed" className="gx-seeded-toggle" onClick={() => setOn(!on)}>
      <span className="gx-seeded-thumb" />
    </button>
  )
}

const meta = { title: 'Gate fixtures/G16', component: LoopingSpinner } satisfies StoryMeta<object>

export default meta

export const LoopingSpinnerStory: Story<object> = { name: 'looping-spinner' }
export const FiniteEntryStory: Story<object> = { name: 'finite-entry', render: () => <FiniteEntry /> }
export const SlidingToggleStory: Story<object> = { name: 'sliding-toggle', render: () => <SlidingToggle /> }
