import { execFile } from 'node:child_process'
import type {
  HardwareInfo,
  RuntimeHostTelemetry,
  RuntimeHostTelemetryField,
  RuntimeMemoryFact,
} from '@alamo/contract'

export const APPLE_VM_STAT_PATH = '/usr/bin/vm_stat'
export const HOST_TELEMETRY_TIMEOUT_MS = 1_000
export const HOST_TELEMETRY_MAX_OUTPUT_BYTES = 64 * 1024

export type HostTelemetryErrorCode = NonNullable<RuntimeHostTelemetry['errorCode']>

export interface HostCommandOptions {
  timeoutMs: number
  maxOutputBytes: number
}

/** Narrow command boundary used only by host telemetry infrastructure. */
export interface HostCommandRunner {
  run(file: string, args: readonly string[], options: HostCommandOptions): Promise<string>
}

export interface HostTelemetry {
  readonly profile: HardwareInfo
  sample(): Promise<RuntimeHostTelemetry>
}

export class HostTelemetryProbeError extends Error {
  readonly code: HostTelemetryErrorCode

  constructor(code: HostTelemetryErrorCode) {
    super(code)
    this.name = 'HostTelemetryProbeError'
    this.code = code
  }
}

export class ExecFileHostCommandRunner implements HostCommandRunner {
  run(file: string, args: readonly string[], options: HostCommandOptions): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(
        file,
        [...args],
        {
          encoding: 'utf8',
          env: { LANG: 'C', LC_ALL: 'C' },
          maxBuffer: options.maxOutputBytes,
          shell: false,
          timeout: options.timeoutMs,
          windowsHide: true,
        },
        (error, stdout) => {
          if (!error) {
            resolve(stdout)
            return
          }

          const processError = error as Error & {
            code?: string | number
            killed?: boolean
            signal?: string | null
          }
          if (processError.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(new HostTelemetryProbeError('host_probe_output_limit'))
          } else if (processError.killed || processError.signal === 'SIGTERM') {
            reject(new HostTelemetryProbeError('host_probe_timeout'))
          } else {
            reject(new HostTelemetryProbeError('host_probe_failed'))
          }
        },
      )
    })
  }
}

interface VmStatReading {
  freeMemoryBytes: number | null
  malformed: boolean
}

/**
 * `vm_stat(1)` documents the banner page size and `Pages free` counter. We do
 * not infer reclaimable/available memory or pressure from the remaining page
 * lists because Apple does not document a safe admission threshold for them.
 */
export function parseAppleVmStat(output: string): VmStatReading {
  const pageSizeMatch = output.match(
    /^Mach Virtual Memory Statistics:\s*\(page size of (\d+) bytes\)\s*$/mu,
  )
  const freePagesMatch = output.match(/^Pages free:\s*(\d+)\.\s*$/mu)
  if (!pageSizeMatch || !freePagesMatch) {
    return { freeMemoryBytes: null, malformed: true }
  }

  const pageSize = Number(pageSizeMatch[1])
  const freePages = Number(freePagesMatch[1])
  const freeMemoryBytes = pageSize * freePages
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize <= 0 ||
    !Number.isSafeInteger(freePages) ||
    freePages < 0 ||
    !Number.isSafeInteger(freeMemoryBytes)
  ) {
    return { freeMemoryBytes: null, malformed: true }
  }

  return { freeMemoryBytes, malformed: false }
}

function memoryFact(
  observedAt: string,
  input: Omit<RuntimeMemoryFact, 'observedAt'>,
): RuntimeMemoryFact {
  return { ...input, observedAt }
}

