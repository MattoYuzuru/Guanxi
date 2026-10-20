import { execFile } from 'node:child_process'
import type {
  HardwareInfo,
  RuntimeHostTelemetry,
  RuntimeHostTelemetryField,
  RuntimeMemoryFact,
  RuntimeNvidiaDevice,
  RuntimeNvidiaTelemetry,
} from '@guanxi/contract'

export const APPLE_VM_STAT_PATH = '/usr/bin/vm_stat'
export const NVIDIA_SMI_PATH = '/usr/bin/nvidia-smi'
export const NVIDIA_SMI_ARGS = [
  '--query-gpu=index,uuid,name,memory.total,memory.free',
  '--format=csv,noheader,nounits',
] as const
export const HOST_TELEMETRY_TIMEOUT_MS = 1_000
export const HOST_TELEMETRY_MAX_OUTPUT_BYTES = 64 * 1024

export type HostTelemetryErrorCode = NonNullable<RuntimeHostTelemetry['errorCode']>

export interface HostCommandOptions {
  timeoutMs: number
  maxOutputBytes: number
}

export function hostCommandExecOptions(options: HostCommandOptions) {
  return {
    encoding: 'utf8' as const,
    env: { LANG: 'C', LC_ALL: 'C' },
    maxBuffer: options.maxOutputBytes,
    shell: false as const,
    timeout: options.timeoutMs,
    windowsHide: true,
  }
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
        hostCommandExecOptions(options),
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
          } else if (processError.code === 'ENOENT') {
            reject(new HostTelemetryProbeError('host_probe_command_missing'))
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

export interface NvidiaSmiReading {
  state: 'available' | 'partial' | 'unavailable'
  devices: Array<{
    providerIndex: number
    uuid: string | null
    displayName: string
    totalVramBytes: number
    freeVramBytes: number
  }>
  reason: RuntimeNvidiaTelemetry['reason']
}

const NVIDIA_UNKNOWN_TOKENS = new Set(['', 'n/a', '[not supported]', 'not supported'])
const NVIDIA_UUID_PATTERN = /^GPU-[0-9A-Za-z-]+$/u
const MIB_BYTES = 1024n * 1024n

function parseNvidiaInteger(value: string): number | null {
  if (!/^\d+$/u.test(value)) return null
  const integer = BigInt(value)
  if (integer > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(integer)
}

function parseNvidiaMib(value: string): number | null {
  if (!/^\d+$/u.test(value)) return null
  const bytes = BigInt(value) * MIB_BYTES
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(bytes)
}

/** Pure parser for the fixed five-column `nvidia-smi` query. */
export function parseNvidiaSmi(output: string): NvidiaSmiReading {
  const lines = output.split(/\r?\n/u).filter((line) => line.trim().length > 0)
  const devices: NvidiaSmiReading['devices'] = []
  let malformedRows = 0
  let unknownUuid = false
  let inconsistentRows = false
  const seenIndexes = new Set<number>()
  const seenUuids = new Set<string>()

  for (const line of lines) {
    const columns = line.split(',')
    if (columns.length !== 5) {
      malformedRows += 1
      continue
    }
    const [rawIndex, rawUuid, rawName, rawTotal, rawFree] = columns.map((value) => value.trim())
    const providerIndex = parseNvidiaInteger(rawIndex ?? '')
    const uuidToken = rawUuid ?? ''
    const normalizedUuid = NVIDIA_UNKNOWN_TOKENS.has(uuidToken.toLowerCase())
      ? null
      : NVIDIA_UUID_PATTERN.test(uuidToken)
        ? uuidToken
        : undefined
    const displayName = rawName ?? ''
    const totalVramBytes = parseNvidiaMib(rawTotal ?? '')
    const freeVramBytes = parseNvidiaMib(rawFree ?? '')
    if (providerIndex !== null) {
      if (seenIndexes.has(providerIndex)) inconsistentRows = true
      seenIndexes.add(providerIndex)
    }
    if (normalizedUuid) {
      if (seenUuids.has(normalizedUuid)) inconsistentRows = true
      seenUuids.add(normalizedUuid)
    }
    if (
      providerIndex === null ||
      normalizedUuid === undefined ||
      displayName.length === 0 ||
      /[\u0000-\u001f\u007f]/u.test(displayName) ||
      totalVramBytes === null ||
      freeVramBytes === null ||
      freeVramBytes > totalVramBytes
    ) {
      malformedRows += 1
      continue
    }
    if (normalizedUuid === null) unknownUuid = true
    devices.push({
      providerIndex,
      uuid: normalizedUuid,
      displayName,
      totalVramBytes,
      freeVramBytes,
    })
  }

  if (inconsistentRows) {
    return { state: 'unavailable', devices: [], reason: 'inconsistent_rows' }
  }
  if (devices.length === 0) {
    return { state: 'unavailable', devices: [], reason: 'all_rows_malformed' }
  }

  if (malformedRows > 0) {
    return { state: 'partial', devices, reason: 'some_rows_malformed' }
  }
  if (unknownUuid) {
    return { state: 'partial', devices, reason: 'device_identity_partial' }
  }
  return { state: 'available', devices, reason: null }
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
    nvidia?: RuntimeNvidiaTelemetry
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
    nvidia: input.nvidia ?? unsupportedNvidiaTelemetry(hardware, observedAt),
    availableFields: input.availableFields,
    missingFields: input.missingFields,
    errorCode: input.errorCode,
  }
}

function unsupportedNvidiaTelemetry(
  hardware: HardwareInfo,
  observedAt: string,
): RuntimeNvidiaTelemetry {
  return {
    state: 'unsupported',
    source: 'none',
    observedAt,
    devices: [],
    reason: hardware.platform === 'linux' ? 'nvidia_not_detected' : 'platform_not_linux',
  }
}

function nvidiaMemoryFact(
  observedAt: string,
  bytes: number,
  kind: 'total' | 'free',
): RuntimeMemoryFact {
  return memoryFact(observedAt, {
    bytes,
    source: kind === 'total' ? 'nvidia_smi_memory_total' : 'nvidia_smi_memory_free',
    confidence: 'observed',
    basis: kind === 'total' ? 'device_total_vram' : 'device_free_vram_not_safe_capacity',
  })
}

function nvidiaDevice(
  observedAt: string,
  device: NvidiaSmiReading['devices'][number],
): RuntimeNvidiaDevice {
  return {
    providerIndex: device.providerIndex,
    uuid: device.uuid,
    displayName: device.displayName,
    source: 'nvidia_smi_query_gpu',
    observedAt,
    confidence: 'observed',
    totalVramBytes: nvidiaMemoryFact(observedAt, device.totalVramBytes, 'total'),
    freeVramBytes: nvidiaMemoryFact(observedAt, device.freeVramBytes, 'free'),
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

export type NvidiaHostTelemetryOptions = AppleSiliconHostTelemetryOptions

export class NvidiaHostTelemetry implements HostTelemetry {
  readonly profile: HardwareInfo
  private readonly runner: HostCommandRunner
  private readonly now: () => Date

  constructor(profile: HardwareInfo, options: NvidiaHostTelemetryOptions = {}) {
    this.profile = profile
    this.runner = options.runner ?? new ExecFileHostCommandRunner()
    this.now = options.now ?? (() => new Date())
  }

  async sample(): Promise<RuntimeHostTelemetry> {
    let output: string
    try {
      output = await this.runner.run(NVIDIA_SMI_PATH, NVIDIA_SMI_ARGS, {
        timeoutMs: HOST_TELEMETRY_TIMEOUT_MS,
        maxOutputBytes: HOST_TELEMETRY_MAX_OUTPUT_BYTES,
      })
    } catch (error) {
      const observedAt = this.now().toISOString()
      const errorCode =
        error instanceof HostTelemetryProbeError ? error.code : 'host_probe_failed'
      const reason =
        errorCode === 'host_probe_command_missing'
          ? 'command_missing'
          : errorCode === 'host_probe_timeout'
            ? 'timeout'
            : errorCode === 'host_probe_output_limit'
              ? 'output_limit'
              : 'command_failed'
      return baseTelemetry(this.profile, observedAt, {
        state: 'unavailable',
        sampleSource: 'none',
        freeMemoryBytes: null,
        availableFields: ['total_system_memory_bytes', 'legacy_usable_memory_estimate_bytes'],
        missingFields: [
          'free_memory_bytes',
          'available_memory_bytes',
          'memory_pressure',
          'discrete_vram_bytes',
          'gpu_free_memory_bytes',
          'nvidia_devices',
        ],
        errorCode,
        nvidia: { state: 'unavailable', source: 'none', observedAt, devices: [], reason },
      })
    }

    const observedAt = this.now().toISOString()
    const reading = parseNvidiaSmi(output)
    const nvidia: RuntimeNvidiaTelemetry = {
      state: reading.state,
      source: 'nvidia_smi',
      observedAt,
      devices: reading.devices.map((device) => nvidiaDevice(observedAt, device)),
      reason: reading.reason,
    }
    return baseTelemetry(this.profile, observedAt, {
      state: reading.state,
      sampleSource: 'nvidia_smi',
      freeMemoryBytes: null,
      availableFields: [
        'total_system_memory_bytes',
        'legacy_usable_memory_estimate_bytes',
        ...(reading.devices.length > 0 ? (['nvidia_devices'] as const) : []),
      ],
      missingFields: [
        'free_memory_bytes',
        'available_memory_bytes',
        'memory_pressure',
        'discrete_vram_bytes',
        'gpu_free_memory_bytes',
        ...(reading.devices.length > 0 ? [] : (['nvidia_devices'] as const)),
      ],
      errorCode: reading.state === 'available' ? null : 'host_probe_malformed',
      nvidia,
    })
  }
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
      availableFields: [
        'total_system_memory_bytes',
        'legacy_usable_memory_estimate_bytes',
      ],
      missingFields: [
        'free_memory_bytes',
        'available_memory_bytes',
        'memory_pressure',
        'discrete_vram_bytes',
        'gpu_free_memory_bytes',
        'nvidia_devices',
      ],
      errorCode: null,
    })
  }
}

