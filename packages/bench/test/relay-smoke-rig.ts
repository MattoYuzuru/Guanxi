// A loopback server speaking the owner API shapes (status schema, session events envelope) on top of the fake relay.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { relayStartInputSchema } from '@guanxi/contract'
import { FakeClock, FakeRelay } from '../src/relay-smoke-fake.ts'
import { SmokeSourceError } from '../src/relay-smoke-source.ts'
import { T0 } from './relay-smoke-helpers.ts'

export const ARM = 'ledger-relay'
export interface Rig { url: string; close(): Promise<void>; fake: FakeRelay; clock: FakeClock; requests: string[] }

/** A loopback server speaking the owner API shapes (status schema, session events envelope) on top of the fake relay. */
export async function serve(options: { corrupt?: 'status' | 'events' | 'http500' | 'html' } = {}): Promise<Rig> {
  const clock = new FakeClock(T0)
  const fake = new FakeRelay(clock)
  const requests: string[] = []
  const send = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)) }
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://127.0.0.1')
    requests.push(`${req.method} ${url.pathname}${url.search}`)
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const text = Buffer.concat(chunks).toString()
    if (options.corrupt === 'http500') return send(res, 500, { code: 'secret_internal_detail', message: 'LEAK-MARKER' })
    if (options.corrupt === 'html') { res.writeHead(200); return res.end('<html>LEAK-MARKER</html>') }
    try {
      if (req.method === 'POST' && url.pathname === '/api/relay') {
        const parsed = relayStartInputSchema.safeParse(JSON.parse(text))
        if (!parsed.success) return send(res, 400, { code: 'validation_failed' })
        return send(res, 202, options.corrupt === 'status' ? { nonsense: true } : await fake.start(ARM, parsed.data))
      }
      const status = /^\/api\/relay\/starts\/([^/]+)(\/stop)?$/.exec(url.pathname)
      if (status) return send(res, 200, status[2] ? await fake.stop(ARM, status[1]!) : await fake.status(ARM, status[1]!))
      const events = /^\/api\/sessions\/([^/]+)\/events$/.exec(url.pathname)
      if (events) {
        const page = await fake.events(ARM, events[1]!, Number(url.searchParams.get('after')))
        if (options.corrupt === 'events') return send(res, 200, { sessionId: events[1], events: [{ bogus: true }], nextAfter: 0, lastSeq: 0, hasMore: false })
        const full = page.events.map(e => ({ sessionId: events[1], seq: e.seq, id: '00000000-0000-4000-8000-' + String(e.seq).padStart(12, '0'), spanId: null, parentSpanId: null, jobId: e.jobId, writerEpoch: 1,
          redactions: 0, createdAt: e.createdAt, version: 1, type: e.type, class: 'standard', data: e.data }))
        return send(res, 200, { sessionId: events[1], events: full, nextAfter: page.nextAfter, lastSeq: page.nextAfter, hasMore: page.hasMore })
      }
      send(res, 404, { code: 'relay_not_found' })
    } catch (error) {
      send(res, error instanceof SmokeSourceError && error.code === 'relay_not_found' ? 404 : 500, { code: error instanceof SmokeSourceError ? error.code : 'boom' })
    }
  }
  const server: Server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, fake, clock, requests, close: () => new Promise(resolve => server.close(() => resolve())) }
}

