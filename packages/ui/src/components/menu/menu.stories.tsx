import { Copy, Download, Pencil, Trash2 } from 'lucide-react'
import { useUiText } from '../../i18n/context.tsx'
import type { Story, StoryMeta } from '../../story-kit/index.tsx'
import { Button } from '../button/button.tsx'
import {
  Menu,
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

const meta = {
  title: 'Primitives/Menu',
  component: Menu,
  parameters: { guanxi: { frame: 'floating' } },
} satisfies StoryMeta<MenuProps>

export default meta

export const Closed: Story<MenuProps> = { name: 'closed', render: () => <MenuStory /> }

export const Open: Story<MenuProps> = { name: 'open', render: () => <MenuStory open /> }
