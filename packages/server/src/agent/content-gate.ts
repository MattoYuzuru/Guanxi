/**
 * Придерживает текст, похожий на вызов инструмента, вместо того чтобы стримить его.
 *
 * Модели без структурного tool-calling выводят вызов обычным текстом. Если стримить
 * его как есть, пользователь увидит сырой JSON, который через секунду должен исчезнуть.
 * Поэтому с момента появления признака вызова текст копится в буфере, а решение
 * показывать его или нет принимается после разбора ответа.
 */

const MARKERS = ['<tool_call', '<tool▁call', '```json', '```tool_code']

/** Ищет начало возможного вызова. Возвращает -1, если признаков нет. */
function markerIndex(content: string): number {
  let earliest = -1

  for (const marker of MARKERS) {
    const index = content.toLowerCase().indexOf(marker)
    if (index >= 0 && (earliest < 0 || index < earliest)) earliest = index
  }

  /*
   * Открывающая скобка в начале ответа или в начале строки. Обычная проза так
   * почти никогда не выглядит, а вызов инструмента — ровно так.
   */
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '{') continue
    const before = content.slice(0, i)
    if (before.trim() === '' || before.endsWith('\n')) {
      if (earliest < 0 || i < earliest) earliest = i
      break
    }
  }

  return earliest
}

export class ContentGate {
  private full = ''
  private emittedUpTo = 0

  /** Добавляет кусок ответа и возвращает текст, который можно показать прямо сейчас. */
  push(delta: string): string {
    this.full += delta

    const marker = markerIndex(this.full)
    const safeEnd = marker >= 0 ? marker : this.full.length

    if (safeEnd <= this.emittedUpTo) return ''

    const emit = this.full.slice(this.emittedUpTo, safeEnd)
    this.emittedUpTo = safeEnd
    return emit
  }

  /** Весь накопленный ответ, включая придержанное. */
  get content(): string {
    return this.full
  }

  /** Текст, который был придержан и ещё не показан. */
  get withheld(): string {
    return this.full.slice(this.emittedUpTo)
  }

  /** Помечает придержанное как показанное. */
  markFlushed(): void {
    this.emittedUpTo = this.full.length
  }
}
