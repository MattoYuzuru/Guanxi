import { providerCatalog, type Connection, type ProviderCatalogEntry, type ProviderCategory } from '@guanxi/contract'

/** The catalog is the only source of product names, key hints and routing facts. */
export function catalogEntry(provider: Connection['provider']): ProviderCatalogEntry {
  return providerCatalog.find(item => item.provider === provider)
    ?? providerCatalog.find(item => item.category === 'llm_api')!
}

/** Old-import names may still carry the retired `(dotenv)` suffix; never render it. */
export function connectionLabel(connection: Pick<Connection, 'name' | 'provider'>): string {
  const entry = catalogEntry(connection.provider)
  const name = connection.name.replace(/\s*\(dotenv\)\s*$/iu, '').trim()
  // A retired import named the row after the provider slug; the catalog has the product label.
  if (!name || name.toLocaleLowerCase() === connection.provider.toLocaleLowerCase()) return entry.label
  return name
}

export function connectionCategory(connection: Pick<Connection, 'provider'>): ProviderCategory {
  return catalogEntry(connection.provider).category
}

/** One letter is a monogram, not a third-party logo. */
export function connectionMonogram(label: string): string {
  return [...label.trim()][0]?.toLocaleUpperCase() ?? '?'
}
