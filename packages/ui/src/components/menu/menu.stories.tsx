import { Copy, Download, Pencil, Trash2 } from 'lucide-react'
import { useUiText } from '../../i18n/context.tsx'
import type { Story, StoryMeta } from '../../story-kit/index.tsx'
import { useState } from 'react'
import { Button } from '../button/button.tsx'
import { Icon } from '../icon/icon.tsx'
import { IconButton } from '../icon-button/icon-button.tsx'
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  type MenuProps,
} from './menu.tsx'

function MenuStory({ open }: { open?: boolean }) {
  const t = useUiText()
  return (
    <Menu open={open} modal={false}>
      <MenuTrigger render={<Button variant="secondary" size="sm" />}>
        {t('story.menu.trigger')}
      </MenuTrigger>
      <MenuContent finalFocus={false}>
        <MenuGroup>
          <MenuGroupLabel>{t('story.menu.group')}</MenuGroupLabel>
          <MenuItem>
            <Pencil aria-hidden="true" />
            {t('story.menu.rename')}
          </MenuItem>
          <MenuItem>
            <Copy aria-hidden="true" />
            {t('story.menu.duplicate')}
          </MenuItem>
          <MenuItem disabled>
            <Download aria-hidden="true" />
            {t('story.menu.export')}
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem variant="danger">
          <Trash2 aria-hidden="true" />
          {t('story.menu.delete')}
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

/** The settings pattern (round 4): checkable panels with a trailing count, then an inline switch. */
function CheckableStory() {
  const t = useUiText()
  const [shown, setShown] = useState({ artifacts: true, terminal: false, tasks: true })
  const [awake, setAwake] = useState(true)
  return (
    <Menu open modal={false}>
      <MenuTrigger render={<IconButton label={t('story.menu.panels')} icon={<Icon name="more" />} />} />
      <MenuContent finalFocus={false} align="end">
        <MenuCheckboxItem icon={<Icon name="artifacts" />} checked={shown.artifacts} onCheckedChange={artifacts => setShown(s => ({ ...s, artifacts }))}>{t('story.menu.artifacts')}</MenuCheckboxItem>
        <MenuCheckboxItem icon={<Icon name="terminal" />} checked={shown.terminal} onCheckedChange={terminal => setShown(s => ({ ...s, terminal }))}>{t('story.menu.terminal')}</MenuCheckboxItem>
        <MenuCheckboxItem icon={<Icon name="processes" />} end="5" checked={shown.tasks} onCheckedChange={tasks => setShown(s => ({ ...s, tasks }))}>{t('story.menu.tasks')}</MenuCheckboxItem>
        <MenuSeparator />
        <MenuCheckboxItem indicator="switch" description={t('story.menu.awakeScope')} checked={awake} onCheckedChange={setAwake}>{t('story.menu.awake')}</MenuCheckboxItem>
      </MenuContent>
    </Menu>
  )
}

const meta = {
  title: 'Primitives/Menu',
  component: Menu,
  parameters: { guanxi: { frame: 'floating' } },
} satisfies StoryMeta<MenuProps>

export default meta

export const Closed: Story<MenuProps> = { name: 'closed', render: () => <MenuStory /> }

export const Open: Story<MenuProps> = { name: 'open', render: () => <MenuStory open /> }

export const Checkable: Story<MenuProps> = { name: 'checkable', render: () => <CheckableStory /> }
