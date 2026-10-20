import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'
import { harnessPort } from '../../../catalog/harness/port.ts'

// Inside the pinned image the harness port is private to the container; on the host it is
// the lane's web port (strict: a busy port fails instead of testing someone else's server).
const port = process.env['GUANXI_GATE_DOCKER'] === '1' ? 4173 : harnessPort(process.env)
const harness = fileURLToPath(new URL('../../../catalog/harness/dist', import.meta.url))
const server = fileURLToPath(new URL('./static-server.mjs', import.meta.url))
const report = process.env['GUANXI_GATE_REPORT']

export default defineConfig({
  testDir: '.',
  testMatch: /g1[3-6]-.*\.spec\.ts$/,
  // Failure artifacts (traces, error-context.md) stay out of the checkout and out of lint:md.
  outputDir: join(tmpdir(), 'guanxi-ui-gate-artifacts'),
  fullyParallel: true,
  workers: Number(process.env['GUANXI_GATE_WORKERS'] || 2),
  retries: 0,
  reporter: report ? [['json', { outputFile: report }], ['line']] : 'line',
  snapshotPathTemplate: '{testDir}/../../../catalog/snapshots/{arg}{ext}',
  expect: {
    // Exact pixels: baselines come only from the pinned image, so rendering is deterministic and
    // any token change (even a subtle fill) must show.
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css', maxDiffPixels: 0, threshold: 0 },
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: 'chromium',
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    // One raster path for every layer: with OKLCH tokens, antialiased edges differed by one
    // colour step depending on which path Chromium picked for a layer, which in turn depended
    // on the stories rendered before (G13 failed on error-state corners in isolated runs).
    launchOptions: {
      args: ['--disable-gpu', '--disable-gpu-rasterization', '--disable-partial-raster', '--disable-lcd-text', '--force-color-profile=srgb'],
    },
  },
  webServer: {
    command: `node ${JSON.stringify(server)} ${JSON.stringify(harness)} ${port}`,
    url: `http://127.0.0.1:${port}/index.html`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
