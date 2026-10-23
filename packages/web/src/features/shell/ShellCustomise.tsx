import { Icon, IconButton, Popover, PopoverContent, PopoverTitle, PopoverTrigger, SegmentedControl, Switch } from '@guanxi/ui'
import type { ReactNode } from 'react'
import { useAppearance } from '../../lib/appearance.tsx'
import { translate as t } from '../../lib/locale.ts'
import { useTheme } from '../../lib/theme.tsx'
import type { ShellPreferences } from './preferences.ts'

/**
 * The borderless customisation area of the chrome (D-204): density, sidebar placement and width,
 * system theme, motion and the max graphics tier, as icon segments and switches in one popover.
 * It replaces the Developer/Visual chip row; nothing here changes what the product can do.
 */
export function ShellCustomise({ preferences, onPreferences }: {
  preferences: ShellPreferences
  onPreferences: (update: (previous: ShellPreferences) => ShellPreferences) => void
}) {
  const appearance = useAppearance()
  const { preference, resolved, setPreference } = useTheme()
  return <Popover>
    <PopoverTrigger render={<IconButton label={t('shell.customise')} icon={<Icon name="customise" />} />} />
    <PopoverContent align="end" className="w-xs" data-testid="shell-customise">
      <PopoverTitle>{t('shell.customise')}</PopoverTitle>
      <div className="flex flex-col gap-3 pt-1">
        <Row label={t('shell.customise.density')}>
          <SegmentedControl label={t('shell.customise.density')} iconOnly value={appearance.density}
            onValueChange={density => appearance.update({ density })}
            options={[{ value: 'compact', label: t('shell.customise.compact'), icon: 'density-compact' },
              { value: 'comfortable', label: t('shell.customise.comfortable'), icon: 'density-comfortable' }]} />
        </Row>
        <Row label={t('shell.customise.sidebar')}>
          <div className="flex flex-wrap items-center gap-1">
            <SegmentedControl label={t('shell.customise.sidebarSide')} iconOnly value={preferences.side}
              onValueChange={side => onPreferences(previous => ({ ...previous, side }))}
              options={[{ value: 'left', label: t('shell.customise.sidebarLeft'), icon: 'sidebar' },
                { value: 'right', label: t('shell.customise.sidebarRight'), icon: 'sidebar-right' }]} />
            <SegmentedControl label={t('shell.customise.sidebarVisibility')} iconOnly value={preferences.visibility}
              onValueChange={visibility => onPreferences(previous => ({ ...previous, visibility }))}
              options={[{ value: 'expanded', label: t('shell.customise.sidebarExpanded'), icon: 'layout' },
                { value: 'rail', label: t('shell.customise.sidebarRail'), icon: 'layers' },
                { value: 'hidden', label: t('shell.customise.sidebarHidden'), icon: 'hide' }]} />
          </div>
        </Row>
        <Row label={t('shell.customise.motion')}>
          <SegmentedControl label={t('shell.customise.motion')} value={appearance.motion}
            onValueChange={motion => appearance.update({ motion })}
            options={[{ value: 'system', label: t('shell.customise.motionSystem') },
              { value: 'reduced', label: t('shell.customise.motionReduced') },
              { value: 'full', label: t('shell.customise.motionFull') }]} />
        </Row>
        <div className="flex flex-col gap-2 border-t border-hairline pt-3">
          <Switch label={t('shell.customise.theme')} checked={preference === 'system'}
            onCheckedChange={checked => setPreference(checked ? 'system' : resolved)} />
          <Switch label={t('shell.customise.graphics')} checked={appearance.graphics === 'max'}
            onCheckedChange={checked => appearance.update({ graphics: checked ? 'max' : 'static' })} aria-describedby="shell-graphics-hint" />
          <p id="shell-graphics-hint" className="m-0 text-12 text-muted">{t('shell.customise.graphicsHint')}</p>
        </div>
      </div>
    </PopoverContent>
  </Popover>
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-2">
    <span className="text-12 font-label text-secondary">{label}</span>
    {children}
  </div>
}

/** D-205: one icon button swaps light and dark; the icon shows the theme it switches to. */
export function ShellThemeToggle() {
  const { resolved, toggle } = useTheme()
  const toDark = resolved === 'light'
  return <IconButton label={t(toDark ? 'shell.theme.toDark' : 'shell.theme.toLight')} data-testid="shell-theme-toggle"
    icon={<Icon name={toDark ? 'theme-dark' : 'theme-light'} />} onClick={toggle} />
}
