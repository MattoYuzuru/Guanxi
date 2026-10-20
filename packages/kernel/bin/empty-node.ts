/**
 * Boot an empty Guanxi node (kernel + loader, empty profile) and report boot time
 * and idle RSS as one JSON line. Used by `test/boot-budget.test.ts` and by hand:
 *
 *   node packages/kernel/bin/empty-node.ts --idle-ms 2000
 */
import { performance } from 'node:perf_hooks'
import { bootNode } from '../src/node.ts'

const idleArg = process.argv.indexOf('--idle-ms')
const idleMs = idleArg === -1 ? 2_000 : Number(process.argv[idleArg + 1])
if (!Number.isFinite(idleMs) || idleMs < 0) throw new Error('--idle-ms must be a non-negative number')

const node = await bootNode({ plugins: [], profile: [{ name: 'profile:empty' }] })
// performance.now() counts from process start, so this includes Node startup
// and module loading, not only the kernel's own work.
const bootMs = performance.now()
const rssAtReadyBytes = process.memoryUsage().rss

await new Promise((resolve) => setTimeout(resolve, idleMs))
const idleRssBytes = process.memoryUsage().rss
const counters = node.counters()
await node.dispose()

process.stdout.write(
  `${JSON.stringify({
    bootMs: Math.round(bootMs),
    rssAtReadyBytes,
    idleRssBytes,
    idleMs,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    counters,
  })}\n`,
)
