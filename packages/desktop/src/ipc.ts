/** The one channel between the sandboxed renderer and the main process. Adding a channel is a security review item. */
export const INFO_CHANNEL = 'guanxi:desktop:info'
/** The name of the object the preload exposes to the page. */
export const BRIDGE_NAME = 'guanxiDesktop'

export interface DesktopInfo {
  shell: 'electron'
  platform: string
  shellVersion: string
}
