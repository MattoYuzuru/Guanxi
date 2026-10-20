import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  runtimeHostTelemetrySchema,
  type HardwareInfo,
} from '@guanxi/contract'
import {
  APPLE_VM_STAT_PATH,
  AppleSiliconHostTelemetry,
  HOST_TELEMETRY_MAX_OUTPUT_BYTES,
  HOST_TELEMETRY_TIMEOUT_MS,
  HostTelemetryProbeError,
  NVIDIA_SMI_ARGS,
  NVIDIA_SMI_PATH,
  NvidiaHostTelemetry,
  createHostTelemetry,
  hostCommandExecOptions,
  parseAppleVmStat,
  parseNvidiaSmi,
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

const NVIDIA_HARDWARE: HardwareInfo = {
  ...APPLE_HARDWARE,
  platform: 'linux',
  arch: 'x64',
  totalMemoryBytes: 64 * 1024 ** 3,
  usableMemoryBytes: Math.floor(24 * 1024 ** 3 * 0.9),
  accelerator: 'cuda',
  acceleratorName: 'legacy first GPU name',
  unifiedMemory: false,
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
    assert.deepEqual(sample.availableFields, [
      'total_system_memory_bytes',
      'legacy_usable_memory_estimate_bytes',
    ])
    assert.ok(sample.missingFields.includes('nvidia_devices'))
    assert.deepEqual(runner.calls, [])

    const failedSample = runtimeHostTelemetrySchema.parse(
      unavailableHostTelemetry(telemetry.profile, OBSERVED_AT),
    )
    assert.deepEqual(failedSample.availableFields, [
      'total_system_memory_bytes',
      'legacy_usable_memory_estimate_bytes',
    ])
    assert.ok(failedSample.missingFields.includes('nvidia_devices'))
  })
})

