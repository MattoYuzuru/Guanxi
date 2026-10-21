import { cpus, freemem, totalmem, loadavg, platform } from 'node:os'
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'

export interface HeadroomObservation {
  observedAt: string
  source: string
  confidence: 'observed' | 'partial'
  memoryAvailableFraction: number
  cpuBusyFraction: number
  thermal: 'nominal' | 'pressure' | 'unknown'
  foreground: 'active' | 'idle' | 'unknown'
  allowed: boolean
}
const command = (path: string, args: string[]) => new Promise<string>(resolve => execFile(path, args, { timeout: 1000, maxBuffer: 256 * 1024 }, (error, out) => resolve(error ? '' : out)))
/** Bounded local observations only. No foreground app/window names are read. */
export class HeadroomMonitor {
  private previous: { idle: number; total: number } | undefined
  async sample(): Promise<HeadroomObservation> {
    const counters = cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0) }), { idle: 0, total: 0 })
    const previous = this.previous
    this.previous = counters
    const cpu = previous && counters.total > previous.total ? 1 - (counters.idle - previous.idle) / (counters.total - previous.total) : Math.min(1, loadavg()[0]! / Math.max(1, cpus().length))
    let memory = freemem() / totalmem(), thermal: HeadroomObservation['thermal'] = 'unknown', foreground: HeadroomObservation['foreground'] = 'unknown'
    if (platform() === 'darwin') {
      const [pressure, therm, hid] = await Promise.all([command('/usr/bin/memory_pressure', ['-Q']), command('/usr/bin/pmset', ['-g', 'therm']), command('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-r', '-d', '1'])])
      const available = /System-wide memory free percentage:\s*(\d+)%/.exec(pressure)
      if (available) memory = Number(available[1]) / 100
      if (/No thermal warning level has been recorded/.test(therm)) thermal = 'nominal'
      else if (/CPU_Speed_Limit\s*=\s*100/.test(therm)) thermal = 'nominal'
      else if (/CPU_Speed_Limit|Thermal_Level|thermal warning/i.test(therm)) thermal = 'pressure'
      const idle = /"HIDIdleTime"\s*=\s*(\d+)/.exec(hid)
      if (idle) foreground = Number(idle[1]) / 1e9 < 60 ? 'active' : 'idle'
    } else if (platform() === 'linux') {
      try {
        const info = await readFile('/proc/meminfo', 'utf8')
        const available = /MemAvailable:\s*(\d+)/.exec(info), total = /MemTotal:\s*(\d+)/.exec(info)
        if (available && total) memory = Number(available[1]) / Number(total[1])
        const zones = (await readdir('/sys/class/thermal')).filter(n => /^thermal_zone\d+$/.test(n))
        if (zones.length) thermal = (await Promise.all(zones.map(n => readFile(`/sys/class/thermal/${n}/temp`, 'utf8')))).some(t => Number(t) > 80_000) ? 'pressure' : 'nominal'
      } catch { /* unknown observations retain extra headroom */ }
    }
    const conservative = foreground !== 'idle' || thermal === 'unknown'
    return { observedAt: new Date().toISOString(), source: `node:os+${platform() === 'darwin' ? 'memory_pressure/pmset/IOHID-idle' : 'procfs/sysfs'}`, confidence: thermal === 'unknown' || foreground === 'unknown' ? 'partial' : 'observed',
      memoryAvailableFraction: memory, cpuBusyFraction: cpu, thermal, foreground,
      allowed: thermal !== 'pressure' && memory >= (conservative ? 0.15 : 0.08) && cpu <= (conservative ? 0.65 : 0.85) }
  }
}
