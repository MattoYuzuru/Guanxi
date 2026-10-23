import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { connectionBaseUrlSchema, type Connection } from '@guanxi/contract'
import { assertApiKey } from './pi.ts'
import { ConnectionError } from './errors.ts'
import type { Connections } from './service.ts'

const keys = { OPENAI_API_KEY: 'openai', DEEPSEEK_API_KEY: 'deepseek', ANTHROPIC_API_KEY: 'anthropic',
  OPENROUTER_API_KEY: 'openrouter', GOOGLE_API_KEY: 'google' } as const
export interface ImportedProvider { provider: Connection['provider']; value: string; baseUrl?: string }
/** Node's dotenv parser treats shell substitutions and ${variables} as literal data. */
export function parseProviderKeys(text: string): ImportedProvider[] {
  try {
    const data = parseEnv(text)
    const entries: ImportedProvider[] = []
    for (const [name, provider] of Object.entries(keys)) {
      const value = data[name]
      if (!value) continue
      assertApiKey(provider, value)
      const baseUrl = provider === 'openai' && data.OPENAI_API_URL
        ? connectionBaseUrlSchema.parse(data.OPENAI_API_URL).replace(/\/+$/, '') : undefined
      entries.push({ provider, value, ...(baseUrl ? { baseUrl } : {}) })
    }
    return entries
  } catch { throw new ConnectionError('validation_failed', 'Provider key file is invalid') }
}
/** Trusted local path only. There is deliberately no HTTP route for file import. */
export async function importProviderKeysFile(connections: Connections, accountId: string, file: string) {
  try {
    const entries = parseProviderKeys(await readFile(file, 'utf8'))
    return await connections.importKeys(accountId, entries)
  } catch (error) {
    if (error instanceof ConnectionError) throw error
    throw new ConnectionError('validation_failed', 'Provider key import failed')
  }
}
