import { randomUUID } from 'node:crypto'
import { FEDERATION_VERSION } from '@guanxi/contract/federation'
import { canonical, FederationError, requestProof, signValue } from '../federation/crypto.ts'
import { RelayError } from '../relay/types.ts'
import { LlamaServerError } from '../runtime/llama-server/client.ts'
import { Ms1LiveError } from './config.ts'

/** One line of a preflight or doctor report. `code` is stable; `summary` and `fix` are for a person. */
export interface Check {
  id: string
  status: 'ok' | 'warn' | 'fail' | 'skip'
  summary: string
  code?: string
  fix?: string
  ms?: number
  data?: Record<string, unknown>
}
export const ok = (id: string, summary: string, data?: Record<string, unknown>): Check => ({ id, status: 'ok', summary, ...(data ? { data } : {}) })
export const fail = (id: string, code: string, summary: string, fix?: string): Check => ({ id, status: 'fail', code, summary, ...(fix ? { fix } : {}) })
export const warn = (id: string, code: string, summary: string, fix?: string): Check => ({ id, status: 'warn', code, summary, ...(fix ? { fix } : {}) })
export const skip = (id: string, summary: string): Check => ({ id, status: 'skip', summary })

/** Runs one named step, timing it; a thrown error becomes a failed check through `explain`. */
export async function step(id: string, body: () => Promise<Check>, explain: (error: unknown) => Omit<Check, 'id' | 'status'> & { code: string } = explainError): Promise<Check> {
  const began = Date.now()
  try { const check = await body(); return { ...check, ms: Date.now() - began } } catch (error) {
    const found = explain(error)
    return { id, status: 'fail', ms: Date.now() - began, ...found }
  }
}

/** Maps what can go wrong on the way to a peer onto a cause an operator can act on. Never includes message text or a key. */
export function explainError(error: unknown): Omit<Check, 'id' | 'status'> & { code: string } {
  if (error instanceof Ms1LiveError) return { code: error.code, summary: describeConfigError(error) }
  if (error instanceof FederationError) {
    if (error.code === 'peer_refused') {
      switch (error.status) {
        case 401: return { code: 'peer_rejected_key', summary: 'The peer does not accept this node\'s signature.',
          fix: 'Re-copy this node\'s peer-offer.json to the peer (its peer file must hold this node\'s current key) and check that both clocks agree within one minute.' }
        case 403: return { code: 'peer_forbidden', summary: 'The peer refused this node (host, owner account, trust or scope).',
          fix: 'A 403 is either the peer\'s Host check (the forwarded port must equal the port the peer listens on) or the identities (same accountId, trust owner_device, scopes attempts and replicas).' }
        case 409: return { code: 'peer_conflict', summary: 'The peer refused the request as inconsistent with its state.',
          fix: 'The usual cause is a model that differs from the one the executor serves (compare `model` with the llama-server --alias).' }
        case 426: return { code: 'peer_lacks_capability', summary: 'The peer does not offer the relay runtime.',
          fix: 'Start the executor in role "executor" with an attached llama-server, on the same Guanxi version as this node.' }
        case 429: return { code: 'peer_busy', summary: 'The peer is at one of its relay limits.', fix: 'Retry; see maxPinsPerPeer and maxConcurrentCountsPerPeer.' }
        case 503: return { code: 'peer_unavailable', summary: 'The peer accepted the request but could not serve it.',
          fix: 'On an executor this usually means its llama-server is unreachable, still loading or answering something unexpected: run preflight on the executor.' }
        default: return { code: 'peer_refused', summary: `The peer answered ${error.status}.` }
      }
    }
    if (['invalid_signature', 'relay_evidence_mismatch', 'wrong_executor'].includes(error.code)) {
      return { code: 'peer_key_mismatch', summary: 'The peer\'s answer was not signed by the key in this node\'s peer file.',
        fix: 'The peer file here does not belong to the node that answered: re-copy the executor\'s peer-offer.json, or check which node the forward points at.' }
    }
    if (error.code === 'contract_feature_unavailable') return { code: 'peer_lacks_capability', summary: 'The peer does not offer the relay runtime.',
      fix: 'Start the executor in role "executor" with an attached llama-server.' }
    return { code: error.code, summary: `The federation layer refused: ${error.code}.` }
  }
  if (error instanceof RelayError) return { code: error.code, summary: `The runtime refused: ${error.code}.` }
  if (error instanceof LlamaServerError) {
    return { code: error.code, summary: describeLlama(error.code),
      fix: error.code === 'llama_server_unavailable' ? 'Start llama-server (with --alias <model> --jinja) and check executor.llamaServer.baseUrl.' : undefined }
  }
  if (error instanceof Error && error.name === 'TimeoutError') return { code: 'peer_timeout', summary: 'The peer did not answer in time.',
    fix: 'The forwarded port accepts connections but nothing answers: check that the ssh forward points at the node\'s listening port and that the node runs. A cold executor needs minutes for its first model hash; raise link.requestTimeoutMs if so.' }
  if (error instanceof TypeError || (error instanceof Error && /fetch failed|ECONNREFUSED|ECONNRESET/.test(error.message))) {
    return { code: 'peer_unreachable', summary: 'Nothing is listening at the peer URL.',
      fix: 'Start the peer node and open the ssh forward (`ssh -N -L <port>:127.0.0.1:<port> ...`), then retry.' }
  }
  return { code: 'unexpected', summary: 'An unexpected error stopped this step.' }
}
function describeLlama(code: string): string {
  switch (code) {
    case 'llama_server_unavailable': return 'The llama-server is not reachable.'
    case 'llama_server_timeout': return 'The llama-server did not answer in time.'
    case 'llama_server_protocol': return 'The llama-server answered something this build does not understand.'
    default: return `The llama-server refused: ${code}.`
  }
}
export function describeConfigError(error: Ms1LiveError): string {
  const where = error.field ? ` (${error.field})` : ''
  const text: Record<string, string> = {
    config_unreadable: 'The configuration file cannot be read.', config_invalid_json: 'The configuration file is not valid JSON.',
    config_invalid: 'A configuration value is missing or has the wrong type.', config_unknown_key: 'The configuration has a key this version does not know.',
    config_section_required: 'A section this role needs is missing.', config_section_not_for_role: 'A section belongs to the other role.',
    config_url_not_loopback: 'Only http://127.0.0.1:<port> style URLs are allowed; the machines are linked by an ssh forward.',
    config_safety_too_large: 'link.safetyMs must be under half of link.holderTtlMs.',
    url_not_loopback: 'Only http://127.0.0.1:<port> style URLs are allowed; the machines are linked by an ssh forward.', url_invalid: 'The URL cannot be parsed.',
    identity_unreadable: 'This node\'s identity file cannot be read.', identity_invalid: 'This node\'s identity file is not a valid peer file.',
    private_key_unreadable: 'The private key file cannot be read.', private_key_mode: 'The private key file is readable by other users.',
    private_key_invalid: 'The private key file is not a valid Ed25519 PKCS8 key.', key_identity_mismatch: 'The private key does not belong to the public identity.',
    peer_unreadable: 'The peer file cannot be read.', peer_invalid: 'The peer file is not a valid peer-offer.json.', peer_is_self: 'The peer file is this node\'s own identity.',
    account_mismatch: 'The two nodes belong to different accounts.', peer_not_owner_device: 'Both nodes must be owner devices.',
    peer_scope_missing: 'Both identities need the "attempts" and "replicas" scopes.', option_conflict: 'This option cannot be combined with another one that was also given.',
    listen_not_loopback: 'In this mode the node listens on loopback only.', connection_conflict: 'A connection of that name exists but is not what this mode needs.',
    already_initialized: 'This directory already holds a node identity; an identity is never replaced.', model_invalid: 'The model reference is not usable.',
  }
  return `${text[error.code] ?? `Configuration problem: ${error.code}.`}${where}`
}

