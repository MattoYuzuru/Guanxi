import { useUiText } from '../../i18n/context.tsx'
import type { Story, StoryMeta } from '../../story-kit/index.tsx'
import { Button } from '../button/button.tsx'
import { Tooltip, TooltipContent, TooltipTrigger, type TooltipProps } from './tooltip.tsx'

function TooltipStory({ open }: { open?: boolean }) {
  const t = useUiText()
  return (
    <Tooltip open={open}>
      <TooltipTrigger render={<Button variant="secondary" size="sm" />}>
        {t('story.tooltip.trigger')}
      </TooltipTrigger>
      <TooltipContent>{t('story.tooltip.content')}</TooltipContent>
    </Tooltip>
  )
}

const meta = {
  title: 'Primitives/Tooltip',
  component: Tooltip,
  parameters: { guanxi: { frame: 'floating' } },
} satisfies StoryMeta<TooltipProps>

export default meta

export const Closed: Story<TooltipProps> = {
  name: 'closed',
  render: () => <TooltipStory />,
}

export const Open: Story<TooltipProps> = {
  name: 'open',
  render: () => <TooltipStory open />,
}
