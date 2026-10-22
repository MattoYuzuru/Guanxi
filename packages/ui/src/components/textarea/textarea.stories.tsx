import { msg, type Story, type StoryMeta } from '../../story-kit/index.tsx'
import { Textarea, type TextareaProps } from './textarea.tsx'
import { useId } from 'react'
import { useUiText } from '../../i18n/context.tsx'

const meta = {
  title: 'Primitives/Textarea',
  component: Textarea,
  args: {
    'aria-label': msg('story.textarea.label'),
    placeholder: msg('story.textarea.placeholder'),
  },
} satisfies StoryMeta<TextareaProps>

export default meta

export const Default: Story<TextareaProps> = { name: 'default' }

export const Filled: Story<TextareaProps> = {
  name: 'filled',
  args: { defaultValue: msg('story.textarea.value') },
}

export const FocusVisible: Story<TextareaProps> = {
  name: 'focus-visible',
  parameters: { guanxi: { force: 'focus-visible' } },
}

export const Invalid: Story<TextareaProps> = {
  name: 'invalid',
  render: () => <InvalidTextareaStory />,
}

function InvalidTextareaStory() {
  const id = useId(), t = useUiText()
  return <div>
    <label htmlFor={id}>{t('story.textarea.label')}</label>
    <Textarea id={id} invalid aria-describedby={`${id}-error`} />
    <p id={`${id}-error`} role="alert" className="text-12 text-danger">{t('story.textarea.error')}</p>
  </div>
}

export const Disabled: Story<TextareaProps> = {
  name: 'disabled',
  args: { disabled: true, defaultValue: msg('story.textarea.value') },
}
