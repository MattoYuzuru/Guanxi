import { msg, type Story, type StoryMeta } from '../../story-kit/index.tsx'
import { Badge, type BadgeProps } from './badge.tsx'

const meta = {
  title: 'Primitives/Badge',
  component: Badge,
  args: { children: msg('story.badge.neutral') },
} satisfies StoryMeta<BadgeProps>

export default meta

export const Neutral: Story<BadgeProps> = { name: 'neutral' }

export const Accent: Story<BadgeProps> = {
  name: 'accent',
  args: { tone: 'accent', children: msg('story.badge.accent') },
}

export const InfoTone: Story<BadgeProps> = {
  name: 'info',
  args: { tone: 'info', children: msg('story.badge.info') },
}

export const SuccessTone: Story<BadgeProps> = {
  name: 'success',
  args: { tone: 'success', children: msg('story.badge.success') },
}

export const WarningTone: Story<BadgeProps> = {
  name: 'warning',
  args: { tone: 'warning', children: msg('story.badge.warning') },
}

export const DangerTone: Story<BadgeProps> = {
  name: 'danger',
  args: { tone: 'danger', children: msg('story.badge.danger') },
}
