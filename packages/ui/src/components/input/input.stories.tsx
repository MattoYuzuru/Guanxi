import { msg, type Story, type StoryMeta } from '../../story-kit/index.tsx'
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
  args: { invalid: true, defaultValue: msg('story.input.value') },
}

export const Disabled: Story<InputProps> = {
  name: 'disabled',
  args: { disabled: true, defaultValue: msg('story.input.value') },
}

export const ReadOnly: Story<InputProps> = {
  name: 'read-only',
  args: { readOnly: true, defaultValue: msg('story.input.value') },
}
