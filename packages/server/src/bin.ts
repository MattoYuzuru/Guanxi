import { start } from './index.ts'
import { ms1LiveFromEnv } from './ms1-live/config.ts'

// `GUANXI_MS1_LIVE_CONFIG` opts into one half of the MS1 live pairing; unset, this is the plain boot.
const ms1Live = ms1LiveFromEnv(process.env)
const { url } = await start(ms1Live ? { ms1Live } : {})
console.log(`Guanxi слушает ${url}`)
