import { msg, type Story, type StoryMeta } from '../../story-kit/index.tsx'
import { useId } from 'react'
import { useUiText } from '../../i18n/context.tsx'
import { Input, type InputProps } from './input.tsx'

const meta = {
  title: 'Primitives/Input',
  component: Input,
  args: {
    'aria-label': msg('story.input.label'),
    placeholder: msg('story.input.placeholder'),
  },
} satisfies StoryMeta<InputProps>

export default meta

export const Default: Story<InputProps> = { name: 'default' }

export const Filled: Story<InputProps> = {
  name: 'filled',
  args: { defaultValue: msg('story.input.value') },
}

export const Hover: Story<InputProps> = { name: 'hover', parameters: { guanxi: { force: 'hover' } } }

export const FocusVisible: Story<InputProps> = {
  name: 'focus-visible',
  parameters: { guanxi: { force: 'focus-visible' } },
}

export const Invalid: Story<InputProps> = {
  name: 'invalid',
  render: () => <InvalidInputStory />,
}

function InvalidInputStory() {
  const id = useId(), t = useUiText()
  return <div>
    <label htmlFor={id}>{t('story.input.label')}</label>
    <Input id={id} invalid defaultValue={t('story.input.value')} aria-describedby={`${id}-error`} />
    <p id={`${id}-error`} role="alert" className="text-12 text-danger">{t('story.input.error')}</p>
  </div>
}

export const Disabled: Story<InputProps> = {
  name: 'disabled',
  args: { disabled: true, defaultValue: msg('story.input.value') },
}

export const ReadOnly: Story<InputProps> = {
  name: 'read-only',
  args: { readOnly: true, defaultValue: msg('story.input.value') },
}
