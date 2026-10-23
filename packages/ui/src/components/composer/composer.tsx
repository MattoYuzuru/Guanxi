/*
 * Guanxi pattern (D-207): the prompt composer. A growing text area with a footer: the leading
 * slot (lower left) holds the permission mode, the trailing slot (lower right) holds model,
 * effort and context controls, then Send — or Stop while a run is active. The host decides the
 * layout: `centered` for an empty session, `docked` at the bottom after the first prompt.
 * Enter sends, Shift+Enter adds a line, and IME composition never sends.
 */
import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { useLayoutEffect, useRef, type ComponentProps, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useUiText } from '../../i18n/context.tsx'
import { cx } from '../../lib/cx.ts'
import { Icon } from '../icon/icon.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip/tooltip.tsx'
import '../button/button.css'
import '../icon-button/icon-button.css'
import './composer.css'

export interface ComposerProps extends Omit<ComponentProps<'form'>, 'className' | 'onSubmit' | 'children'> {
  value: string
  onValueChange: (value: string) => void
  /** Called on Enter or Send when sending is allowed. */
  onSend: () => void
  /** Shown while `running`; Send becomes Stop. */
  onStop?: () => void
  running?: boolean
  /** Disables the whole composer (no node, no session). */
  disabled?: boolean
  /** Blocks sending but keeps typing; pass the reason so the host can describe it. */
  sendDisabled?: boolean
  /** Accessible name of the text area. */
  label: string
  placeholder?: string
  layout?: 'centered' | 'docked'
  /** Lower-left controls: the simplified permission mode. */
  leading?: ReactNode
  /** Lower-right controls before Send: model, effort, context. */
  trailing?: ReactNode
  /** Above the text area: attachments or chips for non-default options. */
  header?: ReactNode
  /** Id of an element that explains why sending is blocked. */
  describedBy?: string
  autoFocus?: boolean
  textareaId?: string
  sendLabel?: string
  stopLabel?: string
  className?: string
}

export function Composer({
  value,
  onValueChange,
  onSend,
  onStop,
  running = false,
  disabled = false,
  sendDisabled = false,
  label,
  placeholder,
  layout = 'docked',
  leading,
  trailing,
  header,
  describedBy,
  autoFocus,
  textareaId,
  sendLabel,
  stopLabel,
  className,
  ...props
}: ComposerProps) {
  const t = useUiText()
  const area = useRef<HTMLTextAreaElement>(null)
  const canSend = !disabled && !sendDisabled && !running && value.trim().length > 0

  // Grow with the content up to the CSS max-height; no layout shift while typing one line.
  useLayoutEffect(() => {
    const element = area.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [value, layout])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (canSend) onSend()
  }
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    if (canSend) onSend()
  }
  const actionLabel = running ? stopLabel ?? t('ui.composer.stop') : sendLabel ?? t('ui.composer.send')

  return (
    <form
      data-slot="composer"
      data-layout={layout}
      data-disabled={disabled || undefined}
      data-running={running || undefined}
      className={cx('gx-composer', className)}
      onSubmit={submit}
      noValidate
      {...props}
    >
      {header ? <div className="gx-composer-header">{header}</div> : null}
      <textarea
        ref={area}
        id={textareaId}
        className="gx-composer-input"
        aria-label={label}
        aria-describedby={describedBy}
        placeholder={placeholder}
        value={value}
        rows={1}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={keyDown}
      />
      <div className="gx-composer-footer">
        <div className="gx-composer-leading">{leading}</div>
        <div className="gx-composer-trailing">
          {trailing}
          <Tooltip>
            <TooltipTrigger
              render={
                <ButtonPrimitive
                  type={running ? 'button' : 'submit'}
                  data-slot="composer-action"
                  data-variant={running ? 'secondary' : 'primary'}
                  aria-label={actionLabel}
                  aria-describedby={running ? undefined : describedBy}
                  disabled={running ? !onStop : !canSend}
                  focusableWhenDisabled={!running}
                  onClick={running ? () => onStop?.() : undefined}
                  className="gx-button gx-icon-button gx-composer-action gx-focusable"
                />
              }
            >
              <span className="gx-icon-button-glyph" aria-hidden="true">
                <Icon name={running ? 'stop' : 'send'} size={16} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">{actionLabel}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </form>
  )
}
