/**
 * Проверка состояния сервиса при старте.
 *
 * Явное требование: если Ollama не установлена или не запущена — понятный экран
 * с командой из `installHint`, а не пустота и не белый экран.
 */
import type { Health } from '@alamo/contract'
import { Button, Callout, CopyButton, Spinner, Stat } from '../../components/ui.tsx'
import { errorMessage } from '../../lib/api.ts'
import { formatBytes, formatDateTime } from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'

export function ollamaHealthState(health: Health): 'reachable' | 'unavailable' | 'incompatible' {
  return health.ollama.state ?? (health.ollama.running ? 'reachable' : 'unavailable')
}

export function HealthLoading() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <div className="flex items-center gap-2 text-xs text-[var(--fg-muted)]">
        <Spinner size={14} />
        Проверяем Ollama…
      </div>
    </div>
  )
}

/** Сервер Alamo не ответил вообще — до Ollama дело не дошло. */
export function HealthUnreachable({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Centered
      title="Сервер Alamo не отвечает"
      description="Интерфейс запущен, но локальный сервер приложения недоступен."
    >
      <Callout tone="danger" title="Что произошло">
        {errorMessage(error)}
      </Callout>

      <div className="mt-3">
        <p className="mb-1.5 text-xs text-[var(--fg-muted)]">Запустите сервер и повторите:</p>
        <CommandBlock command="npx alamo-ui" />
      </div>

      <div className="mt-4 flex justify-end">
        <Button variant="primary" onClick={onRetry}>
          Проверить снова
        </Button>
      </div>
    </Centered>
  )
}

export function OllamaHealthNotice({
  health,
  onRetry,
  retrying,
}: {
  health: Health
  onRetry: () => void
  retrying: boolean
}) {
  const state = ollamaHealthState(health)
  if (state === 'reachable') return null

  const incompatible = state === 'incompatible'
  return (
    <div className="px-3 pt-3" role={incompatible ? 'alert' : 'status'} aria-live="polite">
      <Callout
        tone={incompatible ? 'danger' : 'warning'}
        title={translate(
          incompatible
            ? 'health.ollama.incompatible.title'
            : 'health.ollama.unavailable.title',
        )}
        action={
          <Button
            size="sm"
            onClick={onRetry}
            loading={retrying}
            className="min-h-11 sm:min-h-0"
          >
            {translate('health.retry')}
          </Button>
        }
      >
        <p>
          {translate(
            incompatible
              ? 'health.ollama.incompatible.summary'
              : 'health.ollama.unavailable.summary',
          )}
        </p>
        <p className="mt-1 text-2xs">
          {translate('health.source')}: {health.ollama.source ?? '—'}
          {' · '}
          {translate('health.observedAt')}:{' '}
          {health.ollama.observedAt ? formatDateTime(health.ollama.observedAt) : '—'}
        </p>
      </Callout>
    </div>
  )
}

/** Ollama не установлена или не запущена. */
export function OllamaUnavailable({
  health,
  onRetry,
  retrying,
}: {
  health: Health
  onRetry: () => void
  retrying: boolean
}) {
  const { ollama, hardware } = health
  const notInstalled = !ollama.installed

  return (
    <Centered
      title={notInstalled ? 'Ollama не установлена' : 'Ollama не запущена'}
      description={
        notInstalled
          ? 'Alamo — интерфейс поверх Ollama. Без неё запускать модели негде.'
          : 'Ollama установлена, но сервис сейчас не отвечает.'
      }
    >
      <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] p-2.5">
        <Stat label="Адрес" value={ollama.host} />
        <Stat label="Версия" value={ollama.version ?? 'неизвестна'} />
        <Stat label="Установлена" value={ollama.installed ? 'да' : 'нет'} />
        <Stat label="Запущена" value={ollama.running ? 'да' : 'нет'} />
      </div>

      {ollama.installHint ? (
        <div>
          <p className="mb-1.5 text-xs text-[var(--fg-muted)]">
            {notInstalled ? 'Установите Ollama:' : 'Запустите сервис:'}
          </p>
          <CommandBlock command={ollama.installHint.command} />
          <a
            href={ollama.installHint.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-2xs text-[var(--accent)] underline underline-offset-2"
          >
            Документация Ollama
          </a>
        </div>
      ) : (
        <Callout tone="neutral" title="Подсказка по установке недоступна">
          Сервер не смог определить команду для этой системы. Загляните на ollama.com.
        </Callout>
      )}

      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-2xs text-[var(--fg-subtle)]">
          {hardware.acceleratorName ?? hardware.accelerator} ·{' '}
          {formatBytes(hardware.usableMemoryBytes)} доступно
        </span>
        <Button variant="primary" onClick={onRetry} loading={retrying}>
          Проверить снова
        </Button>
      </div>
    </Centered>
  )
}

function CommandBlock({ command }: { command: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-inset)] py-1.5 pr-1.5 pl-2.5">
      <code className="truncate font-mono text-xs select-all">{command}</code>
      <CopyButton text={command} />
    </div>
  )
}

function Centered({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-5">
      <div className="surface w-full max-w-lg rounded-xl p-5 shadow-[var(--shadow-card)]">
        <h1 className="text-base font-semibold">{title}</h1>
        {description && <p className="mt-1 mb-4 text-xs text-[var(--fg-muted)]">{description}</p>}
        {children}
      </div>
    </div>
  )
}
