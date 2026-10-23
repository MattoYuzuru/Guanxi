import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { importLocalProviderKeys } from '@guanxi/server'

export async function connectionsImport(args: string[], run = importLocalProviderKeys) {
  try {
    let file: string | undefined
    let dataDir = process.env.GUANXI_DATA_DIR ?? resolve(homedir(), '.guanxi')
    let json = false
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]
      if (arg === '--json') json = true
      else if ((arg === '--file' || arg === '--data-dir') && args[index + 1]) {
        if (arg === '--file') file = resolve(args[++index]!)
        else dataDir = resolve(args[++index]!)
      } else throw new Error('invalid_arguments')
    }
    if (!file) throw new Error('invalid_arguments')
    return { ok: true as const, json, ...await run(dataDir, file) }
  } catch { return { ok: false as const, error: 'provider_key_import_failed' } }
}
