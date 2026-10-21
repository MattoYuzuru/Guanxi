import { GitBranch, MessagesSquare, Settings, Waypoints } from 'lucide-react'
import type { ReactNode } from 'react'
import { useUiText } from '../../i18n/context.tsx'
import { machine, msg, type Story, type StoryMeta } from '../../story-kit/index.tsx'
import { Button } from '../button/button.tsx'
import { EmptyState } from '../empty-state/empty-state.tsx'
import { ErrorState } from '../error-state/error-state.tsx'
import { IconButton } from '../icon-button/icon-button.tsx'
import { StatusPill } from '../status-pill/status-pill.tsx'
import { AppShellChrome, type AppShellChromeProps } from './app-shell-chrome.tsx'

type HostState = 'default' | 'loading' | 'error' | 'offline' | 'unknown'

function StorySidebar({ compact = false }: { compact?: boolean }) {
  const t = useUiText()
  const items = [
    { key: 'story.tabs.chat' as const, icon: <MessagesSquare /> },
    { key: 'story.tabs.trace' as const, icon: <Waypoints /> },
    { key: 'story.tabs.changes' as const, icon: <GitBranch /> },
    { key: 'story.iconButton.settings' as const, icon: <Settings /> },
  ]
  if (compact) {
    return (
      <div>
        {items.map((item) => (
          <div key={item.key}>
            <IconButton label={t(item.key)} icon={item.icon} size="sm" />
          </div>
        ))}
      </div>
    )
  }
  return (
    <nav aria-label={t('story.workspace.blocks')}>
      {items.map((item) => (
        <div key={item.key}>
          <Button variant="ghost">{t(item.key)}</Button>
        </div>
      ))}
    </nav>
  )
}

function StoryStatus({ state = 'default' }: { state?: HostState }) {
  const t = useUiText()
  if (state === 'loading') {
    return (
      <>
        <StatusPill status="running" />
        <span>{t('story.tabs.chatPanel')}</span>
      </>
    )
  }
  if (state === 'error') return <StatusPill status="error" />
  if (state === 'offline' || state === 'unknown') return <StatusPill status="unknown" />
  return <span>{t('story.workspace.blocks')}</span>
}

function StoryMain({ state = 'default' }: { state?: HostState }) {
  const t = useUiText()
  if (state === 'error') {
    return (
      <ErrorState
        title={t('story.workspace.error')}
        source={machine('node')}
        occurredAt="2026-10-20T14:02:11.000Z"
      />
    )
  }
  if (state === 'offline') return <EmptyState title={t('story.workspace.placeholder')} />
  if (state === 'unknown') return <EmptyState title={t('story.workspace.empty')} />
  return (
    <div aria-busy={state === 'loading' || undefined}>
      <p>{t('story.tabs.chatPanel')}</p>
    </div>
  )
}

function StoryShell({ width, children }: { width: 'desktop' | 'phone'; children: ReactNode }) {
  const size = width === 'phone' ? 'var(--layout-container-sm)' : 'var(--layout-container-2xl)'
  return <div style={{ width: size }}>{children}</div>
}

const labels: AppShellChromeProps['labels'] = {
  show: 'Show sidebar',
  collapse: 'Collapse to rail',
  expand: 'Expand sidebar',
  hide: 'Hide sidebar',
  moveLeft: 'Move sidebar left',
  moveRight: 'Move sidebar right',
  palette: 'Command palette',
}

const args = {
  side: 'left',
  visibility: 'expanded',
  sidebar: <StorySidebar />,
  status: <StoryStatus />,
  sidebarLabel: msg('story.workspace.blocks'),
  labels,
  onSide() {},
  onVisibility() {},
  onOpenPalette() {},
  children: <StoryMain />,
} satisfies Partial<AppShellChromeProps>

const meta = {
  title: 'Patterns/AppShellChrome',
  component: AppShellChrome,
  args,
} satisfies StoryMeta<AppShellChromeProps>

export default meta

export const Default: Story<AppShellChromeProps> = {
  name: 'default',
  render: (props) => (
    <StoryShell width="desktop">
      <AppShellChrome {...props} />
    </StoryShell>
  ),
}

export const Rail: Story<AppShellChromeProps> = {
  name: 'rail',
  args: { visibility: 'rail', sidebar: <StorySidebar compact /> },
  render: (props) => (
    <StoryShell width="desktop">
      <AppShellChrome {...props} />
    </StoryShell>
  ),
}

export const Hidden: Story<AppShellChromeProps> = {
  name: 'hidden',
  args: { visibility: 'hidden' },
  render: (props) => (
    <StoryShell width="desktop">
      <AppShellChrome {...props} />
    </StoryShell>
  ),
}

export const Right: Story<AppShellChromeProps> = {
  name: 'right',
  args: { side: 'right' },
  render: (props) => (
    <StoryShell width="desktop">
      <AppShellChrome {...props} />
    </StoryShell>
  ),
}

export const Phone: Story<AppShellChromeProps> = {
  name: 'phone',
  render: (props) => (
    <StoryShell width="phone">
      <AppShellChrome {...props} />
    </StoryShell>
  ),
}

export const Loading: Story<AppShellChromeProps> = {
  name: 'loading',
  args: { status: <StoryStatus state="loading" />, children: <StoryMain state="loading" /> },
  render: (props) => (
    <StoryShell width="desktop">
      <AppShellChrome {...props} />
    </StoryShell>
  ),
}

export const ErrorStory: Story<AppShellChromeProps> = {
  name: 'error',
  args: { status: <StoryStatus state="error" />, children: <StoryMain state="error" /> },
  render: (props) => (
    <StoryShell width="desktop">
      <AppShellChrome {...props} />
    </StoryShell>
  ),
}

export const Offline: Story<AppShellChromeProps> = {
  name: 'offline',
  args: { status: <StoryStatus state="offline" />, children: <StoryMain state="offline" /> },
  render: (props) => (
    <StoryShell width="desktop">
      <AppShellChrome {...props} />
    </StoryShell>
  ),
}

export const Unknown: Story<AppShellChromeProps> = {
  name: 'unknown',
  args: { status: <StoryStatus state="unknown" />, children: <StoryMain state="unknown" /> },
  render: (props) => (
    <StoryShell width="desktop">
      <AppShellChrome {...props} />
    </StoryShell>
  ),
}
