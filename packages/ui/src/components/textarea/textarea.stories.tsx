import { msg, type Story, type StoryMeta } from '../../story-kit/index.tsx'
import { Textarea, type TextareaProps } from './textarea.tsx'

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
  args: { invalid: true, defaultValue: msg('story.textarea.value') },
}

export const Disabled: Story<TextareaProps> = {
  name: 'disabled',
  args: { disabled: true, defaultValue: msg('story.textarea.value') },
}
