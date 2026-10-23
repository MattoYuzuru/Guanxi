import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { connectionBaseUrlSchema, type Connection } from '@guanxi/contract'
import { assertApiKey } from './pi.ts'
import { ConnectionError } from './errors.ts'
import type { Connections } from './service.ts'

const keys = { OPENAI_API_KEY: 'openai', DEEPSEEK_API_KEY: 'deepseek', ANTHROPIC_API_KEY: 'anthropic',
  OPENROUTER_API_KEY: 'openrouter', GOOGLE_API_KEY: 'google' } as const
export interface ImportedProvider { provider: Connection['provider']; value: string; baseUrl?: string; allowPrivate?: boolean }
/** Node's dotenv parser treats shell substitutions and ${variables} as literal data. */
export function parseProviderKeys(text: string): ImportedProvider[] {
  try {
    text = text.replace(/^\uFEFF/, '')
    const seen = new Set<string>()
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
      if (!match) continue
      const name = match[1]!, raw = match[2]!
      if (seen.has(name)) throw new Error('duplicate_key')
      seen.add(name)
      if (/^["'`]/.test(raw)) {
        const end = raw.indexOf(raw[0]!, 1)
        if (end < 0 || !/^\s*(?:#.*)?$/.test(raw.slice(end + 1))) throw new Error('invalid_quotes')
      } else if (raw.includes('#')) throw new Error('unquoted_comment_truncation')
    }
    const data = parseEnv(text)
    const entries: ImportedProvider[] = []
    for (const [name, provider] of Object.entries(keys)) {
      const value = data[name]
      if (!value) continue
      assertApiKey(provider, value)
      const baseUrl = provider === 'openai' && data.OPENAI_API_URL
        ? connectionBaseUrlSchema.parse(data.OPENAI_API_URL).replace(/\/+$/, '') : undefined
      entries.push({ provider, value, ...(baseUrl ? { baseUrl, allowPrivate: data.GUANXI_PROVIDER_ALLOW_PRIVATE === '1' } : {}) })
    }
    if (!entries.length) throw new Error('no_supported_key')
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
