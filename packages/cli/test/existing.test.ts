import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { afterEach, it } from 'node:test'
import { probeExistingAlamo } from '../src/existing.ts'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    ),
  )
})

async function serve(body: string, contentType = 'text/html'): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': contentType })
    response.end(body)
  })
  servers.push(server)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

it('узнаёт полноценный интерфейс Alamo', async () => {
  const url = await serve('<!doctype html><title>Alamo UI</title><div id="root"></div>')
  assert.deepEqual(await probeExistingAlamo(url), { kind: 'ui', url })
})

it('отличает старый API-only процесс без сборки фронтенда', async () => {
  const url = await serve(
    'Alamo UI 0.1.0\n\nСборка фронта не найдена (/tmp/web).\nAPI доступен на /api/health',
    'text/plain',
  )
  assert.deepEqual(await probeExistingAlamo(url), {
    kind: 'api-only',
    url,
    version: '0.1.0',
  })
})

it('не принимает произвольный сайт за Alamo', async () => {
  const url = await serve('<!doctype html><title>Другое приложение</title>')
  assert.equal(await probeExistingAlamo(url), null)
})
