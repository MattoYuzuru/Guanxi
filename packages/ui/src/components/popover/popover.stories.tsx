import { useUiText } from '../../i18n/context.tsx'
import type { Story, StoryMeta } from '../../story-kit/index.tsx'
import { Button } from '../button/button.tsx'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
  type PopoverProps,
} from './popover.tsx'

function PopoverStory({ open }: { open?: boolean }) {
  const t = useUiText()
  return (
    <Popover open={open} modal={false}>
      <PopoverTrigger render={<Button variant="secondary" size="sm" />}>
        {t('story.popover.trigger')}
      </PopoverTrigger>
      <PopoverContent initialFocus={false} finalFocus={false}>
        <PopoverTitle>{t('story.popover.title')}</PopoverTitle>
        <PopoverDescription>{t('story.popover.description')}</PopoverDescription>
      </PopoverContent>
    </Popover>
  )
}

const meta = {
  title: 'Primitives/Popover',
  component: Popover,
  parameters: { guanxi: { frame: 'floating' } },
} satisfies StoryMeta<PopoverProps>

export default meta

export const Closed: Story<PopoverProps> = { name: 'closed', render: () => <PopoverStory /> }

export const Open: Story<PopoverProps> = { name: 'open', render: () => <PopoverStory open /> }
