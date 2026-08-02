/**
 * Реестр инструментов, доступных агенту в конкретном ходе.
 *
 * Состав зависит от режима: в чате файловых инструментов нет вовсе, в агентном
 * режиме они появляются, а bash — только если явно включён в настройках.
 */
import type { OllamaToolDefinition } from '../ollama/types.ts'
import { bashTool } from './bash.ts'
import { FS_TOOLS } from './fs-tools.ts'
import type { ToolDefinition } from './types.ts'

export interface RegistryOptions {
  hasWorkspace: boolean
  enableBash: boolean
  /** Инструменты, пришедшие от подключённых MCP-серверов. */
  external?: readonly ToolDefinition[]
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  constructor(options: RegistryOptions) {
    if (options.hasWorkspace) {
      for (const tool of FS_TOOLS) this.tools.set(tool.name, tool)
      if (options.enableBash) this.tools.set(bashTool.name, bashTool)
    }
    for (const tool of options.external ?? []) this.tools.set(tool.name, tool)
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  get size(): number {
    return this.tools.size
  }

  /** Имена для парсера: только известные имена принимаются как вызовы. */
  names(): ReadonlySet<string> {
    return new Set(this.tools.keys())
  }

  /** Описания в формате, который понимает Ollama. */
  toOllamaTools(): OllamaToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()]
  }
}
