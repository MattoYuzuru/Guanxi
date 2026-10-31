import type { MenuItemConstructorOptions } from 'electron'
import type { MenuContext, PlatformAdapter } from './types.ts'

function editMenu(): MenuItemConstructorOptions {
  return {
    role: 'editMenu',
  }
}

export const darwin: PlatformAdapter = {
  id: 'darwin',
  quitWhenAllWindowsClosed: false,
  reopenOnActivate: true,
  menuTemplate(context: MenuContext): MenuItemConstructorOptions[] {
    const view: MenuItemConstructorOptions[] = [
      { label: context.label('menu.reconnect'), accelerator: 'CmdOrCtrl+R', click: () => context.reconnect() },
      { label: context.label('menu.stopService'), click: () => context.stopService() },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ]
    if (context.developerTools) view.push({ type: 'separator' }, { role: 'toggleDevTools' })
    return [
      {
        label: context.product,
        submenu: [
          { role: 'about', label: context.label('menu.about') },
          { type: 'separator' },
          { role: 'hide', label: context.label('menu.hide') },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit', label: context.label('menu.quit') },
        ],
      },
      editMenu(),
      { label: context.label('menu.view'), submenu: view },
      { label: context.label('menu.window'), role: 'windowMenu' },
    ]
  },
}
