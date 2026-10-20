/**
 * The server's kernel node (K1): the legacy server boots a kernel profile that
 * loads the Resource Governor and the Ollama adapter as plugins, then hands
 * their services to the legacy application context.
 */
import type { ProfileLayer } from '@guanxi/kernel'
import { bootNode, type NodeKernel } from '@guanxi/kernel/node'
import { OLLAMA_ADAPTER_SERVICE, ollamaAdapterPlugin, type OllamaAdapter } from '../ollama/plugin.ts'
import { RESOURCE_GOVERNOR_SERVICE, resourceGovernorPlugin } from './governor-plugin.ts'
import type { ResourceGovernor } from './resource-governor.ts'

export const LEGACY_SERVER_PROFILE: ProfileLayer = Object.freeze({
  name: 'profile:legacy-server',
  insert: [
    { id: 'resource-governor', plugin: resourceGovernorPlugin.manifest.id },
    { id: 'ollama', plugin: ollamaAdapterPlugin.manifest.id },
  ],
})

export interface ServerKernel {
  readonly node: NodeKernel
  readonly governor: ResourceGovernor
  readonly ollama: OllamaAdapter
}

export async function bootServerKernel(
  profile: readonly ProfileLayer[] = [LEGACY_SERVER_PROFILE],
): Promise<ServerKernel> {
  const node = await bootNode({
    plugins: [resourceGovernorPlugin, ollamaAdapterPlugin],
    profile,
    // The legacy context keeps the instances handed out below, so these rows
    // must not reload until their consumers are plugins themselves.
    pinned: LEGACY_SERVER_PROFILE.insert?.map((row) => row.id) ?? [],
  })
  const governor = node.service<ResourceGovernor>(RESOURCE_GOVERNOR_SERVICE)
  const ollama = node.service<OllamaAdapter>(OLLAMA_ADAPTER_SERVICE)
  if (!governor || !ollama) {
    await node.dispose()
    throw new Error('the server kernel profile did not provide the governor and Ollama services')
  }
  return { node, governor, ollama }
}
