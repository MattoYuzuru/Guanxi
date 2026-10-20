import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const port = Number(process.env['GUANXI_WEB_PORT'] || 5173)

/** Static build of the catalog harness for the browser gates; never shipped. */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react()],
  server: { port, strictPort: true, host: '127.0.0.1' },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
})
