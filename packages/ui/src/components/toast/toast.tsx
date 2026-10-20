/*
 * Adapted from shadcn/ui (base) apps/v4/registry/bases/base/ui/toast.tsx
 * @ ba1503c64472b82256d9de95e2e62c5901a38e8b, MIT, Copyright (c) 2023 shadcn.
 * Modified by Guanxi contributors: at most two toasts (D-136), glass material, flow layout
 * instead of the stacked deck, typed tones with icon and title (never colour alone), portal
 * container, localized close label, semantic-token CSS.
 */
import { Toast as ToastPrimitive } from '@base-ui/react/toast'
import { CircleCheck, Info, OctagonX, TriangleAlert, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useUiText } from '../../i18n/context.tsx'
import { usePortalContainer } from '../../lib/portal.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip/tooltip.tsx'
import '../button/button.css'
import '../icon-button/icon-button.css'
import './toast.css'

export type ToastTone = 'info' | 'success' | 'warning' | 'error'
export type ToastManager = ReturnType<typeof ToastPrimitive.createToastManager>

/** A toast manager for code outside React (for example a notification bridge). */
export const createToastManager: () => ToastManager = ToastPrimitive.createToastManager

/** Adds, updates and closes toasts from inside a Toaster. Use `type` for the tone. */
export const useToast = ToastPrimitive.useToastManager

export interface ToasterProps {
  /** Shared manager; omit to use the provider's own. */
  manager?: ToastManager
  /** D-136: at most two toasts at once while the app is focused. */
  limit?: number
  /** Default auto-dismiss in ms; 0 keeps toasts until dismissed. */
  timeout?: number
  children?: ReactNode
}

const ICONS: Record<ToastTone, ReactNode> = {
  info: <Info aria-hidden="true" />,
  success: <CircleCheck aria-hidden="true" />,
  warning: <TriangleAlert aria-hidden="true" />,
  error: <OctagonX aria-hidden="true" />,
}

function toneOf(type: string | undefined): ToastTone {
  return type === 'success' || type === 'warning' || type === 'error' ? type : 'info'
}

function ToastList() {
  const t = useUiText()
  const { toasts } = ToastPrimitive.useToastManager()
  return toasts.map((item) => {
    const tone = toneOf(item.type)
    return (
      <ToastPrimitive.Root key={item.id} toast={item} data-tone={tone} className="gx-toast gx-glass">
        <span className="gx-toast-icon">{ICONS[tone]}</span>
        <ToastPrimitive.Content className="gx-toast-content">
          <ToastPrimitive.Title className="gx-toast-title" />
          <ToastPrimitive.Description className="gx-toast-description" />
          {item.actionProps ? (
            <ToastPrimitive.Action
              className="gx-button gx-focusable gx-toast-action"
              data-variant="secondary"
              data-size="sm"
            />
          ) : null}
        </ToastPrimitive.Content>
        <Tooltip>
          <TooltipTrigger
            render={
              <ToastPrimitive.Close
                aria-label={t('ui.toast.close')}
                data-variant="ghost"
                data-size="sm"
                className="gx-button gx-icon-button gx-focusable"
              />
            }
          >
            <span className="gx-icon-button-glyph" aria-hidden="true">
              <X />
            </span>
          </TooltipTrigger>
          <TooltipContent>{t('ui.toast.close')}</TooltipContent>
        </Tooltip>
      </ToastPrimitive.Root>
    )
  })
}

export function Toaster({ manager, limit = 2, timeout = 5000, children }: ToasterProps) {
  const t = useUiText()
  const container = usePortalContainer()
  return (
    <ToastPrimitive.Provider toastManager={manager} limit={limit} timeout={timeout}>
      {children}
      <ToastPrimitive.Portal container={container}>
        <ToastPrimitive.Viewport className="gx-toast-viewport" aria-label={t('ui.toast.region')}>
          <ToastList />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  )
}
