// A stand-in for the Guanxi node used by the shell's tests. It takes the CLI's flags
// (--port --host --data-dir --no-open), answers the health document and a page shaped like the UI, and
// has a "run": POST /api/test/run starts a timer that appends one line per tick to <dataDir>/run-ticks.log,
// so a test can prove the run keeps going after the window and the app are gone.
// GUANXI_FAKE_MODE selects a failure: never-listen | exit-early | no-ui | slow-health.
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const port = Number(option('--port'))
const host = option('--host') ?? '127.0.0.1'
const dataDir = option('--data-dir')
const mode = process.env['GUANXI_FAKE_MODE'] ?? ''
const other = process.env['GUANXI_FAKE_OTHER_ORIGIN'] ?? ''

mkdirSync(dataDir, { recursive: true })
// What the service (and a tool it starts, as the node's bash tool does with `...process.env`) is given.
const keys = (env) => Object.keys(env).filter((key) => key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS' || key === 'HOST' || key.startsWith('GUANXI_DESKTOP_'))
const toolEnv = JSON.parse(execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify(Object.keys(process.env)))'], { env: process.env, encoding: 'utf8' }))
writeFileSync(join(dataDir, 'fake-service-args.json'), JSON.stringify({
  args, execPath: process.execPath, electronVersion: process.versions.electron ?? null,
  leakedKeys: keys(process.env), toolLeakedKeys: toolEnv.filter((key) => keys({ [key]: 1 }).length > 0),
}))

if (mode === 'exit-early') {
  console.error('fake-service: refusing to start (exit-early)')
  process.exit(3)
}
if (mode === 'never-listen') {
  console.log('fake-service: alive but never listens')
  setInterval(() => {}, 1_000)
} else {
  const ticksFile = join(dataDir, 'run-ticks.log')
  let timer = null
  let ticks = 0
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Guanxi</title></head>
<body>
<div id="root"><h1 id="fake-title">Fake Guanxi</h1></div>
<a id="ext" href="https://example.com/ext">external</a>
<a id="ext-blank" target="_blank" href="https://example.com/blank">external blank</a>
<a id="internal" href="/second">internal</a>
<button id="copy" type="button">copy</button>
<button id="open-ext" type="button">open external</button>
<button id="notify" type="button">notify</button>
<script>
  try { new Function('return 1')(); window.__evalAtLoad = 'ran' } catch (error) { window.__evalAtLoad = error.name }
  document.getElementById('copy').addEventListener('click', () => {
    navigator.clipboard.writeText('copied-by-the-page').then(() => { window.__copy = 'ok' }, (error) => { window.__copy = 'error:' + error.name })
  })
  document.getElementById('open-ext').addEventListener('click', () => { window.open('https://example.com/from-click') })
  document.getElementById('notify').addEventListener('click', () => {
    Notification.requestPermission().then((value) => { window.__notify = value })
  })
  window.__probe = {
    typeofRequire: typeof require, typeofProcess: typeof process, typeofModule: typeof module,
    typeofBuffer: typeof Buffer, typeofFilename: typeof __filename, typeofGlobal: typeof global,
  }
</script>
</body></html>`
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x')
    if (url.pathname === '/api/health') {
      const send = () => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ ok: true, appVersion: '0.0.0-fake', application: { state: 'reachable', source: 'application_http', observedAt: new Date().toISOString() } }))
      }
      if (mode === 'slow-health') setTimeout(send, 60_000)
      else send()
      return
    }
    if (url.pathname === '/api/test/run' && request.method === 'POST') {
      if (timer === null) {
        timer = setInterval(() => {
          ticks += 1
          appendFileSync(ticksFile, `${ticks}\n`)
        }, 50)
      }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ running: true, pid: process.pid }))
      return
    }
    if (url.pathname === '/api/test/run') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ running: timer !== null, ticks, pid: process.pid }))
      return
    }
    if (url.pathname === '/redirect') {
      response.statusCode = 302
      response.setHeader('location', `${other}/redirected`)
      response.end()
      return
    }
    if (mode === 'no-ui') {
      response.setHeader('content-type', 'text/plain; charset=utf-8')
      response.end('Guanxi 0.0.0-fake\n\nСборка фронта не найдена (/nowhere).\n')
      return
    }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    if (url.pathname === '/popout.html') {
      response.end(`<!doctype html><title>popout</title><div id="root"><p id="popout">popout</p></div><script>window.__probe = { typeofRequire: typeof require, typeofProcess: typeof process }</script>`)
      return
    }
    response.end(url.pathname === '/second' ? page.replace('Fake Guanxi', 'Second page') : page)
  })
  server.listen(port, host, () => console.log(`fake-service: listening on ${host}:${port}`))
  server.on('error', (error) => {
    console.error(`fake-service: ${error.code ?? error.message}`)
    process.exit(1)
  })
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (timer !== null) clearInterval(timer)
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 500).unref()
    })
  }
}
