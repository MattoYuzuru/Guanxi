/**
 * Test-only TLS material and HTTPS client for the remote-profile boot tests.
 *
 * The key pair is generated per run with the system `openssl` into a private temp directory and
 * deleted by the caller; nothing is committed and nothing is shared between runs.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const TLS_TEST_HOSTNAME = 'node.example.test'

export interface TlsFixture {
  dir: string
  certPath: string
  keyPath: string
  cleanup(): void
}

export function makeTlsFixture(hostname: string = TLS_TEST_HOSTNAME): TlsFixture {
  const dir = mkdtempSync(join(tmpdir(), 'guanxi-tls-'))
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', `/CN=${hostname}`,
  ], { stdio: 'ignore' })
  return { dir, certPath, keyPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export interface HttpsResult {
  status: number
  body: string
}

/** One HTTPS request to `connectHost:port` with an explicit Host header; the throwaway cert is not verified. */
export function httpsGet(port: number, path: string, headers: Record<string, string> = {}, connectHost = '127.0.0.1'): Promise<HttpsResult> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host: connectHost, port, path, method: 'GET', headers, rejectUnauthorized: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.once('error', reject)
    req.end()
  })
}
