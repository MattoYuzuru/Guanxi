import type { MiddlewareHandler } from 'hono'

export interface HostAllowlistOptions {
  host?: string
  /** A getter supports port 0: start() supplies the bound port before accepting requests. */
  port?: number | (() => number)
  devOrigins?: readonly string[]
}

/** Validate authority before CORS, API handlers, and static/SPA fallback (DNS rebinding). */
export function hostAllowlist(options: HostAllowlistOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    const port = typeof options.port === 'function' ? options.port() : options.port ?? 80
    const allowed = new Set<string>()
    for (const host of ['localhost', '127.0.0.1', '[::1]', options.host ?? '127.0.0.1']) {
      const name = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
      allowed.add(`${name.toLowerCase()}:${port}`)
      if (port === 80 || port === 443) allowed.add(name.toLowerCase())
    }
    for (const origin of options.devOrigins ?? []) allowed.add(new URL(origin).host.toLowerCase())
    const host = c.req.header('host') ?? new URL(c.req.url).host
    // Do not use forwarded headers or normalize attacker-controlled authority syntax.
    if (!allowed.has(host.toLowerCase())) return c.json({ code: 'host_denied' }, 403)
    await next()
  }
}
