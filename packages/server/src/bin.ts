import { start } from './index.ts'

const { url } = await start()
console.log(`Alamo UI слушает ${url}`)
