/**
 * Browser gates G13–G16. Each run builds the catalog harness once, then runs one Playwright
 * spec over the stories in scope (all component stories, or a seeded fixture) and turns
 * failed tests into findings. G13 runs only inside the pinned Playwright image.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { readInventory, readStories } from '../../../catalog/tooling/inventory.ts'
import { result, type CatalogGate, type GateContext, type GateFinding, type GateResult } from '../types.ts'
import type { GateStory } from './stories.ts'

/** Pinned to the @playwright/test version in package-lock.json, by digest. */
export const PLAYWRIGHT_IMAGE =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e'

const built = new Set<string>()

function buildHarness(uiRoot: string): string | null {
  if (built.has(uiRoot)) return null
  const run = spawnSync('npx', ['vite', 'build', '--config', 'catalog/harness/vite.config.ts', '--logLevel', 'warn'], {
    cwd: uiRoot,
    encoding: 'utf8',
  })
  if (run.status !== 0) return `harness build failed: ${run.stderr || run.stdout}`
  built.add(uiRoot)
  return null
}

export function componentStories(uiRoot: string): GateStory[] {
  const inventory = readInventory(uiRoot)
  return inventory.folders
    .filter((folder) => inventory.publicFolders.includes(folder.id))
    .flatMap((folder) =>
      folder.stories.map((story) => ({
        key: `${folder.id}--${story.name ?? story.exportName}`,
        component: folder.id,
        state: story.name ?? story.exportName,
        level: folder.docs?.level ?? 'primitive',
        frame: story.frame ?? 'inline',
      })),
    )
}

/** Fixture stories with seeded violations, keyed like component stories. */
export function fixtureStories(uiRoot: string, gate: string): GateStory[] {
  const dir = join(uiRoot, 'gates', 'catalog', 'fixtures', 'browser', gate)
  const file = join(dir, `${gate}.stories.tsx`)
  if (!existsSync(file)) return []
  return readStories(file).stories.map((story) => ({
    key: `${gate}--${story.name ?? story.exportName}`,
    component: gate,
    state: story.name ?? story.exportName,
    level: 'primitive',
    frame: story.frame ?? 'inline',
  }))
}

interface PlaywrightReport {
  suites?: PlaywrightSuite[]
  errors?: Array<{ message?: string }>
}
interface PlaywrightSuite {
  suites?: PlaywrightSuite[]
  specs?: Array<{ title: string; ok: boolean; tests: Array<{ results: Array<{ status: string; error?: { message?: string } }> }> }>
}

