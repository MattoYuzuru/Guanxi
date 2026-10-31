import { PRODUCT_FILE_PREFIX } from '@guanxi/contract/brand'

/** The one channel between the sandboxed renderer and the main process. Adding a channel is a security review item. */
export const INFO_CHANNEL = `${PRODUCT_FILE_PREFIX}:desktop:info`
/** The name of the object the preload exposes to the page (`guanxiDesktop`). */
export const BRIDGE_NAME = `${PRODUCT_FILE_PREFIX}Desktop`

export interface DesktopInfo {
  shell: 'electron'
  platform: string
  shellVersion: string
}
