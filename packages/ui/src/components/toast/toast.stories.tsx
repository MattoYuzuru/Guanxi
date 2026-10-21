import { useEffect, useRef, useState } from 'react'
import type { UiMessageKey } from '../../i18n/messages.ts'
import { useUiText } from '../../i18n/context.tsx'
import type { Story, StoryMeta } from '../../story-kit/index.tsx'
import { Toaster, createToastManager, type ToastTone, type ToasterProps } from './toast.tsx'

const COPY: Record<ToastTone, [UiMessageKey, UiMessageKey]> = {
  info: ['story.toast.infoTitle', 'story.toast.infoBody'],
  success: ['story.toast.successTitle', 'story.toast.successBody'],
  warning: ['story.toast.warningTitle', 'story.toast.warningBody'],
  error: ['story.toast.errorTitle', 'story.toast.errorBody'],
}

function ToastStory({ tone, withAction = false }: { tone: ToastTone; withAction?: boolean }) {
  const t = useUiText()
  const [manager] = useState(createToastManager)
  const added = useRef<string | null>(null)
  const [title, body] = COPY[tone]
  useEffect(() => {
    const options = {
      type: tone,
      title: t(title),
      description: t(body),
      timeout: 0,
      priority: tone === 'error' ? ('high' as const) : ('low' as const),
      ...(withAction ? { actionProps: { children: t('story.toast.action') } } : {}),
    }
    if (added.current) manager.update(added.current, options)
    else added.current = manager.add(options)
  }, [manager, t, tone, title, body, withAction])
  return <Toaster manager={manager} />
}

const meta = {
  title: 'Primitives/Toast',
  component: Toaster,
  parameters: { guanxi: { frame: 'overlay' } },
} satisfies StoryMeta<ToasterProps>

export default meta

export const InfoTone: Story<ToasterProps> = { name: 'info', render: () => <ToastStory tone="info" /> }

export const SuccessTone: Story<ToasterProps> = {
  name: 'success',
  render: () => <ToastStory tone="success" />,
}

export const WarningTone: Story<ToasterProps> = {
  name: 'warning',
  render: () => <ToastStory tone="warning" />,
}

export const ErrorTone: Story<ToasterProps> = { name: 'error', render: () => <ToastStory tone="error" /> }

export const WithAction: Story<ToasterProps> = {
  name: 'with-action',
  render: () => <ToastStory tone="info" withAction />,
}
