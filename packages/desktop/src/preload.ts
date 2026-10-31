import { contextBridge, ipcRenderer } from 'electron'
import { BRIDGE_NAME, INFO_CHANNEL } from './ipc.ts'
import type { DesktopInfo } from './ipc.ts'

// Sandboxed preload (bundled as CommonJS): the only thing the page gets is this read-only function.
// No ipcRenderer, no generic send/invoke, no file or process access.
contextBridge.exposeInMainWorld(BRIDGE_NAME, {
  info: (): Promise<DesktopInfo> => ipcRenderer.invoke(INFO_CHANNEL),
})
