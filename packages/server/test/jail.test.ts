/**
 * Тесты изоляции файловых операций.
 *
 * Это единственная преграда между агентом и остальным диском, поэтому проверяются
 * не только очевидные `..`, но и симлинки наружу и пути-соседи с общим префиксом.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { PathOutsideWorkspaceError, relativeToWorkspace, resolveInWorkspace } from '../src/tools/jail.ts'

let base: string
let root: string
let outside: string

before(() => {
  // realpath обязателен: на macOS /var и /tmp — симлинки на /private/...
  base = realpathSync(mkdtempSync(join(tmpdir(), 'alamo-jail-')))
  root = join(base, 'workspace')
  outside = join(base, 'outside')

  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(outside, { recursive: true })

  writeFileSync(join(root, 'src', 'index.ts'), 'export {}')
  writeFileSync(join(outside, 'secret.txt'), 'секрет')

  // Сосед с общим строковым префиксом: /…/workspace-evil против /…/workspace.
  mkdirSync(join(base, 'workspace-evil'), { recursive: true })
  writeFileSync(join(base, 'workspace-evil', 'payload.txt'), 'чужое')

  symlinkSync(outside, join(root, 'escape-link'), 'dir')
  symlinkSync(join(outside, 'secret.txt'), join(root, 'secret-link.txt'), 'file')
})

after(() => {
  rmSync(base, { recursive: true, force: true })
})

const rejects = (path: string) =>
  assert.throws(() => resolveInWorkspace(root, path), PathOutsideWorkspaceError, `должен отклонить: ${path}`)

describe('resolveInWorkspace — разрешает', () => {
  it('относительный путь к существующему файлу', () => {
    assert.equal(resolveInWorkspace(root, 'src/index.ts'), join(root, 'src', 'index.ts'))
  })

  it('сам корень воркспейса', () => {
    assert.equal(resolveInWorkspace(root, '.'), root)
  })

  it('абсолютный путь внутри воркспейса', () => {
    assert.equal(resolveInWorkspace(root, join(root, 'src')), join(root, 'src'))
  })

  it('ещё не существующий файл — агент имеет право создавать', () => {
    assert.equal(resolveInWorkspace(root, 'src/new-file.ts'), join(root, 'src', 'new-file.ts'))
  })

  it('ещё не существующую вложенную директорию', () => {
    assert.equal(resolveInWorkspace(root, 'a/b/c/file.md'), join(root, 'a', 'b', 'c', 'file.md'))
  })

  it('«..», которые не выводят за пределы корня', () => {
    assert.equal(resolveInWorkspace(root, 'src/../src/index.ts'), join(root, 'src', 'index.ts'))
  })
})

describe('resolveInWorkspace — отклоняет', () => {
  it('обход через ..', () => {
    rejects('../outside/secret.txt')
    rejects('src/../../outside/secret.txt')
    rejects('../../../../../../etc/passwd')
  })

  it('абсолютный путь мимо воркспейса', () => {
    rejects(join(outside, 'secret.txt'))
    rejects('/etc/passwd')
  })

  it('симлинк на директорию наружу', () => {
    rejects('escape-link/secret.txt')
  })

  it('симлинк на файл наружу', () => {
    rejects('secret-link.txt')
  })

  it('соседнюю директорию с общим строковым префиксом', () => {
    // Наивная проверка startsWith без разделителя пропустила бы этот путь.
    rejects(join(base, 'workspace-evil', 'payload.txt'))
  })

  it('«..» в ещё не существующем хвосте пути', () => {
    rejects('newdir/../../outside/secret.txt')
  })

  it('путь с нулевым байтом', () => {
    rejects('src/index.ts\0.png')
  })
})

describe('relativeToWorkspace', () => {
  it('обрезает корень для показа в интерфейсе', () => {
    assert.equal(relativeToWorkspace(root, join(root, 'src', 'index.ts')), 'src/index.ts')
    assert.equal(relativeToWorkspace(root, root), '.')
  })
})
