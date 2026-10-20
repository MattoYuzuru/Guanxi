/*
 * Adapted from shadcn/ui (base) apps/v4/registry/bases/base/ui/dialog.tsx
 * @ ba1503c64472b82256d9de95e2e62c5901a38e8b, MIT, Copyright (c) 2023 shadcn.
 * Modified by Guanxi contributors: portal container, strong glass with an unblurred ink scrim,
 * localized close label, Lucide icon, semantic-token CSS.
 */
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import type { ComponentProps } from 'react'
import { useUiText } from '../../i18n/context.tsx'
import { cx } from '../../lib/cx.ts'
import { usePortalContainer } from '../../lib/portal.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip/tooltip.tsx'
import '../button/button.css'
import '../icon-button/icon-button.css'
import './dialog.css'

type WithClassName<T> = Omit<T, 'className'> & { className?: string }

export type DialogProps = ComponentProps<typeof DialogPrimitive.Root>
export type DialogTriggerProps = ComponentProps<typeof DialogPrimitive.Trigger>
export type DialogCloseProps = ComponentProps<typeof DialogPrimitive.Close>
export type DialogTitleProps = WithClassName<ComponentProps<typeof DialogPrimitive.Title>>
export type DialogDescriptionProps = WithClassName<ComponentProps<typeof DialogPrimitive.Description>>
export type DialogFooterProps = WithClassName<ComponentProps<'div'>>

export interface DialogContentProps extends WithClassName<ComponentProps<typeof DialogPrimitive.Popup>> {
  /** Renders the corner close button; on by default so touch users can always leave. */
  showCloseButton?: boolean
}

export function Dialog(props: DialogProps) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

export function DialogTrigger(props: DialogTriggerProps) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

export function DialogClose(props: DialogCloseProps) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

export function DialogContent({
  showCloseButton = true,
  className,
  children,
  ...props
}: DialogContentProps) {
  const t = useUiText()
  const container = usePortalContainer()
  return (
    <DialogPrimitive.Portal container={container}>
      <DialogPrimitive.Backdrop className="gx-dialog-backdrop" />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cx('gx-dialog gx-glass gx-glass-strong', className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <Tooltip>
            <TooltipTrigger
              render={
                <DialogPrimitive.Close
                  data-variant="ghost"
                  data-size="sm"
                  aria-label={t('ui.dialog.close')}
                  className="gx-button gx-icon-button gx-focusable gx-dialog-close"
                />
              }
            >
              <span className="gx-icon-button-glyph" aria-hidden="true">
                <X />
              </span>
            </TooltipTrigger>
            <TooltipContent>{t('ui.dialog.close')}</TooltipContent>
          </Tooltip>
        )}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}

export function DialogTitle({ className, ...props }: DialogTitleProps) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cx('gx-dialog-title', className)}
      {...props}
    />
  )
}

export function DialogDescription({ className, ...props }: DialogDescriptionProps) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cx('gx-dialog-description', className)}
      {...props}
    />
  )
}

export function DialogFooter({ className, ...props }: DialogFooterProps) {
  return <div data-slot="dialog-footer" className={cx('gx-dialog-footer', className)} {...props} />
}
