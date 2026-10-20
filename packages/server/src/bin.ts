import { start } from './index.ts'

const { url } = await start()
console.log(`Guanxi слушает ${url}`)
