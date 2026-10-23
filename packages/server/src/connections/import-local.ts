import { join } from 'node:path'
import { createKernel } from '@guanxi/kernel'
import { resourceGovernorPlugin } from '../runtime/governor-plugin.ts'
import { ollamaAdapterPlugin } from '../ollama/plugin.ts'
import { egressScrubberPlugin } from '../egress/plugin.ts'
import { connectionsPlugin, CONNECTIONS_SERVICE } from './plugin.ts'
import type { Connections } from './service.ts'
import { importProviderKeysFile } from './dotenv.ts'

/** Standalone import starts neither an HTTP listener nor an inference request. */
export async function importLocalProviderKeys(dataDir: string, file: string) {
  const node = createKernel()
  try {
    await node.plugin(resourceGovernorPlugin)
    await node.plugin(ollamaAdapterPlugin)
    await node.plugin(egressScrubberPlugin, { expectedSources: ['vault'] })
    await node.plugin(connectionsPlugin, { databasePath: join(dataDir, 'connections.sqlite'), localHost: () => 'http://127.0.0.1:11434' })
    return await importProviderKeysFile(node.service<Connections>(CONNECTIONS_SERVICE)!, 'local', file)
  } finally { await node.dispose() }
}
