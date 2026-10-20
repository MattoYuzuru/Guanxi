import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { it } from 'node:test'
import { mountWeb } from '../src/index.ts'

it('начинает раздавать frontend, появившийся после запуска backend', async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'guanxi-web-serving-'))
  const webDir = join(root, 'web')
  await mkdir(webDir)
  test.after(() => rm(root, { recursive: true, force: true }))

  const app = new Hono()
  mountWeb(app, webDir)

  const beforeBuild = await app.request('/')
  assert.match(await beforeBuild.text(), /Сборка фронта не найдена/)

  await mkdir(join(webDir, 'assets'))
  await writeFile(
    join(webDir, 'index.html'),
    '<!doctype html><title>Guanxi</title><div id="root"></div>',
    'utf8',
  )
  await writeFile(join(webDir, 'assets', 'app.js'), 'window.GUANXI = true', 'utf8')

  const spaRoute = await app.request('/chat/example')
  assert.equal(spaRoute.status, 200)
  assert.match(spaRoute.headers.get('content-type') ?? '', /text\/html/)
  assert.match(await spaRoute.text(), /<div id="root"><\/div>/)

  const asset = await app.request('/assets/app.js')
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get('content-type') ?? '', /javascript/)
  assert.equal(await asset.text(), 'window.GUANXI = true')
})
