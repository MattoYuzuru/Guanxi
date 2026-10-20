import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

const contractSrc = fileURLToPath(new URL('../contract/src/index.ts', import.meta.url))
const uiRoot = fileURLToPath(new URL('../ui', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@guanxi/contract': contractSrc,
      '@guanxi/ui/catalog': `${uiRoot}/catalog/index.ts`,
      '@guanxi/ui': `${uiRoot}/src/index.ts`,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/component/**/*.test.tsx', 'test/unit/**/*.test.ts'],
    restoreMocks: true,
  },
})