function baseTelemetry(
  hardware: HardwareInfo,
  observedAt: string,
  input: Pick<
    RuntimeHostTelemetry,
    'state' | 'availableFields' | 'missingFields' | 'errorCode'
  > & {
    sampleSource: RuntimeHostTelemetry['sample']['source']
    freeMemoryBytes: number | null
  },
): RuntimeHostTelemetry {
  const appleUnified = hardware.platform === 'darwin' && hardware.arch === 'arm64'
  return {
    state: input.state,
    observedAt,
    profile: {
      platform: hardware.platform,
      arch: hardware.arch,
      accelerator: hardware.accelerator,
      acceleratorName: hardware.acceleratorName,
      unifiedMemory: hardware.unifiedMemory,
      source: 'legacy_hardware_probe',
      observedAt,
      confidence: 'observed',
      totalMemoryBytes: memoryFact(observedAt, {
        bytes: hardware.totalMemoryBytes,
        source: 'node_os_totalmem',
        confidence: 'observed',
        basis: appleUnified ? 'total_unified_memory' : 'total_system_memory',
      }),
      legacyUsableMemoryBytes: memoryFact(observedAt, {
        bytes: hardware.usableMemoryBytes,
        source: appleUnified
          ? 'legacy_apple_unified_memory_70_percent'
          : 'legacy_hardware_usable_estimate',
        confidence: 'estimated',
        basis: 'legacy_compatibility_estimate_not_current_availability',
      }),
      discreteVramBytes: memoryFact(observedAt, {
        bytes: null,
        source: 'not_reported',
        confidence: 'unknown',
        basis: appleUnified
          ? 'discrete_vram_not_applicable_to_apple_unified_memory'
          : 'discrete_vram_not_observed',
      }),
    },
    sample: {
      source: input.sampleSource,
      observedAt,
      freeMemoryBytes: memoryFact(observedAt, {
        bytes: input.freeMemoryBytes,
        source: input.freeMemoryBytes === null ? 'not_reported' : 'apple_vm_stat_pages_free',
        confidence: input.freeMemoryBytes === null ? 'unknown' : 'observed',
        basis: 'system_free_pages_not_safe_capacity',
      }),
      availableMemoryBytes: memoryFact(observedAt, {
        bytes: null,
        source: 'not_reported',
        confidence: 'unknown',
        basis: 'system_available_memory_advisory',
      }),
      pressure: {
        level: 'unknown',
        source: 'not_reported',
        observedAt,
        confidence: 'unknown',
        basis: 'not_observed',
      },
      gpuFreeMemoryBytes: memoryFact(observedAt, {
        bytes: null,
        source: 'not_reported',
        confidence: 'unknown',
        basis: 'gpu_free_memory_not_reported',
      }),
    },
    availableFields: input.availableFields,
    missingFields: input.missingFields,
    errorCode: input.errorCode,
  }
}

const STATIC_APPLE_FIELDS: RuntimeHostTelemetryField[] = [
  'total_unified_memory_bytes',
  'legacy_usable_memory_estimate_bytes',
]
const UNOBSERVED_APPLE_FIELDS: RuntimeHostTelemetryField[] = [
  'available_memory_bytes',
  'memory_pressure',
  'discrete_vram_bytes',
  'gpu_free_memory_bytes',
]

export interface AppleSiliconHostTelemetryOptions {
  runner?: HostCommandRunner
  now?: () => Date
}

export class AppleSiliconHostTelemetry implements HostTelemetry {
  readonly profile: HardwareInfo
  private readonly runner: HostCommandRunner
  private readonly now: () => Date

  constructor(profile: HardwareInfo, options: AppleSiliconHostTelemetryOptions = {}) {
    this.profile = profile
    this.runner = options.runner ?? new ExecFileHostCommandRunner()
    this.now = options.now ?? (() => new Date())
  }

