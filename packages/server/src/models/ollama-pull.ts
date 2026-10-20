import type { PullStreamEvent } from '@guanxi/contract'
import {
  OllamaProtocolError,
  OllamaUnavailableError,
  type OllamaClient,
} from '../ollama/client.ts'

export interface PullEventOptions {
  now?: () => number
}

export async function* pullModelEvents(
  client: Pick<OllamaClient, 'pull'>,
  name: string,
  signal: AbortSignal,
  options: PullEventOptions = {},
): AsyncGenerator<PullStreamEvent> {
  const now = options.now ?? Date.now
  let seq = 0
  const startedAt = now()
  let terminal = false
  const completedByDigest = new Map<string, number>()

  try {
    for await (const chunk of client.pull(name, signal)) {
      if (signal.aborted) return
      if (chunk.error) {
        yield {
          type: 'error',
          seq: seq++,
          data: {
            code: 'upstream_error',
            message: 'Ollama could not pull the confirmed model',
            details: null,
          },
        }
        return
      }

      const status = chunk.status
      if (!status) throw new OllamaProtocolError('/api/pull')
      const total = chunk.total ?? null
      const completed = chunk.completed ?? null
      if (total !== null && completed !== null && completed > total) {
        throw new OllamaProtocolError('/api/pull')
      }
      if (chunk.digest && completed !== null) {
        const previous = completedByDigest.get(chunk.digest)
        if (previous !== undefined && completed < previous) {
          throw new OllamaProtocolError('/api/pull')
        }
        completedByDigest.set(chunk.digest, completed)
      }
      const elapsedSeconds = (now() - startedAt) / 1_000
      const bytesPerSecond =
        completed !== null && elapsedSeconds > 0
          ? Math.round(completed / elapsedSeconds)
          : null
      const remaining =
        total !== null && completed !== null ? total - completed : null
      const etaSeconds =
        remaining !== null && bytesPerSecond && bytesPerSecond > 0
          ? Math.round(remaining / bytesPerSecond)
          : null

      yield {
        type: 'progress',
        seq: seq++,
        data: {
          status,
          digest: chunk.digest ?? null,
          totalBytes: total,
          completedBytes: completed,
          percent:
            total && completed !== null
              ? Math.round((completed / total) * 1_000) / 10
              : null,
          bytesPerSecond,
          etaSeconds,
        },
      }

      if (status === 'success') {
        terminal = true
        break
      }
    }

    if (signal.aborted) return
    if (!terminal) {
      yield {
        type: 'error',
        seq: seq++,
        data: {
          code: 'runtime_protocol',
          message: 'Ollama ended the pull before terminal success',
          details: null,
        },
      }
      return
    }
    yield { type: 'done', seq: seq++, data: { name } }
  } catch (error) {
    if (signal.aborted) return
    yield {
      type: 'error',
      seq: seq++,
      data: {
        code:
          error instanceof OllamaUnavailableError
            ? 'ollama_unavailable'
            : error instanceof OllamaProtocolError
              ? 'runtime_protocol'
              : 'upstream_error',
        message:
          error instanceof OllamaUnavailableError
            ? 'Ollama is unavailable'
            : error instanceof OllamaProtocolError
              ? 'Ollama returned an incompatible pull stream'
              : 'The confirmed model could not be pulled',
        details: null,
      },
    }
  }
}
