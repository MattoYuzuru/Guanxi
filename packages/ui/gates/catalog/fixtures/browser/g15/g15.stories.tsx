// G15 seeded violations: labels that clip in Russian and in the +40% pseudo-locale, once in a
// fixed-width box and once because the regime frame itself clips.
import { useUiText } from '../../../../../src/i18n/context.tsx'
import type { Story, StoryMeta } from '../../../../../src/story-kit/index.tsx'
import './g15.css'

function FixedWidthLabel() {
  const t = useUiText()
  return <span className="gx-seeded-fixed-width">{t('story.button.label')}</span>
}

function FrameClip() {
  const t = useUiText()
  return <span className="gx-seeded-frame-clip">{t('story.button.label')}</span>
}

const meta = { title: 'Gate fixtures/G15', component: FixedWidthLabel } satisfies StoryMeta<object>

export default meta

export const FixedWidthLabelStory: Story<object> = { name: 'fixed-width-label' }
export const FrameClipStory: Story<object> = { name: 'frame-clip', render: () => <FrameClip /> }
