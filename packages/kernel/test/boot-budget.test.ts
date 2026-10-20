/**
 * ADR-0015 validation item 4: an empty node boots in ≤ 2 s and idles at
 * ≤ 200 MB RSS on Apple Silicon. The child process boots the kernel with the
 * loader and an empty profile; `bootMs` counts from process start.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const script = fileURLToPath(new URL('../bin/empty-node.ts', import.meta.url))
const BOOT_BUDGET_MS = 2_000
const IDLE_RSS_BUDGET_BYTES = 200 * 1024 * 1024

describe('empty node budget', () => {
  it(`boots in ≤ ${BOOT_BUDGET_MS} ms and idles at ≤ 200 MB RSS`, async () => {
    const started = performance.now()
    const { stdout } = await run(process.execPath, [script, '--idle-ms', '1500'], { timeout: 20_000 })
    const wallMs = performance.now() - started
    const report = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}')
    console.log(`empty node: ${JSON.stringify({ ...report, wallMsIncludingIdle: Math.round(wallMs) })}`)
    assert.equal(typeof report.bootMs, 'number')
    assert.ok(report.bootMs <= BOOT_BUDGET_MS, `boot ${report.bootMs} ms > ${BOOT_BUDGET_MS} ms`)
    assert.ok(report.idleRssBytes <= IDLE_RSS_BUDGET_BYTES, `idle RSS ${report.idleRssBytes} B > 200 MB`)
    assert.equal(report.counters.fibers, 2, 'loader and its isolate helper only')
  })
})
