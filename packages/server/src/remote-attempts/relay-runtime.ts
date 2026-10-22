import { createHash } from 'node:crypto'
import { relayRuntimeEvidenceSchema, signedRelayRuntimeEvidenceSchema, type RelayRuntimeEvidence, type SignedRelayRuntimeEvidence } from '@guanxi/contract/federation'
import type { LocalChatTransport } from '../connections/service.ts'
import type { RelayRuntimeObservation } from '../relay/runtime.ts'
import { signValue } from '../federation/crypto.ts'

/** What an executor node exposes of its operational llama-server (R2-op `LlamaServerRuntime` satisfies it). It is
 * reached only through signed, fenced F2 messages; no method here is reachable by HTTP or model input. */
export interface ExecutorRelayRuntime {
  /** Normalized model reference this server instance serves. */
  readonly model: string
  observe(reference: string, signal: AbortSignal): Promise<RelayRuntimeObservation>
  /** Identity, template proof, rendering and exact token count of one user message. */
  measure(content: string, signal: AbortSignal): Promise<{ observation: RelayRuntimeObservation; rendered: string; tokens: number }>
  /** A one-call transport that refuses unless the evaluated rendering is the counted one. */
  expectedTransport(expected: { renderedSha256: string; tokens: number; digest: string; contextTokens: number }): LocalChatTransport & { evidence(): { renderedSha256?: string; failure?: string } | undefined }
}
export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
/** Signs the facts the executor observed, bound to the request that asked for them. */
export function signRuntimeEvidence(privateKey: string, entry: RelayRuntimeEvidence): SignedRelayRuntimeEvidence {
  const checked = relayRuntimeEvidenceSchema.parse(entry)
  return signedRelayRuntimeEvidenceSchema.parse({ entry: checked, signature: signValue(privateKey, checked) })
}
