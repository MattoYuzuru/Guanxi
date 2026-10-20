/**
 * Test wiring for K1: obtain the legacy governor and Ollama client through the
 * kernel facade. Each call boots a fresh kernel, loads the plugin and returns
 * the service the plugin provides, so legacy tests exercise the plugin path.
 */
import { createKernel, type Kernel } from '@guanxi/kernel'
import type { OllamaClient, OllamaClientOptions } from '../../src/ollama/client.ts'
import {
  OLLAMA_ADAPTER_SERVICE,
  ollamaAdapterPlugin,
  type OllamaAdapter,
} from '../../src/ollama/plugin.ts'
import {
  RESOURCE_GOVERNOR_SERVICE,
  resourceGovernorPlugin,
} from '../../src/runtime/governor-plugin.ts'
import type { ResourceGovernor, ResourceGovernorOptions } from '../../src/runtime/resource-governor.ts'

const kernels = new WeakMap<object, Kernel>()

/** The kernel that provided this governor or client, for wiring assertions. */
export function kernelOf(instance: object): Kernel | undefined {
  return kernels.get(instance)
}

export async function governorThroughKernel(
  options?: ResourceGovernorOptions,
): Promise<ResourceGovernor> {
  const kernel = createKernel()
  await kernel.plugin(resourceGovernorPlugin, options)
  const governor = kernel.service<ResourceGovernor>(RESOURCE_GOVERNOR_SERVICE)!
  kernels.set(governor, kernel)
  return governor
}

export async function ollamaClientThroughKernel(options: OllamaClientOptions): Promise<OllamaClient> {
  const { host, ...config } = options
  const kernel = createKernel()
  await kernel.plugin(ollamaAdapterPlugin, config)
  const client = kernel.service<OllamaAdapter>(OLLAMA_ADAPTER_SERVICE)!.client(host)
  kernels.set(client, kernel)
  return client
}
