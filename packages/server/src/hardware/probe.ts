/**
 * Определение железа. Считается один раз при старте — состав железа за время
 * работы процесса не меняется.
 */
import { execFile } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import os from 'node:os'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { Accelerator, HardwareInfo } from '@guanxi/contract'

const execFileAsync = promisify(execFile)

/** Legacy UI compatibility estimate, never current availability or pressure. */
const UNIFIED_MEMORY_USABLE_FRACTION = 0.7

/** На дискретной видеокарте почти вся видеопамять доступна, оставляем запас на драйвер. */
const DISCRETE_VRAM_USABLE_FRACTION = 0.9

/** Без ускорителя модель живёт в обычной ОЗУ, где ещё работает вся остальная система. */
const CPU_ONLY_USABLE_FRACTION = 0.5

async function run(command: string, args: string[], timeoutMs = 3_000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: timeoutMs })
    return stdout.trim()
  } catch {
    return null
  }
}

async function detectNvidia(): Promise<{ name: string; vramBytes: number } | null> {
  const output = await run('nvidia-smi', [
    '--query-gpu=name,memory.total',
    '--format=csv,noheader,nounits',
  ])
  if (!output) return null

  const firstLine = output.split('\n')[0]
  if (!firstLine) return null

  const [name, vramMb] = firstLine.split(',').map((part) => part.trim())
  const megabytes = Number(vramMb)
  if (!name || !Number.isFinite(megabytes)) return null

  return { name, vramBytes: megabytes * 1024 * 1024 }
}

async function detectAmd(): Promise<{ name: string; vramBytes: number } | null> {
  const output = await run('rocm-smi', ['--showproductname', '--csv'])
  if (!output) return null
  const line = output.split('\n').find((l) => l.includes(','))
  if (!line) return null
  return { name: line.split(',')[1]?.trim() ?? 'AMD GPU', vramBytes: 0 }
}

async function freeDiskBytes(path: string): Promise<number | null> {
  try {
    const stats = await statfs(path)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return null
  }
}

let cached: HardwareInfo | null = null

export async function probeHardware(force = false): Promise<HardwareInfo> {
  if (cached && !force) return cached

  const platform = os.platform()
  const arch = os.arch()
  const totalMemoryBytes = os.totalmem()
  const cpus = os.cpus()
  const cpuModel = cpus[0]?.model?.trim() ?? 'unknown'

  let accelerator: Accelerator = 'cpu'
  let acceleratorName: string | null = null
  let unifiedMemory = false
  let usableMemoryBytes = Math.floor(totalMemoryBytes * CPU_ONLY_USABLE_FRACTION)

  if (platform === 'darwin' && arch === 'arm64') {
    accelerator = 'metal'
    unifiedMemory = true
    // На Apple Silicon бренд-строка процессора описывает и GPU: "Apple M2 Pro".
    acceleratorName = (await run('sysctl', ['-n', 'machdep.cpu.brand_string'])) ?? cpuModel
    usableMemoryBytes = Math.floor(totalMemoryBytes * UNIFIED_MEMORY_USABLE_FRACTION)
  } else {
    const nvidia = await detectNvidia()
    if (nvidia) {
      accelerator = 'cuda'
      acceleratorName = nvidia.name
      usableMemoryBytes = Math.floor(nvidia.vramBytes * DISCRETE_VRAM_USABLE_FRACTION)
    } else {
      const amd = await detectAmd()
      if (amd) {
        accelerator = 'rocm'
        acceleratorName = amd.name
        usableMemoryBytes = amd.vramBytes
          ? Math.floor(amd.vramBytes * DISCRETE_VRAM_USABLE_FRACTION)
          : Math.floor(totalMemoryBytes * CPU_ONLY_USABLE_FRACTION)
      }
    }
  }

  cached = {
    platform,
    arch,
    cpuModel,
    cpuCores: cpus.length,
    totalMemoryBytes,
    usableMemoryBytes,
    accelerator,
    acceleratorName,
    unifiedMemory,
    freeDiskBytes: await freeDiskBytes(homedir()),
  }

  return cached
}

/** Сбрасывает кэш. Нужен только тестам. */
export function resetHardwareCache(): void {
  cached = null
}
