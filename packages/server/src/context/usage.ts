/**
 * Метрики хода и определение попадания в KV-кэш.
 *
 * Ollama не сообщает, переиспользовался ли префикс. Определяем это по двум
 * независимым признакам: структуре append-only диалога и времени prefill.
 *
 * Структура даёт верхнюю границу: предыдущий промпт и ответ модели образуют
 * неизменный префикс следующего запроса. Время подтверждает, что Ollama реально
 * сохранила его в KV-кэше. Одного времени недостаточно: на коротком промпте
 * постоянные накладные расходы съедают большую часть разницы.
 *
 * Замер на M2 Pro, qwen2.5-coder:7b:
 *   холодный prefill   7847 токенов за 41.8 с
 *   попадание в кэш    7870 токенов за  0.3 с
 */
import type { ContextState, Usage } from '@alamo/contract'
import type { OllamaChatChunk } from '../ollama/types.ts'

/** Кэш должен сократить холодное время хотя бы вдвое. */
const CACHE_HIT_TIME_RATIO = 0.5

/** Промпты короче этого не годятся для калибровки: накладные расходы искажают скорость. */
const MIN_TOKENS_FOR_BASELINE = 32

const NS_PER_MS = 1_000_000

export interface PrefillObservation {
  model: string
  promptTokens: number
  promptEvalMs: number
  /**
   * Сколько токенов совпадает с предыдущим запросом. Значение считается по
   * истории треда; 0 означает первый ход или историю после компакции.
   */
  expectedPrefixTokens: number
}

export class PrefillTracker {
  /** Опорная стоимость холодной обработки одного токена, мс. */
  private readonly msPerToken = new Map<string, number>()

  coldMsPerToken(model: string): number | null {
    return this.msPerToken.get(model) ?? null
  }

  evaluate(observation: PrefillObservation): { cacheHit: boolean; cachedTokens: number } {
    const { model, promptTokens, promptEvalMs, expectedPrefixTokens } = observation
    if (promptTokens <= 0 || promptEvalMs <= 0) return { cacheHit: false, cachedTokens: 0 }

    const known = this.msPerToken.get(model)
    const reusable = Math.max(0, Math.min(expectedPrefixTokens, promptTokens))

    if (known === undefined) {
      // Опору можно учить только на заведомо холодном запросе.
      if (promptTokens >= MIN_TOKENS_FOR_BASELINE && reusable === 0) {
        this.msPerToken.set(model, promptEvalMs / promptTokens)
      }
      return { cacheHit: false, cachedTokens: 0 }
    }

    const expectedColdMs = promptTokens * known
    const cacheHit = reusable > 0 && promptEvalMs < expectedColdMs * CACHE_HIT_TIME_RATIO

    // Кэшированный или потенциально кэшированный ход не должен сдвигать опору.
    if (!cacheHit && reusable === 0 && promptTokens >= MIN_TOKENS_FOR_BASELINE) {
      const observed = promptEvalMs / promptTokens
      this.msPerToken.set(model, known * 0.7 + observed * 0.3)
    }

    return { cacheHit, cachedTokens: cacheHit ? reusable : 0 }
  }

  /** Сколько будет стоить полный пересчёт промпта такой длины. */
  estimateColdPrefillMs(model: string, tokens: number): number {
    const perToken = this.msPerToken.get(model)
    if (!perToken || tokens <= 0) return 0
    return Math.round(tokens * perToken)
  }
}

/** Собирает метрики хода из последнего кадра стрима Ollama. */
export function buildUsage(
  chunk: OllamaChatChunk,
  tracker: PrefillTracker,
  model: string,
  expectedPrefixTokens: number,
): Usage {
  const promptTokens = chunk.prompt_eval_count ?? 0
  const evalTokens = chunk.eval_count ?? 0
  const promptEvalDurationMs = Math.round((chunk.prompt_eval_duration ?? 0) / NS_PER_MS)
  const evalDurationMs = Math.round((chunk.eval_duration ?? 0) / NS_PER_MS)

  const { cacheHit, cachedTokens } = tracker.evaluate({
    model,
    promptTokens,
    promptEvalMs: promptEvalDurationMs,
    expectedPrefixTokens,
  })

  return {
    promptTokens,
    evalTokens,
    promptEvalDurationMs,
    evalDurationMs,
    loadDurationMs: Math.round((chunk.load_duration ?? 0) / NS_PER_MS),
    totalDurationMs: Math.round((chunk.total_duration ?? 0) / NS_PER_MS),
    tokensPerSecond: evalDurationMs > 0 ? evalTokens / (evalDurationMs / 1000) : 0,
    cacheHit,
    cachedTokens,
  }
}

/** Порог заполнения окна, после которого предлагаем свернуть контекст. */
const COMPACTION_SUGGESTION_THRESHOLD_PERCENT = 60

export function buildContextState(input: {
  usedTokens: number
  allocatedTokens: number
  usage: Usage | null
  model: string
  tracker: PrefillTracker
}): ContextState {
  const { usedTokens, allocatedTokens, usage, model, tracker } = input
  const percent = allocatedTokens > 0 ? (usedTokens / allocatedTokens) * 100 : 0

  return {
    usedTokens,
    allocatedTokens,
    percent,
    cacheHit: usage?.cacheHit ?? false,
    cachedTokens: usage?.cachedTokens ?? 0,
    compactable: percent > COMPACTION_SUGGESTION_THRESHOLD_PERCENT,
    /*
     * Честная цена компакции: она сбрасывает префикс KV-кэша, и следующий ход
     * придётся считать с нуля. Именно это число показывается на кнопке.
     */
    estimatedRepefillMs: tracker.estimateColdPrefillMs(model, usedTokens),
  }
}

/**
 * Грубая оценка числа токенов в тексте — для шкалы контекста до того,
 * как придёт первый ответ с точными метриками.
 *
 * Токенизатор модели недоступен через API, поэтому считаем по объёму: около
 * 3.5 байт на токен для смеси латиницы и кириллицы. Кириллица в UTF-8 занимает
 * два байта на символ, и оценка по длине строки для неё занижала бы вдвое.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3.5)
}
