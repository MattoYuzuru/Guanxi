import { useUiText } from '../../i18n/context.tsx'
import { machine, msg, type Story, type StoryMeta } from '../../story-kit/index.tsx'
import { Button } from '../button/button.tsx'
import { ErrorState, type ErrorStateProps } from './error-state.tsx'

function StartAction({ loading = false }: { loading?: boolean }) {
  const t = useUiText()
  return (
    <Button variant="secondary" size="sm" loading={loading} loadingLabel={t('story.error.acting')}>
      {t('story.error.action')}
    </Button>
  )
}

const meta = {
  title: 'Patterns/ErrorState',
  component: ErrorState,
  args: {
    title: msg('story.error.title'),
    source: machine('ollama http://127.0.0.1:11434/api/tags'),
    occurredAt: '2026-10-20T14:02:11.000Z',
    action: <StartAction />,
    details: machine('ECONNREFUSED 127.0.0.1:11434 (GET /api/tags, 3 attempts)'),
  },
} satisfies StoryMeta<ErrorStateProps>

export default meta

export const Default: Story<ErrorStateProps> = { name: 'default' }

export const WithDetails: Story<ErrorStateProps> = {
  name: 'with-details',
  args: { detailsOpen: true },
}

export const Acting: Story<ErrorStateProps> = {
  name: 'acting',
  args: { action: <StartAction loading /> },
}