describe('Linux NVIDIA host telemetry adapter', () => {
  it('uses one fixed shell-free allowlisted query and returns all non-sequential devices', async () => {
    const rows = [
      '2, GPU-UUID15, NVIDIA RTX 4090, 24576, 0',
      '7, GPU-UUID16, NVIDIA H100 NVL, 98304, 97000',
      '11, GPU-UUID17, NVIDIA Тестовая GPU, 12288, 4096',
    ].join('\r\n')
    const runner = new RecordingRunner(`${rows}\r\n`)
    const telemetry = new NvidiaHostTelemetry(NVIDIA_HARDWARE, {
      runner,
      now: () => new Date(OBSERVED_AT),
    })

    const sample = runtimeHostTelemetrySchema.parse(await telemetry.sample())
    assert.deepEqual(runner.calls, [{
      file: NVIDIA_SMI_PATH,
      args: NVIDIA_SMI_ARGS,
      options: {
        timeoutMs: HOST_TELEMETRY_TIMEOUT_MS,
        maxOutputBytes: HOST_TELEMETRY_MAX_OUTPUT_BYTES,
      },
    }])
    assert.equal(sample.state, 'available')
    assert.equal(sample.nvidia.state, 'available')
    assert.deepEqual(sample.nvidia.devices.map((device) => device.providerIndex), [2, 7, 11])
    assert.equal(sample.nvidia.devices[0]?.totalVramBytes.bytes, 24_576 * 1024 ** 2)
    assert.equal(sample.nvidia.devices[0]?.freeVramBytes.bytes, 0)
    assert.equal(sample.nvidia.devices[2]?.displayName, 'NVIDIA Тестовая GPU')
    assert.equal(sample.nvidia.devices[0]?.source, 'nvidia_smi_query_gpu')
    assert.equal(sample.nvidia.devices[0]?.observedAt, OBSERVED_AT)
    assert.equal(sample.profile.discreteVramBytes.bytes, null)
    assert.equal(sample.sample.gpuFreeMemoryBytes.bytes, null)
    assert.ok(sample.availableFields.includes('nvidia_devices'))
    assert.ok(sample.missingFields.includes('memory_pressure'))
    assert.deepEqual(
      hostCommandExecOptions({
        timeoutMs: HOST_TELEMETRY_TIMEOUT_MS,
        maxOutputBytes: HOST_TELEMETRY_MAX_OUTPUT_BYTES,
      }),
      {
        encoding: 'utf8',
        env: { LANG: 'C', LC_ALL: 'C' },
        maxBuffer: HOST_TELEMETRY_MAX_OUTPUT_BYTES,
        shell: false,
        timeout: HOST_TELEMETRY_TIMEOUT_MS,
        windowsHide: true,
      },
    )
  })

  it('has no arbitrary parser device ceiling and preserves LF/whitespace', () => {
    const rows = Array.from({ length: 257 }, (_, index) =>
      ` ${index * 2} , GPU-${String(index).padStart(12, '0')} , GPU ${index} , 1024 , 512 `,
    ).join('\n')
    const parsed = parseNvidiaSmi(`${rows}\n`)
    assert.equal(parsed.state, 'available')
    assert.equal(parsed.devices.length, 257)
    assert.equal(parsed.devices[256]?.providerIndex, 512)
  })

  it('keeps unknown UUID and usable plus malformed rows explicitly partial', () => {
    const unknownUuid = parseNvidiaSmi('0, N/A, GPU A, 1024, 512\n')
    assert.equal(unknownUuid.state, 'partial')
    assert.equal(unknownUuid.reason, 'device_identity_partial')
    assert.equal(unknownUuid.devices[0]?.uuid, null)

    const mixed = parseNvidiaSmi([
      '0, GPU-valid-0000, GPU A, 1024, 512',
      'broken,row',
      '4, GPU-valid-0004, GPU B, 2048, 1000',
    ].join('\n'))
    assert.equal(mixed.state, 'partial')
    assert.equal(mixed.reason, 'some_rows_malformed')
    assert.deepEqual(mixed.devices.map((device) => device.providerIndex), [0, 4])
  })

  it('fails closed for duplicate identity and all malformed numeric/column rows', () => {
    for (const output of [
      '0, GPU-one, GPU A, 1024, 512\n0, GPU-two, GPU B, 1024, 512\n',
      '0, GPU-one, GPU A, 1024, 512\n1, GPU-one, GPU B, 1024, 512\n',
    ]) {
      assert.deepEqual(parseNvidiaSmi(output), {
        state: 'unavailable', devices: [], reason: 'inconsistent_rows',
      })
    }

    for (const output of [
      '',
      '0, GPU-one, GPU A, -1, 0\n',
      '0, GPU-one, GPU A, 1.5, 0\n',
      '0, GPU-one, GPU A, 9007199254740992, 0\n',
      '9007199254740992, GPU-one, GPU A, 1, 0\n',
      '0, GPU-one, GPU A, 1\n',
      '0, GPU-one, GPU A, 1, 0, extra\n',
      '0, missing, GPU A, 1, 0\n',
      '0, GPU-one, GPU A, 1, 2\n',
      '0, GPU-one, bad\u0000name, 1, 0\n',
    ]) {
      assert.deepEqual(parseNvidiaSmi(output), {
        state: 'unavailable', devices: [], reason: 'all_rows_malformed',
      })
    }
  })

  it('classifies missing command, failure, timeout, output limit, and redacts details', async () => {
    const cases = [
      ['host_probe_command_missing', 'command_missing'],
      ['host_probe_failed', 'command_failed'],
      ['host_probe_timeout', 'timeout'],
      ['host_probe_output_limit', 'output_limit'],
    ] as const
    for (const [errorCode, reason] of cases) {
      const error = new HostTelemetryProbeError(errorCode)
      ;(error as Error & { stdout?: string; stderr?: string }).stdout =
        'GPU-private /Users/private username secret-token'
      ;(error as Error & { stdout?: string; stderr?: string }).stderr = 'driver path credential'
      const telemetry = new NvidiaHostTelemetry(NVIDIA_HARDWARE, {
        runner: new RecordingRunner(error),
        now: () => new Date(OBSERVED_AT),
      })
      const sample = runtimeHostTelemetrySchema.parse(await telemetry.sample())
      assert.equal(sample.state, 'unavailable')
      assert.equal(sample.errorCode, errorCode)
      assert.equal(sample.nvidia.state, 'unavailable')
      assert.equal(sample.nvidia.reason, reason)
      assert.equal(sample.nvidia.devices.length, 0)
      assert.doesNotMatch(JSON.stringify(sample), /private|Users|username|secret|driver path|credential/u)
    }
  })

  it('routes only local Linux CUDA to NVIDIA while preserving Apple and unsupported fallback', async () => {
    const linuxRunner = new RecordingRunner('0, GPU-one, GPU A, 1024, 512\n')
    assert.ok(createHostTelemetry(NVIDIA_HARDWARE, { runner: linuxRunner }) instanceof NvidiaHostTelemetry)
    assert.ok(createHostTelemetry(APPLE_HARDWARE) instanceof AppleSiliconHostTelemetry)

    for (const hardware of [
      { ...NVIDIA_HARDWARE, accelerator: 'cpu' as const },
      { ...NVIDIA_HARDWARE, platform: 'win32' },
      { ...NVIDIA_HARDWARE, platform: 'darwin', arch: 'x64' },
    ]) {
      const runner = new RecordingRunner(new Error('must not run'))
      const sample = runtimeHostTelemetrySchema.parse(await createHostTelemetry(hardware, {
        runner, now: () => new Date(OBSERVED_AT),
      }).sample())
      assert.equal(sample.state, 'unsupported')
      assert.equal(sample.nvidia.state, 'unsupported')
      assert.deepEqual(runner.calls, [])
    }
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
    assert.match(telemetry, /env: \{ LANG: 'C', LC_ALL: 'C' \}/u)
    assert.match(telemetry, /APPLE_VM_STAT_PATH/u)
    assert.match(telemetry, /NVIDIA_SMI_PATH/u)
    assert.doesNotMatch(
      forbiddenSources,
      /\b(?:exec|execFile|spawn)\(/u,
    )
  })
})
