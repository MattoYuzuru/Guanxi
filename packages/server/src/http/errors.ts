/**
 * Единый формат ошибок API.
 *
 * Коды описаны в контракте (`apiErrorSchema`), чтобы фронт различал состояния
 * по коду, а не по тексту сообщения.
 */
import type { Context } from 'hono'
import type { ApiError } from '@alamo/contract'
import { OllamaError, OllamaUnavailableError } from '../ollama/client.ts'
import { PathOutsideWorkspaceError } from '../tools/jail.ts'
import { ToolError } from '../tools/types.ts'

type StatusCode = 400 | 403 | 404 | 500 | 502 | 503

function classify(error: unknown): { status: StatusCode; body: ApiError } {
  if (error instanceof OllamaUnavailableError) {
    return {
      status: 503,
      body: {
        code: 'ollama_unavailable',
        message: error.message,
        details: { hint: 'Запусти Ollama командой `ollama serve` или проверь адрес в настройках' },
      },
    }
  }

  if (error instanceof PathOutsideWorkspaceError) {
    return {
      status: 403,
      body: {
        code: 'path_outside_workspace',
        message: error.message,
        details: { requestedPath: error.requestedPath },
      },
    }
  }

  if (error instanceof ToolError) {
    return { status: 400, body: { code: 'validation_failed', message: error.message, details: null } }
  }

  if (error instanceof OllamaError) {
    return {
      status: 502,
      body: { code: 'upstream_error', message: error.message, details: null },
    }
  }

  return {
    status: 500,
    body: {
      code: 'internal_error',
      message: error instanceof Error ? error.message : String(error),
      details: null,
    },
  }
}

export function fail(context: Context, error: unknown): Response {
  const { status, body } = classify(error)
  return context.json(body, status)
}

export function notFound(context: Context, code: ApiError['code'], message: string): Response {
  return context.json({ code, message, details: null }, 404)
}