export function createHostTelemetry(
  hardware: HardwareInfo,
  options: AppleSiliconHostTelemetryOptions = {},
): HostTelemetry {
  if (hardware.platform === 'darwin' && hardware.arch === 'arm64') {
    return new AppleSiliconHostTelemetry(hardware, options)
  }
  if (hardware.platform === 'linux' && hardware.accelerator === 'cuda') {
    return new NvidiaHostTelemetry(hardware, options)
  }
  return new UnsupportedHostTelemetry(hardware, options.now)
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
    availableFields: appleUnified
      ? STATIC_APPLE_FIELDS
      : ['total_system_memory_bytes', 'legacy_usable_memory_estimate_bytes'],
    missingFields: [
      'free_memory_bytes',
      'available_memory_bytes',
      'memory_pressure',
      'discrete_vram_bytes',
      'gpu_free_memory_bytes',
      ...(appleUnified ? [] : (['nvidia_devices'] as const)),
    ],
    errorCode: 'host_probe_failed',
    nvidia:
      hardware.platform === 'linux' && hardware.accelerator === 'cuda'
        ? {
            state: 'unavailable',
            source: 'none',
            observedAt,
            devices: [],
            reason: 'command_failed',
          }
        : undefined,
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
    nvidia: {
      ...host.nvidia,
      observedAt,
      devices: host.nvidia.devices.map((device) => ({
        ...device,
        observedAt,
        totalVramBytes: alignMemory(device.totalVramBytes),
        freeVramBytes: alignMemory(device.freeVramBytes),
      })),
    },
  }
}
