import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  catalogSourceHealthSchema,
  healthSchema,
  runningModelSchema,
  turnErrorSchema,
  turnStopReasonSchema,
} from '@alamo/contract'

const HARDWARE = {
  platform: 'darwin',
  arch: 'arm64',
  cpuModel: 'fixture',
  cpuCores: 8,
  totalMemoryBytes: 16_000_000_000,
  usableMemoryBytes: 12_000_000_000,
  accelerator: 'metal',
  acceleratorName: 'fixture',
  unifiedMemory: true,
  freeDiskBytes: null,
}

describe('runtime health contract', () => {
  it('accepts sourced current health and preserves the legacy additive shape', () => {
    const current = healthSchema.parse({
      ok: true,
      appVersion: 'test',
      application: {
        state: 'reachable',
        source: 'application_http',
        observedAt: '2026-08-02T12:00:00.000Z',
      },
      ollama: {
        installed: true,
        installSource: 'local_binary_path',
        running: false,
        state: 'incompatible',
        source: 'ollama_api_version',
        observedAt: '2026-08-02T12:00:00.000Z',
        version: null,
        host: 'http://fixture.invalid',
        installHint: null,
      },
      hardware: HARDWARE,
      network: {
        ollamaComReachable: null,
        checkedAt: null,
        status: 'unknown',
        source: 'not_checked',
      },
    })
    assert.equal(current.ollama.state, 'incompatible')
    assert.equal(current.ollama.installSource, 'local_binary_path')
    assert.equal(current.network.ollamaComReachable, null)

    const legacy = healthSchema.parse({
      ok: true,
      appVersion: 'legacy',
      ollama: {
        installed: true,
        running: true,
        version: '0.1',
        host: 'http://fixture.invalid',
        installHint: null,
      },
      hardware: HARDWARE,
      network: {
        ollamaComReachable: false,
        checkedAt: '2026-08-02T12:00:00.000Z',
      },
    })
    assert.equal(legacy.ollama.state, undefined)
    assert.equal(legacy.ollama.source, null)
    assert.equal(legacy.ollama.installSource, null)
  })

  it('represents every catalog health state without collapsing unknown or stale', () => {
    for (const state of [
      'fresh_remote',
      'stale_cache',
      'bundled_fallback',
      'unavailable',
      'unknown',
    ] as const) {
      const source =
        state === 'fresh_remote'
          ? 'documented_remote'
          : state === 'stale_cache'
            ? 'ollama_recommendations_cache'
            : state === 'bundled_fallback'
              ? 'bundled_snapshot'
              : 'none'
      const parsed = catalogSourceHealthSchema.parse({
        state,
        source,
        observedAt: '2026-08-02T12:00:00.000Z',
        fetchedAt:
          state === 'unknown' || state === 'unavailable'
            ? null
            : '2026-08-02T11:00:00.000Z',
      })
      assert.equal(parsed.state, state)
    }
  })

  it('keeps missing ps facts nullable and exposes timeout categories', () => {
    const running = runningModelSchema.parse({
      name: 'fixture',
      sizeBytes: 1_000,
      sizeVramBytes: null,
      gpuPercent: null,
      processorLabel: null,
      contextLength: null,
      expiresAt: null,
    })
    assert.equal(running.observedAt, null)
    assert.equal(running.source, null)

    for (const code of [
      'ollama_connect_timeout',
      'ollama_load_timeout',
      'ollama_stream_idle_timeout',
    ] as const) {
      assert.equal(turnErrorSchema.parse({ code, message: 'safe' }).code, code)
    }
    assert.equal(turnStopReasonSchema.parse('provider_error'), 'provider_error')
  })
})