  async sample(): Promise<RuntimeHostTelemetry> {
    let output: string
    try {
      output = await this.runner.run(APPLE_VM_STAT_PATH, [], {
        timeoutMs: HOST_TELEMETRY_TIMEOUT_MS,
        maxOutputBytes: HOST_TELEMETRY_MAX_OUTPUT_BYTES,
      })
    } catch (error) {
      const observedAt = this.now().toISOString()
      const errorCode =
        error instanceof HostTelemetryProbeError ? error.code : 'host_probe_failed'
      return baseTelemetry(this.profile, observedAt, {
        state: 'unavailable',
        sampleSource: 'none',
        freeMemoryBytes: null,
        availableFields: STATIC_APPLE_FIELDS,
        missingFields: ['free_memory_bytes', ...UNOBSERVED_APPLE_FIELDS],
        errorCode,
      })
    }

    const observedAt = this.now().toISOString()
    const reading = parseAppleVmStat(output)
    if (reading.malformed) {
      return baseTelemetry(this.profile, observedAt, {
        state: 'partial',
        sampleSource: 'apple_vm_stat',
        freeMemoryBytes: null,
        availableFields: STATIC_APPLE_FIELDS,
        missingFields: ['free_memory_bytes', ...UNOBSERVED_APPLE_FIELDS],
        errorCode: 'host_probe_malformed',
      })
    }

    return baseTelemetry(this.profile, observedAt, {
      state: 'available',
      sampleSource: 'apple_vm_stat',
      freeMemoryBytes: reading.freeMemoryBytes,
      availableFields: [...STATIC_APPLE_FIELDS, 'free_memory_bytes'],
      missingFields: UNOBSERVED_APPLE_FIELDS,
      errorCode: null,
    })
  }
}

export class UnsupportedHostTelemetry implements HostTelemetry {
  readonly profile: HardwareInfo
  private readonly now: () => Date

  constructor(profile: HardwareInfo, now: () => Date = () => new Date()) {
    this.profile = profile
    this.now = now
  }

  async sample(): Promise<RuntimeHostTelemetry> {
    const observedAt = this.now().toISOString()
    return baseTelemetry(this.profile, observedAt, {
      state: 'unsupported',
      sampleSource: 'none',
      freeMemoryBytes: null,
      availableFields: [],
      missingFields: [
        'total_unified_memory_bytes',
        'legacy_usable_memory_estimate_bytes',
        'free_memory_bytes',
        'available_memory_bytes',
        'memory_pressure',
        'discrete_vram_bytes',
        'gpu_free_memory_bytes',
      ],
      errorCode: null,
    })
  }
}

export function createHostTelemetry(
  hardware: HardwareInfo,
  options: AppleSiliconHostTelemetryOptions = {},
): HostTelemetry {
  return hardware.platform === 'darwin' && hardware.arch === 'arm64'
    ? new AppleSiliconHostTelemetry(hardware, options)
    : new UnsupportedHostTelemetry(hardware, options.now)
}

export function unavailableHostTelemetry(
  hardware: HardwareInfo,
  observedAt: string,
): RuntimeHostTelemetry {
  const appleUnified = hardware.platform === 'darwin' && hardware.arch === 'arm64'
  return baseTelemetry(hardware, observedAt, {
    state: 'unavailable',
    sampleSource: 'none',
    freeMemoryBytes: null,
    availableFields: appleUnified ? STATIC_APPLE_FIELDS : [],
    missingFields: [
      'free_memory_bytes',
      'available_memory_bytes',
      'memory_pressure',
      'discrete_vram_bytes',
      'gpu_free_memory_bytes',
    ],
    errorCode: 'host_probe_failed',
  })
}

/** Aligns a completed source observation with the application sample timestamp. */
export function alignHostTelemetryObservedAt(
  host: RuntimeHostTelemetry,
  observedAt: string,
): RuntimeHostTelemetry {
  const alignMemory = (fact: RuntimeMemoryFact): RuntimeMemoryFact => ({ ...fact, observedAt })
  return {
    ...host,
    observedAt,
    profile: {
      ...host.profile,
      observedAt,
      totalMemoryBytes: alignMemory(host.profile.totalMemoryBytes),
      legacyUsableMemoryBytes: alignMemory(host.profile.legacyUsableMemoryBytes),
      discreteVramBytes: alignMemory(host.profile.discreteVramBytes),
    },
    sample: {
      ...host.sample,
      observedAt,
      freeMemoryBytes: alignMemory(host.sample.freeMemoryBytes),
      availableMemoryBytes: alignMemory(host.sample.availableMemoryBytes),
      pressure: { ...host.sample.pressure, observedAt },
      gpuFreeMemoryBytes: alignMemory(host.sample.gpuFreeMemoryBytes),
    },
  }
}
