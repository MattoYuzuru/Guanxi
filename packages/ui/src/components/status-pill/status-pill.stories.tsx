import type { Story, StoryMeta } from '../../story-kit/index.tsx'
import { StatusPill, type StatusPillProps } from './status-pill.tsx'

const meta = {
  title: 'Patterns/StatusPill',
  component: StatusPill,
  args: { status: 'running' },
} satisfies StoryMeta<StatusPillProps>

export default meta

export const Running: Story<StatusPillProps> = { name: 'running' }

export const Waiting: Story<StatusPillProps> = { name: 'waiting', args: { status: 'waiting' } }

export const Hibernating: Story<StatusPillProps> = {
  name: 'hibernating',
  args: { status: 'hibernating' },
}

export const Finished: Story<StatusPillProps> = { name: 'finished', args: { status: 'finished' } }

export const ErrorStatus: Story<StatusPillProps> = { name: 'error', args: { status: 'error' } }

export const Unknown: Story<StatusPillProps> = { name: 'unknown', args: { status: 'unknown' } }
