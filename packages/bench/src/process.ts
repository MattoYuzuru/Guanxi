import { spawn } from 'node:child_process'
/** No inherited provider keys; outputs stay in memory and errors expose codes only. */
export async function processJson(command: string, args: string[], input: unknown, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' } })
    const output: Buffer[] = []; let bytes = 0; let failed = false; let stopping = false
    const fail = () => { if (stopping) return; stopping = true; failed = true; child.kill('SIGTERM'); timer = setTimeout(() => child.kill('SIGKILL'), 1000); timer.unref() }
    let timer: ReturnType<typeof setTimeout> | undefined
    const aborted = () => fail()
    signal?.addEventListener('abort', aborted, { once: true })
    child.stdin.on('error', fail)
    child.stdin.end(JSON.stringify(input))
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 4 * 1024 * 1024) fail()
      else output.push(chunk)
    })
    child.on('error', () => { failed = true })
    child.on('close', code => {
      signal?.removeEventListener('abort', aborted)
      if (timer) clearTimeout(timer)
      if (failed || code !== 0 || signal?.aborted) return reject(new Error(signal?.aborted ? 'cancelled' : 'external_process_failed'))
      try { resolve(JSON.parse(Buffer.concat(output).toString('utf8'))) } catch { reject(new Error('malformed_result')) }
    })
    if (signal?.aborted) fail()
  })
}
