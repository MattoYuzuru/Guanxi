import { useState, type ComponentType } from 'react'
import { useUiText } from '../../i18n/context.tsx'
import type { Story, StoryMeta } from '../../story-kit/index.tsx'
import { SegmentedControl, type SegmentedControlProps } from './segmented-control.tsx'

type Density = 'compact' | 'comfortable'
type Props = SegmentedControlProps<Density>

function Demo({ iconOnly = false, disabled = false }: { iconOnly?: boolean; disabled?: boolean }) {
  const t = useUiText()
  const [value, setValue] = useState<Density>('compact')
  return (
    <SegmentedControl
      label={t('story.segmented.label')}
      value={value}
      onValueChange={setValue}
      iconOnly={iconOnly}
      disabled={disabled}
      options={[
        { value: 'compact', label: t('story.segmented.compact'), icon: 'density-compact' },
        { value: 'comfortable', label: t('story.segmented.comfortable'), icon: 'density-comfortable' },
      ]}
    />
  )
}

const meta = {
  title: 'Primitives/SegmentedControl',
  component: SegmentedControl as ComponentType<Props>,
  render: () => <Demo />,
} satisfies StoryMeta<Props>

export default meta

export const DefaultState: Story<Props> = { name: 'default' }

export const IconsState: Story<Props> = { name: 'icons', render: () => <Demo iconOnly /> }

export const FocusVisibleState: Story<Props> = {
  name: 'focus-visible',
  parameters: { guanxi: { force: 'focus-visible' } },
}

export const DisabledState: Story<Props> = { name: 'disabled', render: () => <Demo disabled /> }
