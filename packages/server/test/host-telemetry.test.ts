import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  runtimeHostTelemetrySchema,
  type HardwareInfo,
} from '@alamo/contract'
import {
  APPLE_VM_STAT_PATH,
  AppleSiliconHostTelemetry,
  HOST_TELEMETRY_MAX_OUTPUT_BYTES,
  HOST_TELEMETRY_TIMEOUT_MS,
  HostTelemetryProbeError,
  createHostTelemetry,
  parseAppleVmStat,
  unavailableHostTelemetry,
  type HostCommandOptions,
  type HostCommandRunner,
} from '../src/hardware/telemetry.ts'

const OBSERVED_AT = '2026-08-03T12:00:00.000Z'
const APPLE_HARDWARE: HardwareInfo = {
  platform: 'darwin',
  arch: 'arm64',
  cpuModel: 'Apple fixture',
  cpuCores: 10,
  totalMemoryBytes: 17_179_869_184,
  usableMemoryBytes: Math.floor(17_179_869_184 * 0.7),
  accelerator: 'metal',
  acceleratorName: 'Apple fixture',
  unifiedMemory: true,
  freeDiskBytes: null,
}

const VALID_VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               12345.
Pages active:                            99999.
Pages inactive:                          77777.
Pages speculative:                         123.
Pages wired down:                        22222.
`

class RecordingRunner implements HostCommandRunner {
  readonly calls: Array<{
    file: string
    args: readonly string[]
    options: HostCommandOptions
  }> = []
  private readonly result: string | Error

  constructor(result: string | Error) {
    this.result = result
  }

  async run(
    file: string,
    args: readonly string[],
    options: HostCommandOptions,
  ): Promise<string> {
    this.calls.push({ file, args, options })
    if (this.result instanceof Error) throw this.result
    return this.result
  }
}

describe('Apple Silicon host telemetry adapter', () => {
  it('uses one fixed execFile-like command with bounded timeout/output and exact byte units', async () => {
    const runner = new RecordingRunner(VALID_VM_STAT)
    const telemetry = new AppleSiliconHostTelemetry(APPLE_HARDWARE, {
      runner,
      now: () => new Date(OBSERVED_AT),
    })

    const sample = runtimeHostTelemetrySchema.parse(await telemetry.sample())
    assert.deepEqual(runner.calls, [
      {
        file: APPLE_VM_STAT_PATH,
        args: [],
        options: {
          timeoutMs: HOST_TELEMETRY_TIMEOUT_MS,
          maxOutputBytes: HOST_TELEMETRY_MAX_OUTPUT_BYTES,
        },
      },
    ])
    assert.equal(sample.state, 'available')
    assert.equal(sample.sample.freeMemoryBytes.bytes, 12_345 * 16_384)
    assert.equal(sample.sample.freeMemoryBytes.source, 'apple_vm_stat_pages_free')
    assert.equal(sample.sample.freeMemoryBytes.confidence, 'observed')
    assert.equal(sample.profile.totalMemoryBytes.bytes, 17_179_869_184)
    assert.equal(sample.profile.totalMemoryBytes.source, 'node_os_totalmem')
    assert.equal(
      sample.profile.legacyUsableMemoryBytes.basis,
      'legacy_compatibility_estimate_not_current_availability',
    )
    assert.equal(sample.profile.legacyUsableMemoryBytes.confidence, 'estimated')
    assert.equal(sample.profile.discreteVramBytes.bytes, null)
    assert.equal(sample.sample.gpuFreeMemoryBytes.bytes, null)
    assert.equal(sample.sample.pressure.level, 'unknown')
    assert.deepEqual(sample.availableFields, [
      'total_unified_memory_bytes',
      'legacy_usable_memory_estimate_bytes',
      'free_memory_bytes',
    ])
    assert.deepEqual(sample.missingFields, [
      'available_memory_bytes',
      'memory_pressure',
      'discrete_vram_bytes',
      'gpu_free_memory_bytes',
    ])
  })

  it('accepts documented extra vm_stat rows without treating them as new facts', () => {
    assert.deepEqual(
      parseAppleVmStat(`${VALID_VM_STAT}Pages purged: 555.\nUnknown future row: 42.\n`),
      { freeMemoryBytes: 12_345 * 16_384, malformed: false },
    )
  })

  it('returns partial unknown rather than optimistic zero for missing or malformed output', async () => {
    for (const output of [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages active: 1.\n',
      'Mach Virtual Memory Statistics: (page size of nope bytes)\nPages free: 1.\n',
      'private host path /Users/private and secret-token',
    ]) {
      const telemetry = new AppleSiliconHostTelemetry(APPLE_HARDWARE, {
        runner: new RecordingRunner(output),
        now: () => new Date(OBSERVED_AT),
      })
      const sample = runtimeHostTelemetrySchema.parse(await telemetry.sample())

      assert.equal(sample.state, 'partial')
      assert.equal(sample.errorCode, 'host_probe_malformed')
      assert.equal(sample.sample.freeMemoryBytes.bytes, null)
      assert.equal(sample.sample.freeMemoryBytes.confidence, 'unknown')
      assert.ok(sample.missingFields.includes('free_memory_bytes'))
      assert.doesNotMatch(JSON.stringify(sample), /Users\/private|secret-token/u)
    }
  })

  it('maps timeout, output-limit, and runner failure to safe unavailable states', async () => {
    for (const errorCode of [
      'host_probe_timeout',
      'host_probe_output_limit',
      'host_probe_failed',
    ] as const) {
      const runnerError = new HostTelemetryProbeError(errorCode)
      ;(runnerError as Error & { stdout?: string; stderr?: string }).stdout =
        'private prompt hostname username endpoint credential /Users/private'
      ;(runnerError as Error & { stdout?: string; stderr?: string }).stderr = 'secret-token'
      const telemetry = new AppleSiliconHostTelemetry(APPLE_HARDWARE, {
        runner: new RecordingRunner(runnerError),
        now: () => new Date(OBSERVED_AT),
      })
      const sample = runtimeHostTelemetrySchema.parse(await telemetry.sample())

      assert.equal(sample.state, 'unavailable')
      assert.equal(sample.errorCode, errorCode)
      assert.equal(sample.sample.source, 'none')
      assert.equal(sample.sample.freeMemoryBytes.bytes, null)
      assert.doesNotMatch(
        JSON.stringify(sample),
        /private prompt|hostname|username|endpoint|credential|Users\/private|secret-token/u,
      )
    }
  })

  it('returns explicit unsupported for non-Apple hosts without calling the runner', async () => {
    const runner = new RecordingRunner(new Error('must not run'))
    const telemetry = createHostTelemetry(
      { ...APPLE_HARDWARE, platform: 'linux', arch: 'x64', unifiedMemory: false },
      { runner, now: () => new Date(OBSERVED_AT) },
    )
    const sample = runtimeHostTelemetrySchema.parse(await telemetry.sample())

    assert.equal(sample.state, 'unsupported')
    assert.equal(sample.sample.source, 'none')
    assert.equal(sample.sample.pressure.level, 'unknown')
    assert.equal(sample.profile.totalMemoryBytes.basis, 'total_system_memory')
    assert.equal(
      sample.profile.legacyUsableMemoryBytes.source,
      'legacy_hardware_usable_estimate',
    )
    assert.equal(sample.profile.discreteVramBytes.basis, 'discrete_vram_not_observed')
    assert.deepEqual(sample.availableFields, ['legacy_usable_memory_estimate_bytes'])
    assert.ok(sample.missingFields.includes('total_unified_memory_bytes'))
    assert.deepEqual(runner.calls, [])

    const failedSample = runtimeHostTelemetrySchema.parse(
      unavailableHostTelemetry(telemetry.profile, OBSERVED_AT),
    )
    assert.deepEqual(failedSample.availableFields, [
      'legacy_usable_memory_estimate_bytes',
    ])
    assert.ok(failedSample.missingFields.includes('total_unified_memory_bytes'))
  })
})

describe('host telemetry composition inventory', () => {
  it('keeps host commands behind one injected boundary and out of routes/Web/Governor/fit', () => {
    const serverRoot = fileURLToPath(new URL('../src/', import.meta.url))
    const webRoot = fileURLToPath(new URL('../../web/src/', import.meta.url))
    const context = readFileSync(`${serverRoot}/context.ts`, 'utf8')
    const telemetry = readFileSync(`${serverRoot}/hardware/telemetry.ts`, 'utf8')
    const forbiddenSources = [
      readFileSync(`${serverRoot}/runtime/reconciliation.ts`, 'utf8'),
      readFileSync(`${serverRoot}/runtime/resource-governor.ts`, 'utf8'),
      readFileSync(`${serverRoot}/hardware/fit.ts`, 'utf8'),
      readFileSync(`${serverRoot}/http/runtime-routes.ts`, 'utf8'),
      readFileSync(`${serverRoot}/http/models-routes.ts`, 'utf8'),
      readFileSync(`${webRoot}/lib/api.ts`, 'utf8'),
      readFileSync(`${webRoot}/features/health/RuntimeStatus.tsx`, 'utf8'),
      readFileSync(`${webRoot}/features/health/RuntimeContext.tsx`, 'utf8'),
      readFileSync(`${webRoot}/features/health/useRuntimePolling.ts`, 'utf8'),
      readFileSync(`${webRoot}/features/chat/ResourceConflictDecision.tsx`, 'utf8'),
    ].join('\n')

    assert.match(context, /const hostTelemetry = createHostTelemetry\(hardware\)/u)
    assert.match(
      context,
      /new RuntimeReconciliationService\(\{ governor, hostTelemetry, models \}\)/u,
    )
    assert.match(telemetry, /export interface HostTelemetry/u)
    assert.match(telemetry, /execFile\(/u)
    assert.match(telemetry, /shell: false/u)
    assert.match(telemetry, /APPLE_VM_STAT_PATH/u)
    assert.doesNotMatch(
      forbiddenSources,
      /\b(?:exec|execFile|spawn)\(/u,
    )
  })
})
