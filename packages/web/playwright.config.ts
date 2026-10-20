import { defineConfig, devices } from '@playwright/test'

// Must match the port vite.config.ts reads, so parallel worktrees never test each other's server.
const webPort = process.env['GUANXI_WEB_PORT'] || '5173'
const baseURL = `http://127.0.0.1:${webPort}`

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL,
    ...devices['Desktop Chrome'],
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
