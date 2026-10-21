import { start } from '../../src/index.ts'

const app = await start({ dataDir: process.argv[2]!, port: 0, webDir: '/nonexistent' })
const store = app.kernel.durableRuns!.store
store.start(store.create({ id: 'inherited' }).id)
process.stdout.write('started\n')
process.kill(process.pid, 'SIGKILL')
