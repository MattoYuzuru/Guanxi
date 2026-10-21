interface EgressMessage { egress: { id: number; url: string; headers: [string, string][] } }
interface EgressChannel {
  readonly connected?: boolean
  send?: (message: EgressMessage, callback: (error: Error | null) => void) => unknown
  on(event: 'message', listener: (message: { egressDecision?: { id: number; allow: boolean } }) => void): unknown
  on(event: 'disconnect', listener: () => void): unknown
}

/** Registered values stay in the parent; failed or unanswered decisions deny. */
export function createEgressAuthorizer(channel: EgressChannel) {
  let next = 0
  const pending = new Map<number, (allow: boolean) => void>()
  channel.on('message', message => {
    if (message.egressDecision) pending.get(message.egressDecision.id)?.(message.egressDecision.allow === true)
  })
  channel.on('disconnect', () => { for (const finish of pending.values()) finish(false) })
  return (request: Request): Promise<boolean> => new Promise(resolve => {
    const id = ++next
    const timer = setTimeout(() => finish(false), 1000)
    const finish = (allow: boolean) => { clearTimeout(timer); pending.delete(id); resolve(allow) }
    pending.set(id, finish)
    if (!channel.connected || !channel.send) { finish(false); return }
    try {
      channel.send({ egress: { id, url: request.url, headers: [...request.headers] } }, error => { if (error) finish(false) })
    } catch { finish(false) }
  })
}
