import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { nodeIdentitySchema, type NodeIdentity } from '@guanxi/contract/federation'
import { signValue, validSignature } from '../federation/crypto.ts'
import { Ms1LiveError, type Ms1LiveSettings } from './config.ts'

export const PEER_FORMAT = 'guanxi.ms1-live.peer/v1'
/** The minimum an F2-d pairing needs: `attempts` covers offers, dispatch, renewals, events and the relay runtime messages;
 * `replicas` is what the executor's relay-run pin (a replica-stream binding) requires of both identities. */
export const MS1_SCOPES: NodeIdentity['scopes'] = ['attempts', 'replicas']
export interface PeerFile { format: typeof PEER_FORMAT; identity: NodeIdentity; /** Informational: the port that node listens on, so the other side can check its forward. */ port?: number }

/** Private key bytes live in this object only for the life of a call; nothing here prints or serialises them. */
export interface NodeCredentials { identity: NodeIdentity; privateKey: string }

export function createNodeCredentials(options: { role: 'home' | 'executor'; id?: string; accountId?: string }): NodeCredentials {
  const pair = generateKeyPairSync('ed25519')
  const identity = nodeIdentitySchema.parse({
    id: options.id ?? `ms1-${options.role}-${randomBytes(4).toString('hex')}`,
    accountId: options.accountId ?? 'owner', trust: 'owner_device', admin: false, scopes: MS1_SCOPES,
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
  })
  return { identity, privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
}

export interface InitResult {
  dir: string
  identityFile: string
  /** The public file to copy to the other node. It holds no secret. */
  peerOffer: string
  privateKeyFile: string
  configFile: string
  identity: NodeIdentity
}
const FILES = { identity: 'identity.json', offer: 'peer-offer.json', key: 'node.key', config: 'ms1-live.json' } as const

/** Writes a fresh node identity. Never replaces an existing key or configuration: re-pairing means a new directory. */
export function initNode(dir: string, options: { role: 'home' | 'executor'; id?: string; accountId?: string; port?: number; config: (paths: { identityFile: string; privateKeyFile: string }) => unknown }): InitResult {
  const root = resolve(dir)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const privateKeyFile = join(root, FILES.key), identityFile = join(root, FILES.identity), peerOffer = join(root, FILES.offer), configFile = join(root, FILES.config)
  const credentials = createNodeCredentials(options)
  const file: PeerFile = { format: PEER_FORMAT, identity: credentials.identity, ...(options.port ? { port: options.port } : {}) }
  try {
    // `wx` fails if the key exists: an existing identity is pinned in the peer's database and in this node's.
    writeFileSync(privateKeyFile, credentials.privateKey, { mode: 0o600, flag: 'wx' })
    chmodSync(privateKeyFile, 0o600)
    writeFileSync(identityFile, JSON.stringify(file, null, 2) + '\n', { mode: 0o644, flag: 'wx' })
    writeFileSync(peerOffer, JSON.stringify(file, null, 2) + '\n', { mode: 0o644, flag: 'wx' })
    writeFileSync(configFile, JSON.stringify(options.config({ identityFile, privateKeyFile }), null, 2) + '\n', { mode: 0o644, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Ms1LiveError('already_initialized')
    throw new Ms1LiveError('init_failed')
  }
  return { dir: root, identityFile, peerOffer, privateKeyFile, configFile, identity: credentials.identity }
}

function readJson(path: string, unreadable: string, invalid: string): unknown {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { throw new Ms1LiveError(unreadable) }
  try { return JSON.parse(text) } catch { throw new Ms1LiveError(invalid) }
}
export function readPeerFileFull(path: string, unreadable = 'peer_unreadable', invalid = 'peer_invalid'): { identity: NodeIdentity; port: number | null } {
  const raw = readJson(path, unreadable, invalid) as Partial<PeerFile> | null
  if (!raw || typeof raw !== 'object' || raw.format !== PEER_FORMAT) throw new Ms1LiveError(invalid)
  const parsed = nodeIdentitySchema.safeParse(raw.identity)
  if (!parsed.success) throw new Ms1LiveError(invalid)
  const port = raw.port
  if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) throw new Ms1LiveError(invalid)
  return { identity: parsed.data, port: port ?? null }
}
export function readPeerFile(path: string, unreadable = 'peer_unreadable', invalid = 'peer_invalid'): NodeIdentity {
  return readPeerFileFull(path, unreadable, invalid).identity
}

/** The private key is read once, must be a private regular file and must belong to the stated public identity. */
export function readPrivateKey(path: string, identity: NodeIdentity): string {
  let stat
  try { stat = statSync(path) } catch { throw new Ms1LiveError('private_key_unreadable') }
  if (!stat.isFile()) throw new Ms1LiveError('private_key_unreadable')
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Ms1LiveError('private_key_mode')
  let pem: string
  try { pem = readFileSync(path, 'utf8') } catch { throw new Ms1LiveError('private_key_unreadable') }
  let proof: string
  const probe = { domain: 'guanxi.ms1-live.key-check.v1' }
  try { proof = signValue(pem, probe) } catch { throw new Ms1LiveError('private_key_invalid') }
  if (!validSignature(identity.publicKey, probe, proof)) throw new Ms1LiveError('key_identity_mismatch')
  return pem
}

export interface PairedCredentials { local: NodeCredentials; peer: NodeIdentity; peerPort: number | null }
/** Everything a node needs to take part: its own pair and the peer's pinned public identity, checked against each other. */
export function readCredentials(settings: Pick<Ms1LiveSettings, 'node' | 'peer'>): PairedCredentials {
  const identity = readPeerFile(settings.node.identityFile, 'identity_unreadable', 'identity_invalid')
  const privateKey = readPrivateKey(settings.node.privateKeyFile, identity)
  const { identity: peer, port: peerPort } = readPeerFileFull(settings.peer.identityFile)
  if (peer.id === identity.id || peer.publicKey === identity.publicKey) throw new Ms1LiveError('peer_is_self')
  if (peer.accountId !== identity.accountId) throw new Ms1LiveError('account_mismatch')
  if (peer.trust !== 'owner_device' || identity.trust !== 'owner_device') throw new Ms1LiveError('peer_not_owner_device')
  if (![peer, identity].every(node => MS1_SCOPES.every(scope => node.scopes.includes(scope)))) throw new Ms1LiveError('peer_scope_missing')
  return { local: { identity, privateKey }, peer, peerPort }
}
