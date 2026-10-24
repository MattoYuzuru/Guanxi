import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { coreArguments, matrix, readJSON, root, tasks, validateInventory } from './tasks.mjs'

export async function runTask(id) {
  validateInventory()
  const task = tasks.find(t => t.id === id)
  if (!task) throw new Error(`Unknown CI task ${id}`)
  const results = resolve(root, '.ci-results')
  mkdirSync(results, { recursive: true })
  const log = resolve(results, `${id}.log`)
  writeFileSync(log, '')
  const commands = task.coreShard
    ? [[process.execPath, ...coreArguments(readJSON(resolve(root, 'package.json')).scripts['test:core'], task.coreShard, resolve(results, `${id}.xml`))]]
    : task.commands
  const started = new Date().toISOString()
  let code = 0
  for (const [executable, ...args] of commands) {
    const child = spawn(executable === 'node' ? process.execPath : executable, args, { cwd: root, env: { ...process.env, GUANXI_DATA_DIR: resolve(root, '.lane-data') }, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { process.stdout.write(data); appendFileSync(log, data) })
    code = await new Promise((accept, reject) => { child.on('error', reject); child.on('exit', (value, signal) => accept(signal ? 1 : value ?? 1)) })
    if (code !== 0) break
  }
  const result = { task: id, code, started, finished: new Date().toISOString(), platform: process.platform, node: process.version }
  writeFileSync(resolve(results, `${id}.json`), JSON.stringify(result, null, 2) + '\n')
  return code
}

if (process.argv[1] === import.meta.filename) {
  try {
    const [command, value] = process.argv.slice(2)
    if (command === 'plan') {
      validateInventory()
      const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {}
      const full = process.env.GITHUB_EVENT_NAME !== 'push' && (process.env.GITHUB_EVENT_NAME !== 'pull_request' || !event.pull_request?.draft)
      const result = matrix(full)
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(result)}\nfull=${full}\n`)
      console.log(JSON.stringify({ full, ...result }, null, 2))
    } else if (command === 'run') process.exitCode = await runTask(value)
    else throw new Error('Usage: node scripts/ci/run.mjs plan | run TASK')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
