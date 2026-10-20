import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const contractSrc = fileURLToPath(new URL('../contract/src/index.ts', import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Контракт исполняется из исходников (внутри — импорты с .ts),
      // поэтому резолвим его напрямую и не даём Vite его пре-бандлить.
      '@guanxi/contract': contractSrc,
    },
  },
  optimizeDeps: {
    exclude: ['@guanxi/contract'],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4310',
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
