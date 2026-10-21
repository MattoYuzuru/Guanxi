import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { apiPortFromEnv, webPortFromEnv } from './dev-ports.ts'

const contractSrc = fileURLToPath(new URL('../contract/src/index.ts', import.meta.url))
const uiRoot = fileURLToPath(new URL('../ui', import.meta.url))
const webPort = webPortFromEnv(process.env)
const apiPort = apiPortFromEnv(process.env)

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      // Контракт исполняется из исходников (внутри — импорты с .ts),
      // поэтому резолвим его напрямую и не даём Vite его пре-бандлить.
      { find: '@guanxi/contract', replacement: contractSrc },
      // @guanxi/ui is source too; only the lazily loaded catalog route imports it today.
      { find: /^@guanxi\/ui\/catalog$/, replacement: `${uiRoot}/catalog/index.ts` },
      // Match the root only so public CSS/asset subpaths use package exports.
      { find: /^@guanxi\/ui$/, replacement: `${uiRoot}/src/index.ts` },
    ],
  },
  optimizeDeps: {
    exclude: ['@guanxi/contract', '@guanxi/ui'],
    // The dependency scanner does not follow import.meta.glob (catalog stories), so Base UI
    // would be discovered late and pre-bundled with a second React copy. List it up front.
    include: [
      '@base-ui/react/button',
      '@base-ui/react/checkbox',
      '@base-ui/react/dialog',
      '@base-ui/react/input',
      '@base-ui/react/menu',
      '@base-ui/react/popover',
      '@base-ui/react/select',
      '@base-ui/react/switch',
      '@base-ui/react/tabs',
      '@base-ui/react/toast',
      '@base-ui/react/tooltip',
    ],
  },
  server: {
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        // SSE поверх POST: буферизация прокси убила бы стрим.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              delete proxyRes.headers['content-length']
            }
          })
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          markdown: ['marked', 'dompurify', 'highlight.js'],
          carousel: ['embla-carousel-react'],
        },
      },
    },
  },
})
