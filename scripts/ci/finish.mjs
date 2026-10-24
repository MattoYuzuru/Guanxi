import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tasks } from './tasks.mjs'

export const candidateArtifact = 'candidate'

export function completion({ pr, run, jobs, candidate, head }) {
  const reasons = []
  if (pr.draft || pr.state !== 'open') reasons.push('PR must be open and ready')
  if (pr.head.sha !== head || run.head_sha !== head || candidate.head !== head) reasons.push('head changed or CI belongs to another head')
  if (candidate.base !== pr.base.sha) reasons.push('base changed: validate a refreshed integration candidate')
  if (candidate.tested !== pr.merge_commit_sha) reasons.push('tested merge candidate is stale')
  if (run.event !== 'pull_request' || run.status !== 'completed' || run.conclusion !== 'success') reasons.push('full PR run has not succeeded')
  for (const name of ['Full gate', ...tasks.map(t => `check / ${t.id}`)]) {
    const matches = jobs.filter(j => j.name === name)
    if (matches.length !== 1 || matches[0].conclusion !== 'success' || matches[0].status !== 'completed') reasons.push(`${name}: missing, duplicate or not successful`)
  }
  return { ok: reasons.length === 0, reasons, head, tested: candidate.tested, base: candidate.base, run: run.html_url }
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const api = path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }))
export async function finish(number, wait = false) {
  if (!/^\d+$/.test(number ?? '')) throw new Error('Usage: npm run ci:finish -- PR_NUMBER [--wait]')
  if (git('status', '--porcelain')) throw new Error('Commit the reviewed candidate before checking final CI; worktree is dirty')
  const head = git('rev-parse', 'HEAD')
  const repo = JSON.parse(execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner'], { encoding: 'utf8' })).nameWithOwner
  const deadline = Date.now() + 45 * 60_000
  let delay = 10_000
  while (true) {
    const pr = api(`repos/${repo}/pulls/${number}`)
    if (pr.head.sha !== head) throw new Error('Local HEAD differs from the PR head')
    if (pr.draft) throw new Error('PR is draft: mark it ready once implementation and review are finished')
    const runs = api(`repos/${repo}/actions/workflows/full-gate.yml/runs?event=pull_request&head_sha=${head}&per_page=20`).workflow_runs
    const run = runs[0]
    if (run && run.status === 'completed') {
      const pages = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }))
      const directory = mkdtempSync(join(tmpdir(), 'guanxi-ci-'))
      let candidate
      try {
        execFileSync('gh', ['run', 'download', String(run.id), '--repo', repo, '--name', candidateArtifact, '--dir', directory], { stdio: ['ignore', 'ignore', 'pipe'] })
        candidate = JSON.parse(readFileSync(join(directory, 'candidate.json'), 'utf8'))
      } finally { rmSync(directory, { recursive: true, force: true }) }
      // Re-read after downloading: neither another actor's push nor local edits may slip through.
      if (git('rev-parse', 'HEAD') !== head || git('status', '--porcelain')) throw new Error('Local candidate changed while waiting')
      const result = completion({ pr: api(`repos/${repo}/pulls/${number}`), run, jobs: pages.flatMap(p => p.jobs), candidate, head })
      console.log(JSON.stringify(result, null, 2))
      return result.ok ? 0 : 1
    }
    if (!wait || Date.now() >= deadline) {
      console.log(JSON.stringify({ ok: false, pending: true, head, run: run?.html_url, reason: run ? 'CI is still running' : 'No full CI run found for this head' }))
      return 2
    }
    // Poll inside this process, not via repeated model/tool turns. No recurring status output.
    await new Promise(accept => setTimeout(accept, delay))
    delay = Math.min(30_000, delay * 1.5)
  }
}
if (process.argv[1] === import.meta.filename) {
  try { process.exitCode = await finish(process.argv[2], process.argv.includes('--wait')) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
