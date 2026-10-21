import { msg, type Story, type StoryMeta } from '../../story-kit/index.tsx'
import { Switch, type SwitchProps } from './switch.tsx'

const meta = {
  title: 'Primitives/Switch',
  component: Switch,
  args: { label: msg('story.switch.label') },
} satisfies StoryMeta<SwitchProps>

export default meta

export const Off: Story<SwitchProps> = { name: 'off' }

export const On: Story<SwitchProps> = { name: 'on', args: { defaultChecked: true } }

export const Hover: Story<SwitchProps> = { name: 'hover', parameters: { guanxi: { force: 'hover' } } }

export const FocusVisible: Story<SwitchProps> = {
  name: 'focus-visible',
  parameters: { guanxi: { force: 'focus-visible' } },
}

export const Disabled: Story<SwitchProps> = { name: 'disabled', args: { disabled: true } }
