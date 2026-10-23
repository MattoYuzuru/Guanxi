/**
 * Примитивы UI. Копируем себе только то, что реально используем (shadcn-подход),
 * без зависимости от UI-кита.
 */
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import type { FitLevel } from '@guanxi/contract'
import { Button as UiButton, Icon, Switch } from '@guanxi/ui'
import { translate, type LocaleKey } from '../lib/locale.ts'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/* ─────────────────────────────── Кнопка ───────────────────────────────── */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: ReactNode
}

/**
 * Legacy entry point kept for existing features. It draws the design-system button look
 * (D-200) through `.legacy-button`, which lives in the components layer of index.css, so the
 * sizing and spacing utilities legacy callers pass (min-h-11 for phone targets, w-full…) still
 * win, as they did before the redesign.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    icon,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-variant={variant}
      data-size={size}
      className={cx('legacy-button', className)}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 10 : 12} /> : icon}
      {children}
    </button>
  )
})

export function Spinner({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx('anim-spin inline-block shrink-0 rounded-full border-current', className)}
      style={{
        width: size,
        height: size,
        borderWidth: Math.max(1, Math.round(size / 8)),
        borderTopColor: 'transparent',
      }}
    />
  )
}

/* ─────────────────────────────── Бейджи ───────────────────────────────── */

export function Badge({
  children,
  tone = 'neutral',
  title,
  className,
}: {
  children: ReactNode
  tone?: 'neutral' | 'accent' | 'green' | 'yellow' | 'red' | 'outline'
  title?: string
  className?: string
}) {
  return (
    <span title={title} data-tone={tone} className={cx('legacy-badge', className)}>
      {children}
    </span>
  )
}

/* ─────────────────── Цвета вердикта влезаемости ───────────────────────── */

export const FIT_TONE: Record<FitLevel, 'green' | 'yellow' | 'red' | 'neutral'> = {
  green: 'green',
  yellow: 'yellow',
  red: 'red',
  unknown: 'neutral',
}

export const FIT_COLOR_VAR: Record<FitLevel, string> = {
  green: 'var(--color-fit-green)',
  yellow: 'var(--color-fit-yellow)',
  red: 'var(--color-fit-red)',
  unknown: 'var(--color-fit-unknown)',
}

export function fitLabel(level: FitLevel): string {
  const keys = {
    green: 'fit.level.green',
    yellow: 'fit.level.yellow',
    red: 'fit.level.red',
    unknown: 'fit.level.unknown',
  } satisfies Record<FitLevel, LocaleKey>
  return translate(keys[level])
}

/* ────────────────────────────── Шкала ─────────────────────────────────── */

export function Meter({
  value,
  tone = 'var(--accent)',
  height = 6,
  className,
  label,
  /** Отметка на шкале — например, граница 100 % при переполнении. */
  marker,
}: {
  value: number
  tone?: string
  height?: number
  className?: string
  label?: string
  marker?: number
}) {
  const clamped = Math.max(0, Math.min(1, value))

  return (
    <div
      className={cx('relative w-full overflow-hidden rounded-full bg-inset', className)}
      style={{ height }}
      role="meter"
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className="h-full rounded-full transition-[width] duration-300 ease-out"
        style={{ width: `${clamped * 100}%`, background: tone }}
      />
      {marker !== undefined && marker > 0 && marker < 1 && (
        <div
          className="absolute inset-y-0 w-px bg-muted/60"
          style={{ left: `${marker * 100}%` }}
        />
      )}
    </div>
  )
}

/* ────────────────────────────── Тумблер ───────────────────────────────── */

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
  hint,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label: string
  hint?: string
}) {
  const hintId = useId()
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <Switch label={<span className="text-13 font-label">{label}</span>} checked={checked}
        onCheckedChange={onChange} disabled={disabled} aria-describedby={hint ? hintId : undefined} />
      {hint && <p id={hintId} className="m-0 max-w-xs text-12 text-muted">{hint}</p>}
    </div>
  )
}

/* ────────────────────────────── Поля ввода ────────────────────────────── */

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string
  hint?: string
  children: ReactNode
  htmlFor?: string
}) {
  return (
    <div className="py-1.5">
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-2xs text-muted">{hint}</p>}
    </div>
  )
}

