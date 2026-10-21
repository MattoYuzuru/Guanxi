import { Pin, Settings } from 'lucide-react'
import { msg, type Story, type StoryMeta } from '../../story-kit/index.tsx'
import { IconButton, type IconButtonProps } from './icon-button.tsx'

const meta = {
  title: 'Primitives/IconButton',
  component: IconButton,
  args: { label: msg('story.iconButton.settings'), icon: <Settings />, variant: 'ghost' },
} satisfies StoryMeta<IconButtonProps>

export default meta

export const Default: Story<IconButtonProps> = { name: 'default' }

export const Secondary: Story<IconButtonProps> = {
  name: 'secondary',
  args: { variant: 'secondary' },
}

export const Hover: Story<IconButtonProps> = {
  name: 'hover',
  parameters: { guanxi: { force: 'hover' } },
}

export const FocusVisible: Story<IconButtonProps> = {
  name: 'focus-visible',
  parameters: { guanxi: { force: 'focus-visible' } },
}

export const Pressed: Story<IconButtonProps> = {
  name: 'pressed',
  args: { label: msg('story.iconButton.pin'), icon: <Pin />, pressed: true },
}

export const Disabled: Story<IconButtonProps> = { name: 'disabled', args: { disabled: true } }

export const TooltipOpen: Story<IconButtonProps> = {
  name: 'tooltip-open',
  args: { tooltipOpen: true, tooltipSide: 'bottom' },
  parameters: { guanxi: { frame: 'floating' } },
}
