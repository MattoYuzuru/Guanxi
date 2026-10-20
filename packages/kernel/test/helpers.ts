import { definePlugin, type GuanxiPlugin, type PluginContext } from '../src/index.ts'

let sequence = 0

/** A T0 test plugin with a unique id unless one is given. */
export function testPlugin<C = undefined>(
  manifest: Record<string, unknown>,
  apply: (ctx: PluginContext, config: C) => unknown,
): GuanxiPlugin<C> {
  sequence += 1
  return definePlugin<C>({
    manifest: { id: `test.plugin-${sequence}`, engines: { guanxi: '^0.1.0' }, trust: 'T0', ...manifest },
    apply: apply as never,
  })
}

export const tick = (ms = 1) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Let pending microtasks and a few macrotasks settle. */
export async function settle(rounds = 3): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await tick()
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
