import { stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Settings files the vendor CLI reads on its own (user, project and local scope) and whose `env` or `permissions` could redirect a credential
 * or relax the deny-all permission policy. Only their existence is checked: the contents are never opened. */
export async function vendorSettingsPresent(configDirectory: string): Promise<boolean> {
  const places = [['config', 'settings.json'], ['config', 'settings.local.json'], ['work', '.claude', 'settings.json'], ['work', '.claude', 'settings.local.json'],
    ['home', '.claude', 'settings.json'], ['home', '.claude', 'settings.local.json']]
  for (const place of places) {
    try { await stat(join(configDirectory, ...place)); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') return true
    }
  }
  return false
}

