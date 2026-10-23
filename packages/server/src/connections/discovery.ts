export const MAX_DISCOVERY_BYTES = 1_048_576
/** Bound bytes while reading, before decoding or JSON allocation. Cancel on overflow. */
export async function readDiscovery(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('discovery_empty')
  try {
    if (Number(response.headers.get('content-length')) > MAX_DISCOVERY_BYTES) throw new Error('discovery_too_large')
    const chunks: Uint8Array[] = []
    let bytes = 0
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_DISCOVERY_BYTES) throw new Error('discovery_too_large')
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
