/**
 * Распознавание вызовов инструментов в ответе модели.
 *
 * Ollama отдаёт структурное поле `tool_calls` — но полагаться на него нельзя.
 * Замер на qwen2.5-coder:7b (Ollama 0.32, модель заявляет capability `tools`):
 * поле пришло пустым, а сам вызов оказался обычным текстом в `content`:
 *
 *     {"name": "read_file", "arguments": {"path": "/tmp/demo/readme.md"}}
 *
 * Для локальных моделей 7-8B это не исключение, а основной путь, поэтому парсер
 * обязан понимать оба формата.
 *
 * Ключевое ограничение: кандидат принимается, только если его имя есть в реестре
 * инструментов. Иначе модель, объясняющая пользователю формат JSON, случайно
 * запустила бы выполнение — а в агентном режиме это запись в файлы.
 */

export interface ParsedToolCall {
  name: string
  arguments: Record<string, unknown>
  parsedFrom: 'native' | 'content_json'
}

export interface ParseResult {
  calls: ParsedToolCall[]
  /** Текст без вырезанных вызовов — именно он показывается пользователю. */
  cleanedContent: string
}

interface RawToolCall {
  function?: { name?: string; arguments?: Record<string, unknown> | string }
}

/** Максимальная длина JSON-кандидата: защита от разбора гигантского текста. */
const MAX_CANDIDATE_LENGTH = 32_000

function coerceArguments(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  // Некоторые модели кладут аргументы строкой с JSON внутри.
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return null
    }
  }
  return null
}

/**
 * Приводит разные обёртки к паре «имя + аргументы».
 * Встречаются: {name, arguments}, {name, parameters},
 * {tool_call: {...}}, {function: {name, arguments}}.
 */
function normalizeCandidate(value: unknown): { name: string; arguments: Record<string, unknown> } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>

  const unwrapped =
    (record['tool_call'] as Record<string, unknown> | undefined) ??
    (record['function'] as Record<string, unknown> | undefined) ??
    record

  const name = unwrapped['name']
  if (typeof name !== 'string' || !name) return null

  const args =
    coerceArguments(unwrapped['arguments']) ??
    coerceArguments(unwrapped['parameters']) ??
    coerceArguments(unwrapped['args'])

  // Инструмент без параметров — законный случай.
  return { name, arguments: args ?? {} }
}

interface Candidate {
  raw: string
  start: number
  end: number
  value: unknown
}

/**
 * Находит JSON-объекты верхнего уровня в тексте, считая баланс скобок и
 * пропуская скобки внутри строк. Регулярным выражением это не решается:
 * вложенные объекты в аргументах ломают любой нежадный шаблон.
 */
function findJsonObjects(text: string): Candidate[] {
  const found: Candidate[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!

    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{') {
      if (depth === 0) start = i
      depth++
      continue
    }

    if (char === '}') {
      if (depth === 0) continue
      depth--
      if (depth === 0 && start >= 0) {
        const raw = text.slice(start, i + 1)
        if (raw.length <= MAX_CANDIDATE_LENGTH) {
          try {
            found.push({ raw, start, end: i + 1, value: JSON.parse(raw) })
          } catch {
            // Не JSON — обычный текст с фигурными скобками, пропускаем.
          }
        }
        start = -1
      }
    }
  }

  return found
}

/** Снимает обёртки `<tool_call>` и ```json — их содержимое разбирается наравне с остальным. */
function stripWrappers(content: string): string {
  return content
    .replace(/<\/?tool_call>/gi, '\n')
    .replace(/<\/?tool▁call>/gi, '\n')
    .replace(/```(?:json|tool_code)?/gi, '\n')
    .replace(/```/g, '\n')
}

export interface ParseOptions {
  /** Имена известных инструментов. Кандидаты с другими именами игнорируются. */
  knownTools: ReadonlySet<string>
}

/**
 * Разбирает один ответ модели.
 *
 * @param nativeToolCalls поле `message.tool_calls` из ответа Ollama
 * @param content текст ответа
 */
export function parseToolCalls(
  nativeToolCalls: RawToolCall[] | undefined | null,
  content: string,
  options: ParseOptions,
): ParseResult {
  // Структурный формат — доверяем как есть, имя не сверяем: его прислал сам движок.
  if (nativeToolCalls && nativeToolCalls.length > 0) {
    const calls: ParsedToolCall[] = []
    for (const raw of nativeToolCalls) {
      const name = raw.function?.name
      if (typeof name !== 'string' || !name) continue
      calls.push({
        name,
        arguments: coerceArguments(raw.function?.arguments) ?? {},
        parsedFrom: 'native',
      })
    }
    if (calls.length > 0) return { calls, cleanedContent: content }
  }

  if (!content.trim() || options.knownTools.size === 0) {
    return { calls: [], cleanedContent: content }
  }

  const searchText = stripWrappers(content)
  const candidates = findJsonObjects(searchText)
  if (candidates.length === 0) return { calls: [], cleanedContent: content }

  const calls: ParsedToolCall[] = []
  const consumed: string[] = []

  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate.value)
    if (!normalized) continue
    // Имя обязано быть известным: иначе это просто JSON в тексте ответа.
    if (!options.knownTools.has(normalized.name)) continue

    calls.push({ ...normalized, parsedFrom: 'content_json' })
    consumed.push(candidate.raw)
  }

  if (calls.length === 0) return { calls: [], cleanedContent: content }

  // Вырезаем разобранные вызовы из видимого текста, чтобы не показывать сырой JSON.
  let cleaned = content
  for (const raw of consumed) cleaned = cleaned.split(raw).join('')

  cleaned = cleaned
    .replace(/<\/?tool_call>/gi, '')
    .replace(/```(?:json|tool_code)?\s*```/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { calls, cleanedContent: cleaned }
}
