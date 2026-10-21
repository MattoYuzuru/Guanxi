import { msg, type Story, type StoryMeta } from '../../story-kit/index.tsx'
import { Checkbox, type CheckboxProps } from './checkbox.tsx'

const meta = {
  title: 'Primitives/Checkbox',
  component: Checkbox,
  args: { label: msg('story.checkbox.label') },
} satisfies StoryMeta<CheckboxProps>

export default meta

export const Unchecked: Story<CheckboxProps> = { name: 'unchecked' }

export const Checked: Story<CheckboxProps> = { name: 'checked', args: { defaultChecked: true } }

export const Indeterminate: Story<CheckboxProps> = {
  name: 'indeterminate',
  args: { indeterminate: true },
}

export const Hover: Story<CheckboxProps> = { name: 'hover', parameters: { guanxi: { force: 'hover' } } }

export const FocusVisible: Story<CheckboxProps> = {
  name: 'focus-visible',
  parameters: { guanxi: { force: 'focus-visible' } },
}

export const Disabled: Story<CheckboxProps> = {
  name: 'disabled',
  args: { disabled: true, defaultChecked: true },
}
