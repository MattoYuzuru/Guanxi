import { useUiText } from '../../i18n/context.tsx'
import type { Story, StoryMeta } from '../../story-kit/index.tsx'
import { Button } from '../button/button.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
  type DialogProps,
} from './dialog.tsx'

/*
 * The catalog renders several states side by side, so stories open the dialog non-modally
 * and without moving focus; the backdrop and popup are contained by the story frame. Product
 * code keeps the default modal behaviour (focus trap, inert outside, Escape closes).
 */
function ConfirmStory({ open }: { open?: boolean }) {
  const t = useUiText()
  return (
    <Dialog open={open} modal={false}>
      <DialogTrigger render={<Button variant="danger" size="sm" />}>
        {t('story.dialog.trigger')}
      </DialogTrigger>
      <DialogContent initialFocus={false} finalFocus={false}>
        <DialogTitle>{t('story.dialog.title')}</DialogTitle>
        <DialogDescription>{t('story.dialog.description')}</DialogDescription>
        <DialogFooter>
          <DialogClose render={<Button variant="secondary" />}>{t('story.dialog.cancel')}</DialogClose>
          <Button variant="danger">{t('story.dialog.confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function InfoStory() {
  const t = useUiText()
  return (
    <Dialog open modal={false}>
      <DialogContent initialFocus={false} finalFocus={false}>
        <DialogTitle>{t('story.dialog.infoTitle')}</DialogTitle>
        <DialogDescription>{t('story.dialog.infoBody')}</DialogDescription>
      </DialogContent>
    </Dialog>
  )
}

const meta = {
  title: 'Primitives/Dialog',
  component: Dialog,
  parameters: { guanxi: { frame: 'overlay' } },
} satisfies StoryMeta<DialogProps>

export default meta

export const Closed: Story<DialogProps> = { name: 'closed', render: () => <ConfirmStory /> }

export const Open: Story<DialogProps> = { name: 'open', render: () => <InfoStory /> }

export const Destructive: Story<DialogProps> = {
  name: 'destructive',
  render: () => <ConfirmStory open />,
}
