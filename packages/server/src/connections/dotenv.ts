import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { connectionBaseUrlSchema, type Connection } from '@guanxi/contract'
import { assertApiKey, assertOAuthToken } from './pi.ts'
import { ConnectionError } from './errors.ts'
import type { Connections } from './service.ts'

const keys = { OPENAI_API_KEY: 'openai', OPENAI_COMPAT_API_KEY: 'openai', DEEPSEEK_API_KEY: 'deepseek', ANTHROPIC_API_KEY: 'anthropic',
  OPENROUTER_API_KEY: 'openrouter', GOOGLE_API_KEY: 'google' } as const
export interface ImportedProvider { provider: Connection['provider']; value: string; baseUrl?: string; allowPrivate?: boolean }
/** Node's dotenv parser treats shell substitutions and ${variables} as literal data. */
export interface KeyFileOptions {
  /** D-212: read the owner's Claude Code subscription token (`sk-ant-oat...`) as a credential of the official CLI. It is taken from
   * `CLAUDE_CODE_OAUTH_TOKEN`, or from `ANTHROPIC_API_KEY` when that holds such a token and the first name is absent. Never an API key. */
  oauthToken?: boolean
}
export function parseProviderKeyFile(text: string, options: KeyFileOptions = {}) {
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
    const errors: { key: string; code: 'invalid_provider_key' }[] = []
    const names: Record<string, Connection['provider']> = options.oauthToken ? { ...keys, CLAUDE_CODE_OAUTH_TOKEN: 'claude-code' } : keys
    for (const [name, mapped] of Object.entries(names)) {
      const value = data[name]
      if (!value) continue
      // The owner may have put the subscription token under the API key's name: in token mode that is a Claude Code credential.
      const provider = options.oauthToken && name === 'ANTHROPIC_API_KEY' && value.startsWith('sk-ant-oat') && !data.CLAUDE_CODE_OAUTH_TOKEN ? 'claude-code' : mapped
      try {
      if (provider === 'claude-code') assertOAuthToken(value); else assertApiKey(provider, value)
      const endpoint = name === 'OPENAI_COMPAT_API_KEY' ? data.OPENAI_COMPAT_API_URL : provider === 'openai' ? data.OPENAI_API_URL : undefined
      if (name === 'OPENAI_COMPAT_API_KEY' && !endpoint) throw new Error('compatible_root_required')
      const baseUrl = endpoint ? connectionBaseUrlSchema.parse(endpoint).replace(/\/+$/, '') : undefined
      entries.push({ provider, value, ...(baseUrl ? { baseUrl, allowPrivate: data.GUANXI_PROVIDER_ALLOW_PRIVATE === '1' } : {}) })
      } catch { errors.push({ key: name, code: 'invalid_provider_key' }) }
    }
    if (!entries.length && !errors.length) throw new Error('no_supported_key')
    return { entries, errors }
  } catch { throw new ConnectionError('validation_failed', 'Provider key file is invalid') }
}
/** Strict convenience parser; import reports valid/invalid providers independently. */
export function parseProviderKeys(text: string): ImportedProvider[] {
  const result = parseProviderKeyFile(text)
  if (result.errors.length) throw new ConnectionError('validation_failed', 'Provider key file is invalid')
  return result.entries
}
/** Trusted local path only. There is deliberately no HTTP route for file import. */
export async function importProviderKeysFile(connections: Connections, accountId: string, file: string, options: KeyFileOptions = {}) {
  try {
    const { entries, errors } = parseProviderKeyFile(await readFile(file, 'utf8'), options)
    const result = entries.length ? await connections.importKeys(accountId, entries) : { imported: [] }
    return { ...result, ...(errors.length ? { errors } : {}) }
  } catch (error) {
    if (error instanceof ConnectionError) throw error
    throw new ConnectionError('validation_failed', 'Provider key import failed')
  }
}

/** Diagnostics for an owner-designated key file (the MS1 doctor): which providers it would import and which supported names are invalid,
 * plus its file mode. Never a value, and nothing is imported. */
export function inspectProviderKeysFile(file: string, options: KeyFileOptions = {}):
  { kind: 'unreadable' } | { kind: 'invalid' } | { kind: 'ok'; providers: string[]; invalid: string[]; mode: number } {
  let text: string, mode: number
  try {
    const stat = statSync(file)
    if (!stat.isFile()) return { kind: 'unreadable' }
    mode = stat.mode
    text = readFileSync(file, 'utf8')
  } catch { return { kind: 'unreadable' } }
  try {
    const { entries, errors } = parseProviderKeyFile(text, options)
    return { kind: 'ok', providers: entries.map(entry => entry.provider), invalid: errors.map(error => error.key), mode }
  } catch { return { kind: 'invalid' } }
}
