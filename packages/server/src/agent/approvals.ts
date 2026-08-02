/**
 * Ожидание решения человека по вызову инструмента.
 *
 * Стрим при этом не рвётся: агентный цикл останавливается на await, а HTTP-соединение
 * держится открытым. Решение приходит отдельным запросом на /api/approvals/:id.
 */
import { APPROVAL_TIMEOUT_MS } from '@alamo/contract'

export type ApprovalDecision = 'approve' | 'deny' | 'timeout' | 'cancelled'

interface PendingApproval {
  threadId: string
  toolName: string
  settle: (decision: ApprovalDecision) => void
  timer: NodeJS.Timeout
}

export class ApprovalGate {
  private readonly pending = new Map<string, PendingApproval>()
  /** Инструменты, подтверждённые «на весь тред». */
  private readonly remembered = new Map<string, Set<string>>()

  /** Инструмент уже разрешён для этого треда целиком. */
  isRemembered(threadId: string, toolName: string): boolean {
    return this.remembered.get(threadId)?.has(toolName) ?? false
  }

  remember(threadId: string, toolName: string): void {
    const set = this.remembered.get(threadId) ?? new Set<string>()
    set.add(toolName)
    this.remembered.set(threadId, set)
  }

  /** Список ожидающих решения вызовов — нужен, чтобы UI восстановился после перезагрузки. */
  pendingIds(threadId: string): string[] {
    return [...this.pending.entries()]
      .filter(([, value]) => value.threadId === threadId)
      .map(([id]) => id)
  }

  request(
    toolCallId: string,
    threadId: string,
    toolName: string,
    signal: AbortSignal,
    timeoutMs = APPROVAL_TIMEOUT_MS,
  ): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      let done = false
      const settle = (decision: ApprovalDecision) => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.pending.delete(toolCallId)
        resolve(decision)
      }

      // Молчание — не согласие: по истечении срока вызов отклоняется.
      const timer = setTimeout(() => settle('timeout'), timeoutMs)
      const onAbort = () => settle('cancelled')

      if (signal.aborted) {
        clearTimeout(timer)
        resolve('cancelled')
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })

      this.pending.set(toolCallId, { threadId, toolName, settle, timer })
    })
  }

  /** Возвращает false, если такого ожидания нет — например, оно уже истекло. */
  decide(toolCallId: string, decision: 'approve' | 'deny', rememberForThread = false): boolean {
    const entry = this.pending.get(toolCallId)
    if (!entry) return false

    if (decision === 'approve' && rememberForThread) {
      this.remember(entry.threadId, entry.toolName)
    }

    entry.settle(decision)
    return true
  }

  /** Снимает все ожидания треда — при остановке хода пользователем. */
  cancelThread(threadId: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.threadId === threadId) entry.settle('cancelled')
      else void id
    }
  }

  /** Забывает разрешения треда. Вызывается при смене воркспейса или удалении треда. */
  forgetThread(threadId: string): void {
    this.remembered.delete(threadId)
    this.cancelThread(threadId)
  }
}
