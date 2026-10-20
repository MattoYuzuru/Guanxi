// G15 seeded violation: a label that clips in Russian and in the +40% pseudo-locale.
import { useUiText } from '../../../../../src/i18n/context.tsx'
import type { Story, StoryMeta } from '../../../../../src/story-kit/index.tsx'
import './g15.css'

function FixedWidthLabel() {
  const t = useUiText()
  return <span className="gx-seeded-fixed-width">{t('story.button.label')}</span>
}

const meta = { title: 'Gate fixtures/G15', component: FixedWidthLabel } satisfies StoryMeta<object>

export default meta

export const FixedWidthLabelStory: Story<object> = { name: 'fixed-width-label' }
