// A renderer-only test connection. Electron does not expose every target as a Playwright Page.
export async function connectRenderer(url) {
  const socket = new WebSocket(url)
  await new Promise((done, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Renderer debugging connection timed out')) }, 5000)
    socket.addEventListener('open', () => { clearTimeout(timer); done() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Renderer debugging connection failed')) }, { once: true })
  })
  let nextId = 0
  const pending = new Map()
  const violations = []
  const listeners = new Set()
  const abort = () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Renderer debugging connection closed')) }; pending.clear() }
  socket.addEventListener('close', abort)
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    for (const listener of listeners) listener(message)
    const request = pending.get(message.id)
    if (request) {
      pending.delete(message.id); clearTimeout(request.timer)
      if (message.error) request.reject(new Error('Renderer debugging command failed'))
      else request.done(message.result)
    }
    if (message.method === 'Network.loadingFailed') violations.push('resource request failed')
    if (isFailedUiResponse(message)) violations.push('UI resource HTTP error')
    if (message.method === 'Log.entryAdded' && /Content Security Policy|Refused to|violates the following/i.test(message.params.entry.text)) violations.push('CSP violation')
  })
  const send = (method, params = {}) => new Promise((done, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Renderer command timed out: ${method}`)) }, 10_000)
    pending.set(id, { done, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  return { send, violations, reload: () => reloadDocument(send, subscribe), close: () => { abort(); socket.close() } }
}

export const isFailedUiResponse = message => message.method === 'Network.responseReceived' &&
  ['Document', 'Script', 'Stylesheet', 'Font', 'Image'].includes(message.params.type) && message.params.response.status >= 400

export async function reloadDocument(send, subscribe) {
  await send('Page.setLifecycleEventsEnabled', { enabled: true })
  const { frameTree: { frame } } = await send('Page.getFrameTree')
  let unsubscribe
  let timer
  const loaded = new Promise((done, reject) => {
    timer = setTimeout(() => reject(new Error('New packaged document did not load')), 30_000)
    unsubscribe = subscribe(message => {
      const event = message.params
      if (message.method === 'Page.lifecycleEvent' && event.name === 'load' && event.frameId === frame.id && event.loaderId !== frame.loaderId) done()
    })
  })
  // A send failure can happen before the lifecycle deadline; keep rejection handled until cleanup.
  loaded.catch(() => {})
  try { await send('Page.reload'); await loaded } finally { clearTimeout(timer); unsubscribe() }
}
