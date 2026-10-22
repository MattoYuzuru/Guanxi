import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
test('Python host, isolation, classification and exec adapters (offline fake upstream boundary)', () => {
  execFileSync('python3', ['-B', new URL('./test_python.py', import.meta.url).pathname], { env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe' })
})
