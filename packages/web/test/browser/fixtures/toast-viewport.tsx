// GPT N7: the Toaster as a product screen mounts it, portalled to document.body (no catalog
// frame), with a toast that has an action and a close button.
import { createToastManager, Toaster, UiLocaleProvider } from '@guanxi/ui'
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../src/index.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing fixture root')

const manager = createToastManager()

// The parent adds after its children mounted, so the provider has subscribed to the manager.
function Notify() {
  useEffect(() => {
    manager.add({
      type: 'error',
      title: 'Model download failed',
      description: 'The connection to the registry closed before the last layer arrived.',
      timeout: 0,
      actionProps: { children: 'Retry' },
    })
  }, [])
  return <Toaster manager={manager} timeout={0} />
}

createRoot(root).render(
  <UiLocaleProvider locale="en">
    <Notify />
  </UiLocaleProvider>,
)