const INPUT_CLASS = 'legacy-input'

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(INPUT_CLASS, className)} {...rest} />
})

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(INPUT_CLASS, 'resize-none', className)} {...rest} />
})

export function Select({
  value,
  onChange,
  options,
  className,
  disabled,
  ariaLabel,
  /** Required whenever a visible `<label htmlFor>` names this control. */
  id,
  describedBy,
}: {
  value: string
  onChange: (next: string) => void
  options: Array<{ value: string; label: string; disabled?: boolean; group?: string; groupId?: string }>
  className?: string
  disabled?: boolean
  ariaLabel?: string
  id?: string
  /** Ids of the hint and error text that describe this control. */
  describedBy?: string
}) {
  return (
    <select
      id={id}
      aria-describedby={describedBy}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
      className={cx(INPUT_CLASS, 'cursor-pointer appearance-none pr-6', className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%23888' stroke-width='1.4' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\")",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 4px center',
        backgroundSize: '12px',
      }}
    >
      {[...new Set(options.map(option => option.groupId ?? option.group))].map(groupId => options.find(option => (option.groupId ?? option.group) === groupId)?.group ? (
        <optgroup key={groupId} label={options.find(option => (option.groupId ?? option.group) === groupId)!.group!}>
          {options.filter(option => (option.groupId ?? option.group) === groupId).map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
        </optgroup>
      ) : options.filter(option => !option.group).map(option => (
        <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
      )))}
    </select>
  )
}

/* ─────────────────────────────── Слайдер ──────────────────────────────── */

/**
 * Слайдер по дискретному списку значений (размеры окна — степени двойки).
 * Работает индексом, поэтому шаги равномерны визуально при неравномерных значениях.
 */
export function StepSlider({
  values,
  value,
  onChange,
  format,
  label,
  disabled,
}: {
  values: number[]
  value: number
  onChange: (next: number) => void
  format: (value: number) => string
  label: string
  disabled?: boolean
}) {
  const index = Math.max(0, values.indexOf(value))

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium">{label}</span>
        <span className="font-mono text-xs tabular-nums text-secondary">
          {format(value)}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={Math.max(0, values.length - 1)}
        step={1}
        value={index}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={format(value)}
        onChange={(event) => {
          const next = values[Number(event.target.value)]
          if (next !== undefined) onChange(next)
        }}
        className="w-full accent-accent"
      />
      <div className="mt-0.5 flex justify-between text-2xs text-muted">
        <span>{format(values[0] ?? 0)}</span>
        <span>{format(values[values.length - 1] ?? 0)}</span>
      </div>
    </div>
  )
}

/* ─────────────────────────────── Модалка ──────────────────────────────── */

