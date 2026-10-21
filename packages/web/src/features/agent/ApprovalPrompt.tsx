/**
 * Подтверждение действия инструмента.
 *
 * Модалка, а не инлайн-карточка: запись в файлы пользователя — решение, которое
 * не должно уехать за пределы вьюпорта, пока человек читает дифф.
 *
 * Таймаут показываем отсчётом. Обратите внимание: в контракте приходит только
 * `timeoutMs`, абсолютной метки нет, поэтому отсчёт идёт от момента получения
 * события на клиенте.
 */
import { useEffect, useRef, useState } from 'react'
import type { PendingApproval } from '../chat/useChat.ts'
import { Badge, Button, Modal, Toggle, cx } from '../../components/ui.tsx'
import { useCountdown } from '../../lib/useAsync.ts'
import { formatDuration } from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'
import { DiffViewer } from './DiffViewer.tsx'
import { formatArguments } from './ToolCallCard.tsx'

export function ApprovalPrompt({
  approval,
  onDecide,
}: {
  approval: PendingApproval
  onDecide: (decision: 'approve' | 'deny', rememberForThread: boolean) => void
}) {
  const [remember, setRemember] = useState(false)
  const remaining = useCountdown(approval.deadline)
  const denyRef = useRef<HTMLButtonElement>(null)
  const expiredRef = useRef(false)

  const call = approval.toolCall
  const seconds = Math.ceil(remaining / 1000)
  const total = Math.max(1, approval.timeoutMs)
  const fraction = Math.max(0, Math.min(1, remaining / total))
  const urgent = remaining < 30_000

  // Истёк таймаут — сервер сам отклонит вызов, закрываем окно, чтобы человек
  // не жал по кнопке, которая уже ничего не решает.
  useEffect(() => {
    if (remaining > 0 || expiredRef.current) return
    expiredRef.current = true
    onDecide('deny', false)
  }, [remaining, onDecide])

  // Опасное действие: фокус по умолчанию на «Отклонить», не на «Разрешить».
  useEffect(() => {
    const timer = setTimeout(() => denyRef.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [])

  return (
    <Modal
      open
      // Закрыть «мимо» нельзя: решение обязано быть осознанным.
      dismissable={false}
      onClose={() => onDecide('deny', false)}
      width={860}
      title={
        <span className="flex items-center gap-2">
          {translate('agent.approval.title')}
          <Badge tone="yellow">{call.name}</Badge>
          {call.parsedFrom === 'content_json' && (
            <Badge
              tone="yellow"
              title={translate('agent.approval.inferred')}
            >
              {translate('agent.approval.fromText')}
            </Badge>
          )}
        </span>
      }
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <div className="min-w-0">
            <Toggle
              checked={remember}
              onChange={setRemember}
              label={translate('agent.approval.remember')}
              hint={translate('agent.approval.rememberHint', { tool: call.name })}
            />
          </div>
          <div className="flex shrink-0 gap-2">
            <Button ref={denyRef} variant="secondary" onClick={() => onDecide('deny', remember)}>
              {translate('agent.approval.deny')}
            </Button>
            <Button variant="primary" onClick={() => onDecide('approve', remember)}>
              {translate('agent.approval.allow')}
            </Button>
          </div>
        </div>
      }
    >
      {/* Отсчёт */}
      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-2xs text-secondary">
            {translate('agent.approval.timeout')}
          </span>
          <span
            className={cx(
              'font-mono text-xs font-semibold tabular-nums',
              urgent ? 'text-danger' : 'text-secondary',
            )}
            role="timer"
            aria-live="off"
          >
            {formatDuration(seconds * 1000)}
          </span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-inset">
          <div
            className="h-full rounded-full transition-[width] duration-200 ease-linear"
            style={{
              width: `${fraction * 100}%`,
              background: urgent ? 'var(--danger)' : 'var(--color-fit-yellow)',
            }}
          />
        </div>
      </div>

      {/* Дифф — то, ради чего это окно вообще существует */}
      {call.diff ? (
        <div className="mb-3">
          <p className="mb-1.5 text-2xs text-secondary">
            {translate('agent.approval.writePath', { path: call.diff.path })}
          </p>
          <DiffViewer diff={call.diff} maxHeight={380} />
        </div>
      ) : (
        <p className="mb-3 text-2xs text-secondary">
          {translate('agent.approval.nonFile')}
        </p>
      )}

      {/* Аргументы */}
      <div>
        <div className="mb-1 text-2xs font-medium text-secondary">
          {translate('agent.approval.arguments')}
        </div>
        <pre className="max-h-40 overflow-auto rounded border border-divider bg-inset p-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap">
          {formatArguments(call.arguments)}
        </pre>
      </div>
    </Modal>
  )
}
