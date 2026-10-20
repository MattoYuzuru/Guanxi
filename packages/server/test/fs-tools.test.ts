import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { readFileTool } from '../src/tools/fs-tools.ts'

it('read_file не загружает и не возвращает файл целиком сверх безопасного лимита', async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'guanxi-read-file-'))
  test.after(() => rm(root, { recursive: true, force: true }))

  const target = join(root, 'large.txt')
  await writeFile(target, `первая строка\n${'x'.repeat(300_000)}\nEND_MARKER`, 'utf8')

  const result = await readFileTool.execute(
    { path: 'large.txt', limit: -10 },
    {
      workspaceRoot: root,
      enableBash: false,
      signal: new AbortController().signal,
    },
  )

  assert.match(result.content, /1\tпервая строка/)
  assert.match(result.content, /безопасного лимита чтения 262144 Б/)
  assert.doesNotMatch(result.content, /END_MARKER/)
  assert.ok(Buffer.byteLength(result.content, 'utf8') < 2_000)
})
