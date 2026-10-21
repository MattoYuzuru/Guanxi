import { useUiText } from '../../i18n/context.tsx'
import { machine, msg, type Story, type StoryMeta } from '../../story-kit/index.tsx'
import { Button } from '../button/button.tsx'
import { ErrorState, type ErrorStateProps } from './error-state.tsx'

function RetryAction({ loading = false }: { loading?: boolean }) {
  const t = useUiText()
  return (
    <Button variant="secondary" size="sm" loading={loading} loadingLabel={t('story.error.retrying')}>
      {t('story.error.retry')}
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
    action: <RetryAction />,
    details: machine('ECONNREFUSED 127.0.0.1:11434 (GET /api/tags, 3 attempts)'),
  },
} satisfies StoryMeta<ErrorStateProps>

export default meta

export const Default: Story<ErrorStateProps> = { name: 'default' }

export const WithDetails: Story<ErrorStateProps> = {
  name: 'with-details',
  args: { detailsOpen: true },
}

export const Retrying: Story<ErrorStateProps> = {
  name: 'retrying',
  args: { action: <RetryAction loading /> },
}