/**
 * Модалка с ловушкой фокуса. Реализовано вручную: Escape, возврат фокуса на
 * элемент-инициатор, Tab по кругу внутри диалога.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 560,
  /** Закрытие по клику вне и по Escape. Для решений с таймаутом выключаем. */
  dismissable = true,
  labelledBy,
  describedBy,
  initialFocusRef,
  returnFocusRef,
  closeLabel = translate('common.close'),
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: number
  dismissable?: boolean
  labelledBy?: string
  describedBy?: string
  initialFocusRef?: React.RefObject<HTMLElement | null>
  returnFocusRef?: React.RefObject<HTMLElement | null>
  closeLabel?: string
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const headingId = useId()

  useEffect(() => {
    if (!open) return

    restoreFocusRef.current = document.activeElement as HTMLElement | null

    // Фокус внутрь: первый интерактивный элемент, иначе сам контейнер.
    const node = dialogRef.current
    const focusable = node ? collectFocusable(node) : []
    ;(initialFocusRef?.current ?? focusable[0] ?? node)?.focus()

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const overlay = overlayRef.current
    const inerted = Array.from(document.body.children)
      .filter((element) => element !== overlay)
      .map((element) => ({
        element,
        inert: element.hasAttribute('inert'),
        ariaHidden: element.getAttribute('aria-hidden'),
      }))
    for (const entry of inerted) {
      entry.element.setAttribute('inert', '')
      entry.element.setAttribute('aria-hidden', 'true')
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissable) {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !node) return

      const items = collectFocusable(node)
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const first = items[0] as HTMLElement
      const last = items[items.length - 1] as HTMLElement
      const active = document.activeElement

      // Заворачиваем Tab внутри диалога, чтобы фокус не ушёл на фон.
      if (event.shiftKey && (active === first || !node.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = previousOverflow
      for (const entry of inerted) {
        if (!entry.inert) entry.element.removeAttribute('inert')
        if (entry.ariaHidden === null) entry.element.removeAttribute('aria-hidden')
        else entry.element.setAttribute('aria-hidden', entry.ariaHidden)
      }
      ;(returnFocusRef?.current ?? restoreFocusRef.current)?.focus?.()
    }
  }, [open, dismissable, onClose, initialFocusRef, returnFocusRef])

  if (!open) return null

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-start justify-center legacy-scrim p-2 pt-[min(8vh,3rem)] backdrop-blur-[2px] sm:p-4 sm:pt-[min(8vh,3rem)]"
      onMouseDown={(event) => {
        if (dismissable && event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? (title ? headingId : undefined)}
        aria-describedby={describedBy}
        tabIndex={-1}
        className="legacy-modal flex max-h-[calc(100dvh-1rem)] w-full min-w-0 flex-col overflow-hidden outline-none sm:max-h-[calc(100dvh-2rem)]"
        style={{ maxWidth: width }}
      >
        {title && (
          <div className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-2.5">
            <h2 id={headingId} className="text-15 font-heading">
              {title}
            </h2>
            {dismissable && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
                aria-label={closeLabel}
                className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0"
                icon={<Icon name="close" />}
              />
            )}
          </div>
        )}
        <div className="min-h-0 min-w-0 overflow-y-auto px-4 py-3">{children}</div>
        {footer && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-hairline px-4 py-2.5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function collectFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.offsetParent !== null || element === document.activeElement,
  )
}

/* ──────────────────────── Раскрывающийся блок ─────────────────────────── */

export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className,
  tone,
}: {
  summary: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  className?: string
  tone?: string
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className={className}>
      <UiButton
        variant="ghost"
        size="sm"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-2xs font-medium text-secondary hover:text-foreground"
        style={tone ? { color: tone } : undefined}
      >
        <Chevron open={open} />
        {summary}
      </UiButton>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  )
}

export function Chevron({ open, size = 10 }: { open: boolean; size?: number }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 12 12"
      className="shrink-0 transition-transform duration-150"
      style={{ transform: open ? 'rotate(90deg)' : 'none' }}
    >
      <path d="M4 2.5L8 6L4 9.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/* ──────────────────────────── Служебные блоки ─────────────────────────── */

export function CopyButton({
  text,
  size = 'sm',
  label = translate('common.copy'),
}: {
  text: string
  size?: ButtonSize
  label?: string
}) {
  const [copied, setCopied] = useState(false)

  return (
    <Button
      variant="ghost"
      size={size}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        } catch {
          // Без https/разрешения буфер недоступен — молчим, кнопка просто не сработает.
        }
      }}
      aria-label={label}
      title={label}
    >
      {copied ? translate('common.copied') : label}
    </Button>
  )
}

export function Callout({
  tone = 'neutral',
  title,
  children,
  action,
}: {
  tone?: 'neutral' | 'warning' | 'danger' | 'info'
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div data-tone={tone} className="legacy-callout">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {title && <div className="text-13 font-heading">{title}</div>}
          {children && <div className="mt-0.5 text-12 text-secondary">{children}</div>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <p className="m-0 text-14 font-label">{title}</p>
      {description && (
        <p className="m-0 max-w-md text-13 text-muted">{description}</p>
      )}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cx('rounded-control bg-inset', className)}
      aria-hidden
    />
  )
}

/** Пара «подпись — значение». Основной строительный блок плотных панелей. */
export function Stat({
  label,
  value,
  hint,
  tone,
  mono = true,
}: {
  label: ReactNode
  value: ReactNode
  hint?: string
  tone?: string
  mono?: boolean
}) {
  return (
    <div className="min-w-0" title={hint}>
      <div className="truncate text-2xs text-muted">{label}</div>
      <div
        className={cx('truncate text-xs font-medium', mono && 'font-mono tabular-nums')}
        style={tone ? { color: tone } : undefined}
      >
        {value}
      </div>
    </div>
  )
}
