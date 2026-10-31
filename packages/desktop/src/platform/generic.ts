import type { MenuItemConstructorOptions } from 'electron'
import type { MenuContext, PlatformAdapter } from './types.ts'

/**
 * Every platform without a dedicated adapter. Until U6 adds `linux.ts` (rpm, AppImage, tray) this is what a
 * Linux checkout runs: the last window closing quits the shell, and the service keeps running either way.
 */
export const generic: PlatformAdapter = {
  id: 'generic',
  quitWhenAllWindowsClosed: true,
  reopenOnActivate: false,
  menuTemplate(context: MenuContext): MenuItemConstructorOptions[] {
    const view: MenuItemConstructorOptions[] = [
      { label: context.label('menu.reconnect'), accelerator: 'CmdOrCtrl+R', click: () => context.reconnect() },
      { label: context.label('menu.stopService'), click: () => context.stopService() },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ]
    if (context.developerTools) view.push({ type: 'separator' }, { role: 'toggleDevTools' })
    return [
      { label: context.product, submenu: [{ role: 'quit', label: context.label('menu.quit') }] },
      { role: 'editMenu' },
      { label: context.label('menu.view'), submenu: view },
      { label: context.label('menu.window'), role: 'windowMenu' },
    ]
  },
}
