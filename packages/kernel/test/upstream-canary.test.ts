/**
 * Canary for the kernel's lifecycle guard (patch 1 of the ADR-0015 budget).
 *
 * This file never creates a kernel, so the guard is not installed in its test
 * process (node:test runs each file in its own process). It pins the upstream
 * Cordis 4.0.0-rc.11 defects the guard exists for. When a Cordis upgrade fixes
 * them, these assertions fail: re-check cordiverse/cordis#96 and #185 and retire
 * the guard instead of updating the expectations.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { Context } from '../src/cordis-runtime.js'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))
const hooks = (root: Context) =>
  Object.values(root.events._hooks).reduce((sum, list) => sum + list.length, 0)

describe('upstream Cordis without the kernel guard', () => {
  it('is the pinned version', async () => {
    const require = createRequire(import.meta.url)
    const pkg = JSON.parse(await readFile(require.resolve('cordis/package.json'), 'utf8'))
    assert.equal(pkg.version, '4.0.0-rc.11')
  })

  it('leaks a listener registered while a fiber unloads after losing a dependency', async () => {
    const root = new Context()
    const base = hooks(root)
    const provider = root.plugin({ apply(ctx: Context) { ctx.provide('dep', {}) } })
    await provider
    const consumer = root.plugin({
      inject: ['dep'],
      apply(ctx: Context) {
        ctx.effect(() => () => ctx.on('late', () => {}))
      },
    })
    await consumer
    await provider.dispose()
    await consumer.dispose()
    await tick()
    assert.equal(hooks(root) - base, 1, 'upstream leaks the late listener')
  })

  it('leaks effects of a fiber disposed before it ever activated', async () => {
    const root = new Context()
    const base = hooks(root)
    const pending = root.plugin({ inject: ['never'], apply() {} })
    pending.ctx.on('observer', () => {})
    await pending.dispose()
    await tick()
    assert.equal(hooks(root) - base, 1, 'upstream leaks the pending fiber effect')
  })
})
