import { useUiText } from '../../i18n/context.tsx'
import type { Story, StoryMeta } from '../../story-kit/index.tsx'
import { Tabs, TabsList, TabsPanel, TabsTab, type TabsProps } from './tabs.tsx'

function TabsStory({ disableTrace = false }: { disableTrace?: boolean }) {
  const t = useUiText()
  return (
    <Tabs defaultValue="chat">
      <TabsList aria-label={t('story.tabs.label')}>
        <TabsTab value="chat">{t('story.tabs.chat')}</TabsTab>
        <TabsTab value="trace" disabled={disableTrace}>
          {t('story.tabs.trace')}
        </TabsTab>
        <TabsTab value="changes">{t('story.tabs.changes')}</TabsTab>
      </TabsList>
      <TabsPanel value="chat">{t('story.tabs.chatPanel')}</TabsPanel>
      <TabsPanel value="trace">{t('story.tabs.tracePanel')}</TabsPanel>
      <TabsPanel value="changes">{t('story.tabs.changesPanel')}</TabsPanel>
    </Tabs>
  )
}

const meta = { title: 'Primitives/Tabs', component: Tabs } satisfies StoryMeta<TabsProps>

export default meta

export const Default: Story<TabsProps> = { name: 'default', render: () => <TabsStory /> }

export const Hover: Story<TabsProps> = {
  name: 'hover',
  render: () => <TabsStory />,
  parameters: { guanxi: { force: 'hover' } },
}

export const FocusVisible: Story<TabsProps> = {
  name: 'focus-visible',
  render: () => <TabsStory />,
  parameters: { guanxi: { force: 'focus-visible' } },
}

export const DisabledTab: Story<TabsProps> = {
  name: 'disabled-tab',
  render: () => <TabsStory disableTrace />,
}