/** What an unauthenticated GET of the federation API says about whatever sits behind a loopback port. */
export type Probe = { kind: 'refused' } | { kind: 'timeout' } | { kind: 'status'; status: number; code: string | null }
export async function probeFederation(base: string, timeoutMs = 5_000, transport: typeof fetch = globalThis.fetch): Promise<Probe> {
  try {
    const response = await transport(`${base}/api/federation/handshake`, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
    const body = await response.json().catch(() => null) as { code?: unknown } | null
    return { kind: 'status', status: response.status, code: typeof body?.code === 'string' ? body.code : null }
  } catch (error) { return error instanceof Error && error.name === 'TimeoutError' ? { kind: 'timeout' } : { kind: 'refused' } }
}
/** Interprets a probe: reachable Guanxi federation answers 401 `unauthenticated` to an unsigned request. */
export function explainProbe(id: string, probe: Probe, what: string): Check {
  if (probe.kind === 'refused') return fail(id, 'peer_unreachable', `Nothing is listening at ${what}.`, 'Start the peer node and open the ssh forward, then retry.')
  if (probe.kind === 'timeout') return fail(id, 'peer_timeout', `${what} accepts connections but does not answer.`, 'Check that the forward points at the node\'s listening port.')
  if (probe.status === 401 && probe.code === 'unauthenticated') return ok(id, `Guanxi federation answers at ${what}.`)
  if (probe.status === 403 && probe.code === 'host_denied') return fail(id, 'host_denied', `The node behind ${what} denies the Host header.`,
    'The forwarded port must equal the port that node listens on: forward the same port number on both sides (ssh -L P:127.0.0.1:P).')
  return fail(id, 'peer_not_guanxi', `${what} answered ${probe.status}${probe.code ? ` (${probe.code})` : ''}, which is not a Guanxi federation endpoint.`,
    'Check which process the forward points at.')
}

export interface Handshake { version: { major: number; minor: number }; negotiated: { major: number; minor: number }; readOnly: boolean; capabilities?: string[] }
/** A signed GET of the peer's handshake: proves our key is accepted and lists what the peer offers. */
export async function signedHandshake(options: { base: string; nodeId: string; peerId: string; privateKey: string; timeoutMs: number; transport?: typeof fetch }): Promise<Handshake> {
  const route = '/api/federation/handshake'
  const auth = { nodeId: options.nodeId, audience: options.peerId, version: FEDERATION_VERSION, issuedAt: Date.now(), nonce: randomUUID(), signature: '' }
  auth.signature = signValue(options.privateKey, requestProof('GET', route, null, auth))
  const response = await (options.transport ?? globalThis.fetch)(options.base + route, { headers: { 'X-Guanxi-Node': canonical(auth) }, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs) })
  if (!response.ok) throw new FederationError('peer_refused', response.status)
  return await response.json() as Handshake
}
