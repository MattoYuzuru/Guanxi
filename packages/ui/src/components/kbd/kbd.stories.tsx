import { machine, type Story, type StoryMeta } from '../../story-kit/index.tsx'
import { Kbd, type KbdProps } from './kbd.tsx'

const meta = {
  title: 'Primitives/Kbd',
  component: Kbd,
  args: { keys: [machine('K')] },
} satisfies StoryMeta<KbdProps>

export default meta

export const DefaultState: Story<KbdProps> = { name: 'default' }

export const ComboState: Story<KbdProps> = { name: 'combo', args: { keys: [machine('⌘'), machine('K')] } }
