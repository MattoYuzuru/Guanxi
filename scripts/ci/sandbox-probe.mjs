// A synthetic, secret-free preflight. Never print runtime diagnostics for real workspaces.
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { sandboxCommand } from '../../packages/server/src/native-agent/sandbox.ts'

if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux') throw new Error('Hosted Linux preflight only')
await mkdir('.lane-data', { recursive: true })
const directory = await mkdtemp(join(process.cwd(), '.lane-data', 'ci-preflight-'))
try {
  const scratch = join(directory, 'scratch')
  await mkdir(scratch)
  const result = await sandboxCommand({ mode: 'read-only', scratch, runtimeBase: directory, roots: [], attachments: [], protectedPaths: [], domains: [] }, 'printf CI_SANDBOX_OK', undefined, 15_000)
  if (result.code !== 0 || result.stdout !== 'CI_SANDBOX_OK') throw new Error(JSON.stringify({ code: result.code, stderr: result.stderr }))
  console.log('Pinned runtime completed the synthetic sandbox preflight')
} finally { await rm(directory, { recursive: true, force: true }) }
