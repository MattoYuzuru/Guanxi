import { useUiText } from '../../i18n/context.tsx'
import { machine, msg, type Story, type StoryMeta } from '../../story-kit/index.tsx'
import { StatusItem, type StatusItemProps } from './status-item.tsx'

function MemoryFacts() {
  const t = useUiText()
  return (
    <>
      <dl className="gx-popover-facts">
        <dt>{t('story.status.total')}</dt>
        <dd>{machine('24 GB')}</dd>
        <dt>{t('story.status.available')}</dt>
        <dd>{machine('16.8 GB')}</dd>
        <dt>{t('story.status.freePages')}</dt>
        <dd>{machine('3.1 GB')}</dd>
      </dl>
      <p className="gx-popover-footnote">{t('story.status.source')}</p>
    </>
  )
}

const meta = {
  title: 'Patterns/StatusItem',
  component: StatusItem,
  args: { icon: 'keep-awake', label: msg('story.switch.label') },
} satisfies StoryMeta<StatusItemProps>

export default meta

export const DefaultState: Story<StatusItemProps> = { name: 'default' }

export const ValueState: Story<StatusItemProps> = {
  name: 'value',
  args: { icon: 'memory-unified', label: msg('story.status.memory'), value: machine('16.8 GB'), title: msg('story.status.memoryTitle') },
  render: (args) => <StatusItem {...args}><MemoryFacts /></StatusItem>,
}

export const UnknownState: Story<StatusItemProps> = {
  name: 'unknown',
  args: { icon: 'quota', label: msg('story.status.quota'), tone: 'unknown' },
}

export const WarningState: Story<StatusItemProps> = {
  name: 'warning',
  args: { icon: 'battery-low', label: msg('story.status.power'), tone: 'warning', badge: true },
}

export const BadgeState: Story<StatusItemProps> = {
  name: 'badge',
  args: { icon: 'inbox', label: msg('story.status.inbox'), badge: 3 },
}

export const OpenState: Story<StatusItemProps> = {
  name: 'open',
  parameters: { guanxi: { frame: 'floating' } },
  args: { icon: 'memory-unified', label: msg('story.status.memory'), value: machine('16.8 GB'), title: msg('story.status.memoryTitle'), open: true },
  render: (args) => <StatusItem {...args}><MemoryFacts /></StatusItem>,
}
