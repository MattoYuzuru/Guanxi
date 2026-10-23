import { useState } from 'react'
import { useUiText } from '../../i18n/context.tsx'
import type { Story, StoryMeta } from '../../story-kit/index.tsx'
import { Button } from '../button/button.tsx'
import { Icon } from '../icon/icon.tsx'
import { Composer, type ComposerProps } from './composer.tsx'

function Demo({ initial = '', ...overrides }: Partial<ComposerProps> & { initial?: string }) {
  const t = useUiText()
  const [value, setValue] = useState(initial === 'draft' ? t('story.composer.draft') : initial)
  return (
    <div className="gx-composer-story">
      <Composer
        label={t('story.composer.label')}
        placeholder={t('story.composer.placeholder')}
        value={value}
        onValueChange={setValue}
        onSend={() => setValue('')}
        onStop={() => undefined}
        leading={<Button variant="ghost" size="sm"><Icon name="permission-read" />{t('story.composer.permission')}</Button>}
        trailing={<Button variant="ghost" size="sm">{t('story.composer.model')}<Icon name="chevron-down" /></Button>}
        {...overrides}
      />
    </div>
  )
}

const meta = {
  title: 'Patterns/Composer',
  component: Composer,
  parameters: { guanxi: { frame: 'floating' } },
  render: () => <Demo layout="centered" />,
} satisfies StoryMeta<ComposerProps>

export default meta

export const EmptyState: Story<ComposerProps> = { name: 'empty' }

export const TypingState: Story<ComposerProps> = { name: 'typing', render: () => <Demo layout="centered" initial="draft" /> }

export const RunningState: Story<ComposerProps> = { name: 'running', render: () => <Demo running /> }

export const DisabledState: Story<ComposerProps> = { name: 'disabled', render: () => <Demo disabled /> }

export const DockedState: Story<ComposerProps> = { name: 'docked', render: () => <Demo initial="draft" /> }
