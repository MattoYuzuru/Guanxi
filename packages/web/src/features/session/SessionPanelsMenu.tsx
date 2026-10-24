import { useCallback, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import {
  Button, Dialog, DialogContent, DialogFooter, DialogTitle, Icon, IconButton, Input, Menu, MenuCheckboxItem, MenuContent,
  MenuGroup, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, PortalContainerProvider, type IconName,
} from '@guanxi/ui'
import { translate as t } from '../../lib/locale.ts'
import { navigate } from '../../lib/router.tsx'
import type { WorkspaceLayoutControls } from '../workspace/controls.ts'
import { blockPanel, sessionPanelIcon, sessionPanelNames, type SessionPanel } from './panels.ts'

function panelIconOf(id: string): IconName {
  const panel = blockPanel(id)
  return panel ? sessionPanelIcon[panel] : id.endsWith('/chat') ? 'chat' : 'layers'
}

export interface SessionPanelsMenuProps {
  /** Panels beside the full-width timeline (the default session view). */
  panels?: { open: readonly SessionPanel[]; toggle: (panel: SessionPanel, open: boolean) => void }
  /** The free arrangement's layout actions, when the session sits in the docking workspace. */
  layout?: WorkspaceLayoutControls | null
  /** Where "Arrange panels freely" goes from the default view. */
  arrangePath?: string
  /** The workspace's own bar, shown while no session header carries the menu. */
  fallback?: boolean
}

/**
 * The session header's one panels menu (round 4, the `1.png` pattern): checkable panel rows with
 * icons, then — in the free arrangement — the layout settings and actions that used to be a row of
 * bordered buttons. Every action stays reachable from the keyboard and keeps its label.
 */
export function SessionPanelsMenu({ panels, layout, arrangePath, fallback = false }: SessionPanelsMenuProps) {
  const register = layout?.registerMenu
  // Registered before paint, so the workspace's fallback bar never flashes beside a session header.
  useLayoutEffect(() => (fallback ? undefined : register?.()), [fallback, register])
  const [naming, setNaming] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const [triggerDocument, setTriggerDocument] = useState<Document | null>(null)
  // A stable ref callback: it runs on mount and unmount only, not on every render (review P3).
  const triggerRef = useCallback((node: HTMLButtonElement | null) => { trigger.current = node; if (node) setTriggerDocument(node.ownerDocument) }, [])
  // A pane host sits inside the docking engine's stacking contexts: the menu mounts on the body of
  // the trigger's own document (the main window, or a popout), above every docked pane. The
  // document is read again on open, since a pane can move between windows without remounting.
  const portal = triggerDocument?.body ?? null
  const busy = layout?.busy ?? false
  const rows = layout
    ? layout.blocks.map(block => ({ id: block.id, label: block.label, icon: panelIconOf(block.id), checked: !block.hidden,
      onChange: (next: boolean) => layout.setVisible(block.id, next) }))
    : sessionPanelNames.map(panel => ({ id: panel, label: t(`workspaceLayout.block.${panel}`), icon: sessionPanelIcon[panel], checked: panels?.open.includes(panel) ?? false,
      onChange: (next: boolean) => panels?.toggle(panel, next) }))
  const menu = <>
    <Menu modal={false} onOpenChange={() => setTriggerDocument(trigger.current?.ownerDocument ?? null)}>
      <MenuTrigger ref={triggerRef} render={<IconButton label={t('session.panels.menu')} icon={<Icon name="panels" />} />} />
      <MenuContent align="end" data-testid="session-panels-menu">
        <MenuGroup>
          <MenuGroupLabel>{t('session.panels.group')}</MenuGroupLabel>
          {/* A panel row closes the menu: the panel opens where the menu was (on a phone, as a sheet). */}
          {rows.map(row => <MenuCheckboxItem key={row.id} icon={<Icon name={row.icon} />} checked={row.checked} disabled={busy} closeOnClick
            onCheckedChange={row.onChange}>{row.label}</MenuCheckboxItem>)}
          {layout?.addable.map(entry => <MenuItem key={entry.id} disabled={busy} onClick={() => layout.add(entry.id)}>
            <Icon name="plus" />{entry.label}</MenuItem>)}
        </MenuGroup>
        <MenuSeparator />
        {layout ? <>
          <MenuGroup>
            <MenuGroupLabel>{t('session.layout.group')}</MenuGroupLabel>
            <MenuCheckboxItem indicator="switch" icon={<Icon name="density-compact" />} description={t('session.layout.compactHint')}
              checked={layout.density === 'compact'} disabled={busy} onCheckedChange={next => layout.setDensity(next ? 'compact' : 'comfortable')}>
              {t('session.layout.compact')}
            </MenuCheckboxItem>
          </MenuGroup>
          <MenuGroup>
            <MenuGroupLabel>{t('session.layout.scope')}</MenuGroupLabel>
            <MenuRadioGroup value={layout.scope} onValueChange={value => layout.setScope(String(value))} disabled={busy}>
              {layout.scopes.map(scope => <MenuRadioItem key={scope.id} value={scope.id} closeOnClick={false}
                icon={<Icon name={scope.id.includes('device') ? 'device-laptop' : scope.id === 'project' ? 'projects' : 'user'} />}>{scope.label}</MenuRadioItem>)}
            </MenuRadioGroup>
          </MenuGroup>
          {layout.layouts.length > 1 && <MenuGroup>
            <MenuGroupLabel>{t('session.layout.named')}</MenuGroupLabel>
            <MenuRadioGroup value={layout.layout} onValueChange={value => layout.activate(String(value))} disabled={busy}>
              {layout.layouts.map(entry => <MenuRadioItem key={entry.id} value={entry.id} closeOnClick icon={<Icon name="layout" />}>{entry.label}</MenuRadioItem>)}
            </MenuRadioGroup>
          </MenuGroup>}
          <MenuSeparator />
          <MenuItem disabled={busy} onClick={layout.save}><Icon name="save" />{t('workspaceLayout.save')}</MenuItem>
          <MenuItem disabled={busy} onClick={() => setNaming(true)}><Icon name="save-as" />{t('session.layout.saveAs')}</MenuItem>
          <MenuItem disabled={busy || layout.phone} onClick={layout.move}><Icon name="move" />{t('session.layout.move')}</MenuItem>
          <MenuItem disabled={busy} onClick={layout.reset}><Icon name="reset" />{t('workspaceLayout.reset')}</MenuItem>
        </> : arrangePath ? <MenuItem onClick={() => navigate(arrangePath)}><Icon name="layout" />{t('session.layout.arrange')}</MenuItem> : null}
      </MenuContent>
    </Menu>
    {layout && <SaveAsDialog key={naming ? 'naming' : 'idle'} open={naming} initial={layout.name} onClose={() => { setNaming(false); requestAnimationFrame(() => trigger.current?.focus()) }}
      onSave={name => { setNaming(false); layout.saveAs(name); requestAnimationFrame(() => trigger.current?.focus()) }} />}
  </>
  // The wrapper is always present in the free arrangement, so the tree (and an open menu) never remounts.
  return layout ? <PortalContainerProvider container={portal}>{menu}</PortalContainerProvider> : menu
}

function SaveAsDialog({ open, initial, onClose, onSave }: { open: boolean; initial: string; onClose: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState(initial)
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(name.trim() || initial) }
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
    <DialogContent>
      <DialogTitle>{t('session.layout.saveAsTitle')}</DialogTitle>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-12">
          <span className="text-secondary">{t('workspaceLayout.layout')}</span>
          <Input value={name} onChange={event => setName(event.target.value)} autoFocus />
        </label>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>{t('workspaceLayout.cancel')}</Button>
          <Button type="submit">{t('session.layout.saveAsConfirm')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
