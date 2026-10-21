export function normalizeHost(host: string): string {
  if (host.startsWith('http://') || host.startsWith('https://')) return host
  return `http://${host}`
}
