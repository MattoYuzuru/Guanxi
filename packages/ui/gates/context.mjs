import { readFile, readdir } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
export async function createContext(root = repositoryRoot, overrides = {}) {
  const read = async path => {
    const key = relative(root, resolve(root, path)).replaceAll('\\', '/')
    return Object.hasOwn(overrides, key) ? overrides[key] : readFile(resolve(root, key), 'utf8')
  }
  async function walk(dir) {
    let entries
    try { entries = await readdir(resolve(root, dir), { withFileTypes: true }) } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    return (await Promise.all(entries.filter(e => !['node_modules', 'dist', 'build', 'test-results', '.git'].includes(e.name)).sort((a, b) => a.name.localeCompare(b.name, 'en')).map(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]))).flat()
  }
  const files = [...new Set([...(await walk('packages/web')), ...(await walk('packages/ui')), ...Object.keys(overrides)])].sort()
  return { root, files, read, json: async path => JSON.parse(await read(resolve(root, path))), tokenOptions: { root: resolve(root, 'packages/ui/tokens'), read: async path => JSON.parse(await read(path)) },
    withFiles: extra => createContext(root, { ...overrides, ...extra }) }
}

export const sourceFiles = ctx => ctx.files.filter(f => /\.(?:[cm]?[jt]sx?|css)$/.test(f)
  && !/\/(?:tokens|generated|gates|fonts|brand|test|tests|__tests__)\//.test(f)
  && !/\.(?:test|spec)\./.test(f))
export const variableFiles = ctx => ctx.files.filter(f => /\.(?:tsx?|css)$/.test(f)
  && !/\/(?:tokens|gates|fonts|brand|test|tests|__tests__)\//.test(f)
  && !/\.(?:test|spec)\./.test(f))
