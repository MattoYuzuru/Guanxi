// G14 seeded violation: an icon-only button with no accessible name.
import { Settings } from 'lucide-react'
import type { Story, StoryMeta } from '../../../../../src/story-kit/index.tsx'

function UnnamedIconButton() {
  return (
    <button type="button" className="gx-button gx-icon-button" data-variant="ghost">
      <Settings aria-hidden="true" />
    </button>
  )
}

const meta = { title: 'Gate fixtures/G14', component: UnnamedIconButton } satisfies StoryMeta<object>

export default meta

export const UnnamedIconButtonStory: Story<object> = { name: 'unnamed-icon-button' }
