import { msg, type Story, type StoryMeta } from '../../story-kit/index.tsx'
import { WorkspaceChrome, type WorkspaceChromeProps } from './workspace-chrome.tsx'

const meta = { title: 'Patterns/WorkspaceChrome', component: WorkspaceChrome,
  args: { kind: 'pane', id: 'core.context', title: msg('story.empty.title'), moveLabel: msg('story.empty.action'), hideLabel: msg('story.empty.action'), onMove() {}, onHide() {} },
} satisfies StoryMeta<WorkspaceChromeProps>
export default meta
export const Default: Story<WorkspaceChromeProps> = { name: 'default' }
export const Empty: Story<WorkspaceChromeProps> = { name: 'empty', args: { description: msg('story.empty.title') } }
export const Placeholder: Story<WorkspaceChromeProps> = { name: 'placeholder', args: { description: msg('ui.provenance.unknown') } }
export const Error: Story<WorkspaceChromeProps> = { name: 'error', args: { kind: 'state', title: msg('story.error.title'), error: true } }
export const Phone: Story<WorkspaceChromeProps> = { name: 'phone', args: { kind: 'phone', label: msg('story.tabs.label'), blocks: [{ id: 'chat', label: msg('story.empty.title') }], selected: 'chat', onSelect() {} } }
