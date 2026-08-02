/**
 * Общие типы слоя инструментов.
 */
import type { OllamaToolDefinition } from '../ollama/types.ts'

export interface ToolContext {
  /** Корень воркспейса. null в режиме чата — файловые инструменты тогда недоступны. */
  workspaceRoot: string | null
  enableBash: boolean
  signal: AbortSignal
}

export interface ToolResult {
  /** Текст, который уйдёт обратно в модель. */
  content: string
  /** Для операций записи — предпросмотр изменения, чтобы человек подтверждал осознанно. */
  diff?: { path: string; before: string; after: string }
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: OllamaToolDefinition['function']['parameters']
  /**
   * Инструмент меняет состояние вне процесса (файлы, команды).
   * Такие по умолчанию требуют подтверждения человеком.
   */
  mutating: boolean
  /** Требует настроенного воркспейса. */
  needsWorkspace: boolean
  /**
   * Безопасный предпросмотр до подтверждения. Не меняет состояние и нужен
   * операциям записи, чтобы UI показал реальный diff до выполнения.
   */
  preview?(args: Record<string, unknown>, context: ToolContext): Promise<Pick<ToolResult, 'diff'>>
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

/** Достаёт строковый аргумент, внятно ругаясь на отсутствие. */
export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ToolError(`Аргумент «${key}» обязателен и должен быть непустой строкой`)
  }
  return value
}

export function optionalString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | null {
  const value = args[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return null
}

/** Требует, чтобы воркспейс был настроен. */
export function requireWorkspace(context: ToolContext): string {
  if (!context.workspaceRoot) {
    throw new ToolError('Не выбрана рабочая директория — файловые инструменты недоступны')
  }
  return context.workspaceRoot
}
