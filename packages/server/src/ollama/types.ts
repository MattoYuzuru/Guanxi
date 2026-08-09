/**
 * Сырые формы ответов Ollama HTTP API.
 *
 * Описаны по факту наблюдения за Ollama 0.32.0, а не по документации: в /api/tags
 * реально приходят `capabilities` и `details.context_length`, хотя в OpenAPI-спеке
 * они не заявлены. Поля помечены опциональными там, где версия может их не прислать.
 */

export interface OllamaModelDetails {
  parent_model?: string
  format?: string
  family?: string
  families?: string[] | null
  parameter_size?: string
  quantization_level?: string
  /** Есть в 0.32, в старых версиях отсутствует — тогда берём из /api/show. */
  context_length?: number
  embedding_length?: number
}

export interface OllamaTagsEntry {
  name: string
  model: string
  modified_at: string
  size: number
  digest: string
  details: OllamaModelDetails
  capabilities?: unknown
}

export interface OllamaTagsResponse {
  models: OllamaTagsEntry[]
}

export interface OllamaPsEntry {
  name: string
  model: string
  size: number
  digest: string
  details: OllamaModelDetails
  /** Сколько байт модели уехало на ускоритель. Если меньше `size` — часть на CPU. */
  size_vram?: number
  /** Выделенное окно контекста для этого экземпляра. */
  context_length?: number
  expires_at?: string
}

export interface OllamaPsResponse {
  models: OllamaPsEntry[]
}

export interface OllamaShowResponse {
  license?: string
  modelfile?: string
  parameters?: string
  template?: string
  system?: string
  details?: OllamaModelDetails
  /**
   * Архитектурные параметры с ключами вида `qwen2.block_count`,
   * `qwen2.attention.head_count_kv`. Из них считается размер KV-кэша.
   */
  model_info?: Record<string, unknown>
  capabilities?: unknown
}

export interface OllamaToolCall {
  function: {
    name: string
    arguments: Record<string, unknown> | string
  }
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string
  images?: string[]
  tool_calls?: OllamaToolCall[]
  tool_name?: string
}

export interface OllamaToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

export interface OllamaChatRequest {
  model: string
  messages: OllamaChatMessage[]
  stream?: boolean
  tools?: OllamaToolDefinition[]
  think?: boolean | 'low' | 'medium' | 'high'
  format?: 'json' | Record<string, unknown>
  keep_alive?: string | number
  options?: {
    num_ctx?: number
    temperature?: number
    num_predict?: number
    seed?: number
    stop?: string[]
  }
}

/** Один кадр стрима /api/chat. Метрики приходят только в последнем кадре (`done: true`). */
export interface OllamaChatChunk {
  model: string
  created_at: string
  message?: OllamaChatMessage
  done: boolean
  done_reason?: string
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
}

export interface OllamaPullChunk {
  status?: string
  digest?: string
  total?: number
  completed?: number
  error?: string
}

export interface OllamaCreateChunk {
  status?: string
  digest?: string
  total?: number
  completed?: number
  error?: string
}

export interface OllamaVersionResponse {
  version: string
}
