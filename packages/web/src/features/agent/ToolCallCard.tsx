/**
 * Карточка вызова инструмента в таймлайне агента.
 *
 * Отдельно показываем `parsedFrom`: у слабых локальных моделей вызов часто
 * вытаскивается из текста, а не приходит структурно. Пользователю полезно
 * понимать, что именно произошло, когда агент «промахнулся» аргументами.
 */
import { useState } from 'react'
import type { ToolCall, ToolCallStatus } from '@guanxi/contract'
import { Badge, Chevron, CopyButton, Spinner, cx } from '../../components/ui.tsx'
import { formatDuration } from '../../lib/format.ts'
import { translate, type LocaleKey } from '../../lib/locale.ts'
import { DiffViewer } from './DiffViewer.tsx'

const STATUS_META: Record<
  ToolCallStatus,
  { label: LocaleKey; tone: 'neutral' | 'accent' | 'green' | 'yellow' | 'red'; spinning?: boolean }
> = {
  pending_approval: { label: 'agent.tool.status.pending', tone: 'yellow' },
  running: { label: 'agent.tool.status.running', tone: 'accent', spinning: true },
  ok: { label: 'agent.tool.status.ok', tone: 'green' },
  error: { label: 'agent.tool.status.error', tone: 'red' },
  denied: { label: 'agent.tool.status.denied', tone: 'red' },
  cancelled: { label: 'agent.tool.status.cancelled', tone: 'neutral' },
}

const PARSED_FROM_META = {
  native: {
    label: 'agent.tool.parsed.native' as LocaleKey,
    hint: 'agent.tool.parsed.nativeHint' as LocaleKey,
  },
  content_json: {
    label: 'agent.tool.parsed.text' as LocaleKey,
    hint: 'agent.tool.parsed.textHint' as LocaleKey,
  },
} as const

export function ToolCallCard({
  call,
  defaultOpen = false,
}: {
  call: ToolCall
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen || call.status === 'pending_approval')
  const status = STATUS_META[call.status]
  const parsed = PARSED_FROM_META[call.parsedFrom]
  const argumentsText = formatArguments(call.arguments)

  return (
    <div
      className={cx(
        'overflow-hidden rounded-lg border',
        call.status === 'error' || call.status === 'denied'
          ? 'border-[var(--danger)]/40'
          : 'border-divider',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 bg-inset px-2 py-1.5 text-left hover:bg-inset"
      >
        <Chevron open={open} />
        {status.spinning && <Spinner size={10} />}
        <span className="font-mono text-2xs font-semibold">{call.name}</span>

        <Badge tone={status.tone}>{translate(status.label)}</Badge>

        <Badge
          tone={call.parsedFrom === 'content_json' ? 'yellow' : 'outline'}
          title={translate(parsed.hint)}
        >
          {translate(parsed.label)}
        </Badge>

        {call.source === 'mcp' && (
          <Badge tone="outline" title={translate('agent.tool.mcp')}>
            mcp
          </Badge>
        )}

        {call.diff && (
          <Badge tone="accent" title={translate('agent.tool.diff')}>
            {translate('agent.tool.diffBadge')}
          </Badge>
        )}

        <span className="ml-auto shrink-0 font-mono text-2xs text-secondary tabular-nums">
          {call.durationMs !== null ? formatDuration(call.durationMs) : ''}
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-divider p-2">
          {call.parsedFrom === 'content_json' && (
            <p className="rounded border border-[var(--color-fit-yellow)]/30 bg-[var(--color-fit-yellow)]/8 px-2 py-1 text-2xs text-[var(--color-fit-yellow)]">
              {translate(parsed.hint)}
            </p>
          )}

          <Section title={translate('agent.tool.arguments')} copy={argumentsText}>
            <pre className="max-h-56 overflow-auto rounded border border-divider bg-inset p-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap">
              {argumentsText}
            </pre>
          </Section>

          {call.diff && (
            <div>
              <div className="mb-1 text-2xs font-medium text-secondary">
                {translate('agent.tool.changes')}
              </div>
              <DiffViewer diff={call.diff} maxHeight={320} />
            </div>
          )}

          {call.result !== null && call.result !== '' && (
            <Section title={translate('agent.tool.result')} copy={call.result}>
              <pre className="max-h-56 overflow-auto rounded border border-divider bg-inset p-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap">
                {call.result}
              </pre>
            </Section>
          )}

          {call.error && (
            <Section title={translate('agent.tool.error')} copy={call.error}>
              <pre className="max-h-40 overflow-auto rounded border border-[var(--danger)]/40 bg-[var(--danger)]/8 p-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-danger">
                {call.error}
              </pre>
            </Section>
          )}
        </div>
      )}
    </div>
  )
}

function Section({
  title,
  copy,
  children,
}: {
  title: string
  copy?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-2xs font-medium text-secondary">{title}</span>
        {copy && <CopyButton text={copy} />}
      </div>
      {children}
    </div>
  )
}

export function formatArguments(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}
