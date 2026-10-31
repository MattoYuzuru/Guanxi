import { start } from './index.ts'
import { RemoteBindError } from './auth/remote-guard.ts'
import { REMOTE_BIND_EXIT_CODE, remoteBindRefusalMessage } from './auth/remote-profile.ts'
import { ms1LiveFromEnv } from './ms1-live/config.ts'

// `GUANXI_MS1_LIVE_CONFIG` opts into one half of the MS1 live pairing; unset, this is the plain boot.
const ms1Live = ms1LiveFromEnv(process.env)
try {
  const { url } = await start(ms1Live ? { ms1Live } : {})
  console.log(`Guanxi слушает ${url}`)
} catch (error) {
  // A refused remote bind has one message and one exit code; every other failure keeps its stack.
  if (!(error instanceof RemoteBindError)) throw error
  console.error(remoteBindRefusalMessage(error))
  process.exit(REMOTE_BIND_EXIT_CODE)
}
