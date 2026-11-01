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
  const abort = () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Renderer debugging connection closed')) }; pending.clear() }
  socket.addEventListener('close', abort)
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    const request = pending.get(message.id)
    if (request) {
      pending.delete(message.id); clearTimeout(request.timer)
      if (message.error) request.reject(new Error('Renderer debugging command failed'))
      else request.done(message.result)
    }
    if (message.method === 'Network.loadingFailed') violations.push('resource request failed')
    if (message.method === 'Log.entryAdded' && /Content Security Policy|Refused to|violates the following/i.test(message.params.entry.text)) violations.push('CSP violation')
  })
  const send = (method, params = {}) => new Promise((done, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Renderer command timed out: ${method}`)) }, 10_000)
    pending.set(id, { done, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { send, violations, close: () => { abort(); socket.close() } }
}
