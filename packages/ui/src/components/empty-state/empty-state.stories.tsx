import { MessagesSquare } from 'lucide-react'
import { useUiText } from '../../i18n/context.tsx'
import { msg, type Story, type StoryMeta } from '../../story-kit/index.tsx'
import { Button } from '../button/button.tsx'
import { EmptyState, type EmptyStateProps } from './empty-state.tsx'

function NewSessionAction() {
  const t = useUiText()
  return <Button variant="primary">{t('story.empty.action')}</Button>
}

const meta = {
  title: 'Patterns/EmptyState',
  component: EmptyState,
  args: {
    title: msg('story.empty.title'),
    icon: <MessagesSquare />,
    action: <NewSessionAction />,
  },
} satisfies StoryMeta<EmptyStateProps>

export default meta

export const Default: Story<EmptyStateProps> = { name: 'default' }
