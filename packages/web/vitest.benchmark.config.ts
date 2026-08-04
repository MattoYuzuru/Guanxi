import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

const contractSrc = fileURLToPath(new URL('../contract/src/index.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@alamo/contract': contractSrc,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/benchmark/**/*.test.tsx'],
    restoreMocks: true,
  },
})
