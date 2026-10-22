import { msg, type Story, type StoryMeta } from '../../story-kit/index.tsx'
import { WorkspaceChrome, type WorkspaceChromeProps } from './workspace-chrome.tsx'

const meta = { title: 'Patterns/WorkspaceChrome', component: WorkspaceChrome,
  args: { kind: 'pane', id: 'core.context', title: msg('story.workspace.title'), moveLabel: msg('story.workspace.move'), hideLabel: msg('story.workspace.hide'), onMove() {}, onHide() {} },
} satisfies StoryMeta<WorkspaceChromeProps>
export default meta
export const Default: Story<WorkspaceChromeProps> = { name: 'default' }
export const Empty: Story<WorkspaceChromeProps> = { name: 'empty', args: { description: msg('story.workspace.empty') } }
export const Placeholder: Story<WorkspaceChromeProps> = { name: 'placeholder', args: { description: msg('story.workspace.placeholder') } }
export const Error: Story<WorkspaceChromeProps> = { name: 'error', args: { kind: 'state', title: msg('story.workspace.error'), error: true } }
export const Phone: Story<WorkspaceChromeProps> = { name: 'phone', args: { kind: 'phone', label: msg('story.workspace.blocks'), blocks: [{ id: 'chat', label: msg('story.workspace.title') }], selected: 'chat', onSelect() {} }, render: args => <><WorkspaceChrome {...args} /><div id="phone-chat" role="tabpanel" aria-labelledby="tab-chat" /></> }

export const Draft: Story<WorkspaceChromeProps> = { name: 'draft', args: { draft: { label: msg('story.workspace.draft'), value: '', onChange() {} } } }
export const Toolbar: Story<WorkspaceChromeProps> = { name: 'toolbar', args: { kind: 'toolbar', label: msg('story.workspace.blocks'), fields: [], name: { label: msg('story.workspace.name'), value: '', onChange() {} }, actions: [{ label: msg('story.workspace.save'), onClick() {} }] } }
export const Mover: Story<WorkspaceChromeProps> = { name: 'mover', parameters: { guanxi: { frame: 'overlay' } }, args: { kind: 'mover', modal: false, open: true, title: msg('story.workspace.move'), description: msg('story.workspace.blocks'), blockLabel: msg('story.workspace.title'), zoneLabel: msg('story.workspace.destination'), cancelLabel: msg('story.workspace.cancel'), moveLabel: msg('story.workspace.move'), blocks: [{ id: 'context', label: msg('story.workspace.title') }], zones: [{ id: 'right', label: msg('story.workspace.right') }], block: 'context', zone: 'right', onBlock() {}, onZone() {}, onClose() {}, onMove() {} } }
