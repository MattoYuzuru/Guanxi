import { Save } from 'lucide-react'
import { localizedRender, msg, type Story, type StoryMeta } from '../../story-kit/index.tsx'
import { Button, type ButtonProps } from './button.tsx'

const meta = {
  title: 'Primitives/Button',
  component: Button,
  args: { children: msg('story.button.label'), variant: 'primary' },
} satisfies StoryMeta<ButtonProps>

export default meta

export const Default: Story<ButtonProps> = { name: 'default' }

export const Secondary: Story<ButtonProps> = {
  name: 'secondary',
  args: { variant: 'secondary' },
}

export const Ghost: Story<ButtonProps> = { name: 'ghost', args: { variant: 'ghost' } }

export const Danger: Story<ButtonProps> = {
  name: 'danger',
  args: { variant: 'danger', children: msg('story.button.danger') },
}

export const Hover: Story<ButtonProps> = { name: 'hover', parameters: { guanxi: { force: 'hover' } } }

export const FocusVisible: Story<ButtonProps> = {
  name: 'focus-visible',
  parameters: { guanxi: { force: 'focus-visible' } },
}

export const Active: Story<ButtonProps> = {
  name: 'active',
  parameters: { guanxi: { force: 'active' } },
}

export const Disabled: Story<ButtonProps> = { name: 'disabled', args: { disabled: true } }

export const Loading: Story<ButtonProps> = {
  name: 'loading',
  args: { loading: true, loadingLabel: msg('story.button.loading') },
}

export const WithIcon: Story<ButtonProps> = {
  name: 'with-icon',
  args: { variant: 'secondary', size: 'sm' },
  render: localizedRender((args) => (
    <Button {...args}>
      <Save aria-hidden="true" />
      {args.children}
    </Button>
  )),
}
