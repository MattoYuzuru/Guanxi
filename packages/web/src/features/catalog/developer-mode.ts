/**
 * Developer mode (D-137): a per-browser switch that reveals Settings → Developer, including
 * the component catalog. It is a view preference, not a permission; it unlocks no writes.
 */
import { useCallback, useSyncExternalStore } from 'react'
import { PRODUCT_FILE_PREFIX } from '../../lib/brand.ts'

export const DEVELOPER_MODE_KEY = `${PRODUCT_FILE_PREFIX}.developerMode`
const CHANGE_EVENT = `${PRODUCT_FILE_PREFIX}:developer-mode`

/** The page-local value, used when storage is unavailable (private mode, blocked site data). */
let pageValue = false

export function readDeveloperMode(): boolean {
  try {
    return localStorage.getItem(DEVELOPER_MODE_KEY) === 'on'
  } catch {
    return pageValue
  }
}

export function writeDeveloperMode(on: boolean): void {
  pageValue = on
  try {
    if (on) localStorage.setItem(DEVELOPER_MODE_KEY, 'on')
    else localStorage.removeItem(DEVELOPER_MODE_KEY)
  } catch {
    // Storage is unavailable: the switch lasts for this page only (pageValue).
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === DEVELOPER_MODE_KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(CHANGE_EVENT, listener)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(CHANGE_EVENT, listener)
  }
}

export function useDeveloperMode(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, readDeveloperMode, () => false)
  return [on, useCallback((next: boolean) => writeDeveloperMode(next), [])]
}
