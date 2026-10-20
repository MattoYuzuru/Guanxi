import { z } from 'zod'
import type { Connection, ConnectionBalance } from '@guanxi/contract'
import type { Vault } from '../vault/vault.ts'
import type { ConnectionStore } from '../connections/store.ts'

const decimal = z.string().regex(/^-?\d+(\.\d+)?$/).transform(Number).refine(Number.isFinite)
const openrouter = z.object({ data: z.object({ limit_remaining: z.number().finite().nullable() }) })
const deepseek = z.object({ is_available: z.boolean(), balance_infos: z.array(z.object({
  currency: z.enum(['USD', 'CNY']), total_balance: decimal,
})) })
export const BALANCE_PROBES = ['openrouter', 'deepseek'] as const
export type BalanceProbe = typeof BALANCE_PROBES[number]
export const probeEndpoints: Record<BalanceProbe, string> = {
  openrouter: 'https://openrouter.ai/api/v1/key', deepseek: 'https://api.deepseek.com/user/balance',
}
export function parseBalance(provider: BalanceProbe, payload: unknown, observedAt: string): ConnectionBalance {
  z.string().datetime().parse(observedAt)
  let amount: number | null
  let currency: 'USD' | 'CNY' | null
  if (provider === 'openrouter') {
    amount = openrouter.parse(payload).data.limit_remaining
    currency = amount === null ? null : 'USD'
  } else {
    const data = deepseek.parse(payload)
    const row = data.balance_infos.find(item => item.currency === 'USD') ?? data.balance_infos[0]
    amount = row?.total_balance ?? null
    currency = row?.currency ?? null
  }
  return { scope: provider === 'openrouter' ? 'key_allowance' : 'account_balance', amount, currency, source: probeEndpoints[provider], observedAt,
    confidence: amount === null ? 'unknown' : 'high' }
}
export class BalanceProbes {
  private readonly store: ConnectionStore
  private readonly vault: Vault
  private readonly transport: typeof fetch
  constructor(store: ConnectionStore, vault: Vault,
    transport: typeof fetch = globalThis.fetch) {
    this.store = store
    this.vault = vault
    this.transport = transport
}
  async probe(connection: Connection, signal?: AbortSignal): Promise<ConnectionBalance> {
    if (!BALANCE_PROBES.includes(connection.provider as BalanceProbe)) throw new Error('No balance API; usage is metered locally')
    const provider = connection.provider as BalanceProbe
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
    try {
      const balance = await this.vault.inject(connection.accountId, connection.id, false, async key => {
        const response = await this.transport(probeEndpoints[provider], {
          headers: { Authorization: `Bearer ${key}` }, signal: combined, redirect: 'error',
        })
        if (!response.ok) throw new Error('Balance probe failed')
        const payload = await response.json()
        combined.throwIfAborted()
        return parseBalance(provider, payload, new Date().toISOString())
      })
      this.store.observe(connection.accountId, connection.id, {}, balance)
      return balance
    } catch { throw new Error('Balance probe failed; check the connection and unlock the vault') }
  }
}
