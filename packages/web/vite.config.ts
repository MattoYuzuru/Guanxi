import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const contractSrc = fileURLToPath(new URL('../contract/src/index.ts', import.meta.url))
const uiRoot = fileURLToPath(new URL('../ui', import.meta.url))

// Parallel worktrees each need their own ports; defaults match a single checkout.
function portFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a TCP port, got ${JSON.stringify(raw)}`)
  }
  return port
}

const webPort = portFromEnv('GUANXI_WEB_PORT', 5173)
const apiPort = portFromEnv('GUANXI_API_PORT', 4310)

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Контракт исполняется из исходников (внутри — импорты с .ts),
      // поэтому резолвим его напрямую и не даём Vite его пре-бандлить.
      '@guanxi/contract': contractSrc,
      // @guanxi/ui is source too; only the lazily loaded catalog route imports it today.
      '@guanxi/ui/catalog': `${uiRoot}/catalog/index.ts`,
      '@guanxi/ui/styles/token-stub.css': `${uiRoot}/src/styles/token-stub.css`,
      '@guanxi/ui': `${uiRoot}/src/index.ts`,
    },
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