function failures(report: PlaywrightReport): GateFinding[] {
  const findings: GateFinding[] = []
  const visit = (suite: PlaywrightSuite) => {
    for (const spec of suite.specs ?? []) {
      if (spec.ok) continue
      const error = spec.tests.flatMap((test) => test.results).find((item) => item.error)?.error?.message ?? 'failed'
      const lines = error.replace(/\u001b\[[0-9;]*m/g, '').split('\n')
      // Keep the assertion line and the received values, which name the offending nodes.
      const detail = [lines[0], ...lines.filter((line) => /^\s*\+\s+"/.test(line))].join(' ').replace(/\s+/g, ' ')
      findings.push({ severity: 'error', message: `${spec.title}: ${detail}` })
    }
    for (const child of suite.suites ?? []) visit(child)
  }
  for (const suite of report.suites ?? []) visit(suite)
  for (const error of report.errors ?? []) findings.push({ severity: 'error', message: error.message ?? 'Playwright error' })
  return findings
}

function runSpec(
  gate: Pick<CatalogGate, 'id' | 'title'>,
  spec: string,
  context: GateContext,
  docker: boolean,
): GateResult {
  const problem = buildHarness(context.uiRoot)
  if (problem) return { id: gate.id, title: gate.title, status: 'fail', findings: [{ severity: 'error', message: problem }] }
  const stories =
    context.stories === undefined
      ? componentStories(context.uiRoot)
      : [...componentStories(context.uiRoot), ...fixtureStories(context.uiRoot, gate.id.toLowerCase())].filter((story) =>
          context.stories!.includes(story.key),
        )
  if (stories.length === 0) {
    return { id: gate.id, title: gate.title, status: 'fail', findings: [{ severity: 'error', message: 'no stories in scope' }] }
  }
  const reportDir = mkdtempSync(join(context.uiRoot, 'catalog', 'harness', 'dist', '.report-'))
  const reportFile = join(reportDir, 'report.json')
  const env: Record<string, string> = {
    GUANXI_GATE_STORIES: JSON.stringify(stories),
    GUANXI_GATE_FIXTURES: context.fixtures ? '1' : '0',
    GUANXI_GATE_SEED: context.seed ?? '',
    GUANXI_GATE_REPORT: docker ? `/work/packages/ui/${relative(context.uiRoot, reportFile)}` : reportFile,
    // CI uploads this mounted directory after --rm removes the G13 container.
    ...(process.env['GITHUB_ACTIONS'] === 'true' ? {
      GUANXI_GATE_ARTIFACTS: join(docker ? '/work' : join(context.uiRoot, '..', '..'), '.ci-results', 'catalog', `${gate.id}-${basename(reportDir)}`),
    } : {}),
  }
  const playwrightArgs = ['playwright', 'test', '--config', 'gates/catalog/browser/playwright.config.ts', `gates/catalog/browser/${spec}`]
  if (context.updateSnapshots) playwrightArgs.push('--update-snapshots')
  try {
    const run = docker
      ? spawnSync(
          'docker',
          [
            'run', '--rm', '--ipc=host', '--init',
            '-v', `${join(context.uiRoot, '..', '..')}:/work`,
            '-w', '/work/packages/ui',
            ...Object.entries({ ...env, GUANXI_GATE_DOCKER: '1', CI: '1' }).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
            PLAYWRIGHT_IMAGE,
            'npx', ...playwrightArgs,
          ],
          { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
        )
      : spawnSync('npx', playwrightArgs, {
          cwd: context.uiRoot,
          encoding: 'utf8',
          env: { ...process.env, ...env },
          maxBuffer: 64 * 1024 * 1024,
        })
    let findings: GateFinding[] = []
    if (existsSync(reportFile)) findings = failures(JSON.parse(readFileSync(reportFile, 'utf8')) as PlaywrightReport)
    if (run.status !== 0 && findings.length === 0) {
      findings.push({ severity: 'error', message: `Playwright exited ${run.status}: ${(run.stderr || run.stdout).slice(-2000)}` })
    }
    return result(gate, findings)
  } finally {
    rmSync(reportDir, { recursive: true, force: true })
  }
}

function dockerAvailable(): string | null {
  const info = spawnSync('docker', ['image', 'inspect', PLAYWRIGHT_IMAGE, '--format', '{{.Id}}'], { encoding: 'utf8' })
  if (info.error) return 'docker CLI unavailable'
  if (info.status !== 0) return `pinned image not present (docker pull ${PLAYWRIGHT_IMAGE})`
  return null
}

export const g13: CatalogGate = {
  id: 'G13',
  title: 'Visual regression',
  mode: 'browser',
  async run(context) {
    const missing = dockerAvailable()
    if (missing) {
      // Never a silent pass: without the pinned image the gate fails unless explicitly skipped.
      if (process.env['GUANXI_UI_G13'] === 'skip') return { id: this.id, title: this.title, status: 'skipped', findings: [], reason: missing }
      return { id: this.id, title: this.title, status: 'fail', findings: [{ severity: 'error', message: `G13 needs the pinned Playwright image: ${missing}` }] }
    }
    const baselines = join(context.uiRoot, 'catalog', 'snapshots')
    if (!context.updateSnapshots && !existsSync(baselines)) {
      return { id: this.id, title: this.title, status: 'fail', findings: [{ severity: 'error', message: 'no baselines; run npm run ui:snapshots' }] }
    }
    return runSpec(this, 'g13-visual.spec.ts', context, true)
  },
  seeded: [
    {
      name: 'semantic-token-changed',
      description: 'One semantic token (accent fill) changes; the Button baselines must no longer match',
      expect: /G13 button--default light: .*toHaveScreenshot/,
      apply: ({ context }) => ({ ...context, stories: ['button--default', 'button--secondary'], seed: 'g13' }),
    },
  ],
}

export const g14: CatalogGate = {
  id: 'G14',
  title: 'Accessibility (axe)',
  mode: 'browser',
  run(context) {
    return Promise.resolve(runSpec(this, 'g14-axe.spec.ts', context, false))
  },
  seeded: [
    {
      name: 'icon-button-without-name',
      description: 'An icon-only button with no accessible name',
      expect: /button-name/,
      apply: ({ context }) => ({ ...context, stories: ['g14--unnamed-icon-button'], fixtures: true }),
    },
  ],
}

export const g15Clipping: CatalogGate = {
  id: 'G15',
  title: 'i18n: no clipping in Russian or the +40% pseudo-locale',
  mode: 'browser',
  run(context) {
    return Promise.resolve(runSpec(this, 'g15-i18n-clipping.spec.ts', context, false))
  },
  seeded: [
    {
      name: 'frame-clip',
      description: 'The regime frame itself clips the story',
      expect: /clipped text in g15--frame-clip \(ru\).*data-gx-regime/,
      apply: ({ context }) => ({ ...context, stories: ['g15--frame-clip'], fixtures: true }),
    },
    {
      name: 'fixed-width-label',
      description: 'A label in a fixed-width box that hides overflow',
      expect: /clipped text in g15--fixed-width-label \(ru\).*gx-seeded-fixed-width/,
      apply: ({ context }) => ({ ...context, stories: ['g15--fixed-width-label'], fixtures: true }),
    },
  ],
}

export const g16: CatalogGate = {
  id: 'G16',
  title: 'Reduced motion',
  mode: 'browser',
  run(context) {
    return Promise.resolve(runSpec(this, 'g16-reduced-motion.spec.ts', context, false))
  },
  seeded: [
    {
      name: 'finite-entry-motion',
      description: 'One finite entry rotation with no reduced-motion rule',
      expect: /G16 g16--finite-entry os: .*moves (transform|rotate)/,
      apply: ({ context }) => ({ ...context, stories: ['g16--finite-entry'], fixtures: true }),
    },
    {
      name: 'interaction-motion',
      description: 'A thumb that slides when toggled, whatever the motion setting',
      expect: /G16 g16--sliding-toggle setting: .*moves transform/,
      apply: ({ context }) => ({ ...context, stories: ['g16--sliding-toggle'], fixtures: true }),
    },
    {
      name: 'spinner-ignores-reduced-motion',
      description: 'A looping spinner with no reduced-motion rule',
      expect: /loops: span\.gx-seeded-spinner/,
      apply: ({ context }) => ({ ...context, stories: ['g16--looping-spinner'], fixtures: true }),
    },
  ],
}

export const browserGates: CatalogGate[] = [g13, g14, g15Clipping, g16]
