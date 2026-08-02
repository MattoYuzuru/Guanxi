/**
 * Буфер стримящегося ответа.
 *
 * Токены нельзя держать в обычном useState треда: каждый токен перерисовывал бы
 * весь список сообщений, а на 20 tok/s это заметно. Поэтому текст живёт во
 * внешнем сторе, на который подписан ровно один компонент — последнее сообщение.
 *
 * Уведомления коалесцируются по requestAnimationFrame: сколько бы токенов ни
 * пришло за кадр, перерисовка будет одна.
 */

export type StreamSnapshot = {
  content: string
  thinking: string
  /** Растёт на каждое изменение — служит снапшотом для useSyncExternalStore. */
  version: number
}

export class StreamBuffer {
  private content = ''
  private thinking = ''
  private version = 0
  private snapshot: StreamSnapshot = { content: '', thinking: '', version: 0 }

  private listeners = new Set<() => void>()
  private frame: number | null = null
  private dirty = false

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): StreamSnapshot => this.snapshot

  appendToken(delta: string): void {
    this.content += delta
    this.markDirty()
  }

  appendThinking(delta: string): void {
    this.thinking += delta
    this.markDirty()
  }

  reset(): void {
    this.content = ''
    this.thinking = ''
    this.flushNow()
  }

  /** Текущий текст без ожидания кадра — нужен при финализации хода. */
  peek(): { content: string; thinking: string } {
    return { content: this.content, thinking: this.thinking }
  }

  /** Немедленно опубликовать накопленное (конец стрима, остановка). */
  flushNow(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame)
      this.frame = null
    }
    this.dirty = false
    this.publish()
  }

  dispose(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.listeners.clear()
  }

  private markDirty(): void {
    this.dirty = true
    if (this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      if (!this.dirty) return
      this.dirty = false
      this.publish()
    })
  }

  private publish(): void {
    this.version += 1
    // Новый объект обязателен: useSyncExternalStore сравнивает по ссылке.
    this.snapshot = {
      content: this.content,
      thinking: this.thinking,
      version: this.version,
    }
    for (const listener of this.listeners) listener()
  }
}
