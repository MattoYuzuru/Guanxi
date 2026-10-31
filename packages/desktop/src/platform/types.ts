import type { MenuItemConstructorOptions } from 'electron'
import type { MessageKey } from '../messages.ts'

export interface MenuContext {
  product: string
  /** Localized label by catalogue key. */
  label(key: MessageKey): string
  reconnect(): void
  stopService(): void
  /** Developer tools menu entries: only in an unpackaged app. */
  developerTools: boolean
}

/**
 * Everything that differs per operating system lives behind this interface (D-221: macOS now, Fedora in
 * U6, Windows last). Handshake, security policy, messages and windows are platform-neutral.
 */
export interface PlatformAdapter {
  readonly id: 'darwin' | 'generic'
  /** macOS keeps the app alive without windows (dock); elsewhere the last window closing quits the shell. */
  readonly quitWhenAllWindowsClosed: boolean
  /** Dock icon click with no window opens one again. */
  readonly reopenOnActivate: boolean
  menuTemplate(context: MenuContext): MenuItemConstructorOptions[]
}
