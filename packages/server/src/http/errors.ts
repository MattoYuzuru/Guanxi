import { ConnectionError } from '../connections/errors.ts'
/**
 * Единый формат ошибок API.
 *
 * Коды описаны в контракте (`apiErrorSchema`), чтобы фронт различал состояния
 * по коду, а не по тексту сообщения.
 */
import type { Context } from 'hono'
import type { ApiError } from '@guanxi/contract'
import {
  OllamaError,
  OllamaProtocolError,
  OllamaTimeoutError,
  OllamaUnavailableError,
} from '../ollama/client.ts'
import { ResourceGovernorError } from '../runtime/resource-governor.ts'
import { ModelContextLimitExceededError } from '../models/service.ts'
import { PathOutsideWorkspaceError } from '../tools/jail.ts'
import { ToolError } from '../tools/types.ts'
import { ContextCheckpointStoreError } from '../store/threads.ts'

type StatusCode = 400 | 403 | 404 | 409 | 500 | 502 | 503 | 504

function classify(error: unknown): { status: StatusCode; body: ApiError } {
  if (error instanceof ConnectionError) return { status: error.code === 'validation_failed' ? 400 : 503,
    body: { code: 'upstream_error', message: error.message, details: { connectionCode: error.code } } }
  if (error instanceof ContextCheckpointStoreError) {
    if (error.code === 'stale_checkpoint') {
      return {
        status: 409,
        body: { code: 'job_conflict', message: error.message, details: null },
      }
    }
    if (error.code === 'invalid_input') {
      return {
        status: 400,
        body: { code: 'validation_failed', message: error.message, details: null },
      }
    }
    return {
      status: 500,
      body: { code: 'storage_error', message: error.message, details: null },
    }
  }

  if (error instanceof ModelContextLimitExceededError) {
    return {
      status: 400,
      body: {
        code: 'context_limit_exceeded',
        message: error.message,
        details: {
          model: error.model,
          requestedContext: error.requestedContext,
          contextLimit: error.limit,
        },
      },
    }
  }

  if (error instanceof ResourceGovernorError) {
    if (
      error.code === 'unload_active_model' ||
      error.code === 'unload_conservative_active_owner'
    ) {
      return {
        status: 409,
        body: {
          code: 'job_conflict',
          message: 'Model unload is blocked by active resource ownership',
          details: { reason: error.code },
        },
      }
    }
    return {
      status: error.code === 'admission_closed' ? 503 : 500,
      body: {
        code: 'internal_error',
        message:
          error.code === 'admission_closed'
            ? 'Resource admission is closed during application shutdown'
            : 'Resource admission failed',
        details: null,
      },
    }
  }

  if (error instanceof OllamaTimeoutError) {
    const code: ApiError['code'] =
      error.phase === 'connect'
        ? 'ollama_connect_timeout'
        : error.phase === 'load'
          ? 'ollama_load_timeout'
          : 'ollama_stream_idle_timeout'
    return {
      status: 504,
      body: {
        code,
        message: error.message,
        details: { phase: error.phase, timeoutMs: error.timeoutMs },
      },
    }
  }

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

  if (error instanceof OllamaProtocolError) {
    return {
      status: 502,
      body: {
        code: 'runtime_protocol',
        message: 'Ollama returned an incompatible response',
        details: { endpoint: error.endpoint },
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
