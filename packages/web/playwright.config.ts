import { defineConfig, devices } from '@playwright/test'
import { webPortFromEnv } from './dev-ports.ts'

// Same parser as vite.config.ts, so parallel worktrees never test each other's server.
const baseURL = `http://127.0.0.1:${webPortFromEnv(process.env)}`

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL,
    ...devices['Desktop Chrome'],
    // A browser-context option: under `use` directly it was not a known option and was ignored.
    contextOptions: { reducedMotion: 'reduce' },
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
