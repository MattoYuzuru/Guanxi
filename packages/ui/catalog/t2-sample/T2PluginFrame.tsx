import { useEffect, useRef } from 'react'
import { readHostVariables } from './mcp-apps-variables.ts'
import { T2_PLUGIN_DOCUMENT } from './plugin-document.ts'

type HostTheme = 'light' | 'dark'

/**
 * Host side of the MCP Apps handshake for one sandboxed plugin view. Theme changes are sent
 * as `ui/notifications/host-context-changed` only after the view reported `initialized`.
 */
export function T2PluginFrame({
  hostTheme,
  regimeKey,
  title,
}: {
  hostTheme: HostTheme
  /** Changes whenever the host's resolved variables may have changed. */
  regimeKey: string
  title: string
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const initialized = useRef(false)
  const latest = useRef({ hostTheme })
  latest.current = { hostTheme }

  const hostContext = () => {
    const element = frame.current?.parentElement
    return {
      theme: latest.current.hostTheme,
      styles: { variables: element ? readHostVariables(element) : {} },
    }
  }

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow
      if (!target || event.source !== target) return
      const message = event.data as { jsonrpc?: string; id?: number; method?: string }
      if (message?.jsonrpc !== '2.0') return
      if (message.method === 'ui/initialize' && typeof message.id === 'number') {
        target.postMessage(
          {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2026-01-26',
              hostCapabilities: {},
              hostInfo: { name: 'guanxi-catalog', version: '0.1.0' },
              hostContext: hostContext(),
            },
          },
          '*',
        )
      } else if (message.method === 'ui/notifications/initialized') {
        initialized.current = true
        frame.current?.setAttribute('data-plugin-initialized', '')
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    if (!initialized.current) return
    frame.current?.contentWindow?.postMessage(
      { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: hostContext() },
      '*',
    )
  }, [hostTheme, regimeKey])

  return (
    <iframe
      ref={frame}
      title={title}
      className="gx-catalog-t2-frame"
      sandbox="allow-scripts"
      srcDoc={T2_PLUGIN_DOCUMENT}
    />
  )
}
