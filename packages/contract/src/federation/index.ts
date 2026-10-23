/** Node-to-node protocol. Separate from the browser REST/SSE contract (ADR-0018). */
import { z } from 'zod'
import { sessionEventSchema } from '../events/session-events.ts'
import { layoutClockSchema, layoutDocumentSchema } from '../layouts.ts'

export const FEDERATION_VERSION = { major: 1, minor: 5 } as const
export const ATTEMPT_RESERVATIONS_MINOR = 2
export const ATTEMPT_RESERVATIONS_CAPABILITY = 'attempt-reservations-v1'
export const LAYOUT_CONFIG_MINOR = 1
export const federationVersionSchema = z.object({ major: z.number().int().nonnegative(), minor: z.number().int().nonnegative() }).strict()
export const federationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
const integer = z.number().int().nonnegative().safe()
export const nodeTrustSchema = z.enum(['owner_device', 'shared_device', 'cloud_ephemeral'])
export const nodeScopeSchema = z.enum(['config', 'replicas', 'telemetry', 'commands', 'attempts'])
export const nodeIdentitySchema = z.object({
  id: federationId, accountId: federationId, publicKey: z.string().min(1).max(200),
  trust: nodeTrustSchema, admin: z.boolean(), scopes: z.array(nodeScopeSchema),
}).strict().refine((v) => !v.admin || v.trust === 'owner_device', 'Only interactive owner devices can administer identities')
export type NodeIdentity = z.infer<typeof nodeIdentitySchema>
export const hlcSchema = z.object({ wall: integer, logical: integer }).strict()
export type Hlc = z.infer<typeof hlcSchema>
export const vectorSchema = z.record(federationId, integer)

// Strict, purpose-specific metadata: no vault records, vendor credentials or auth sessions.
export const configValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('setting'), value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]) }).strict(),
  z.object({ kind: z.literal('project'), name: z.string(), archived: z.boolean() }).strict(),
  z.object({ kind: z.literal('glossary'), term: z.string(), replacement: z.string() }).strict(),
  z.object({ kind: z.literal('connection'), ownerAccountId: federationId, label: z.string(),
    auth: z.enum(['api_key', 'local', 'subscription']), enabled: z.boolean() }).strict(),
  z.object({ kind: z.literal('identity'), displayName: z.string(), disabled: z.boolean() }).strict(),
  z.object({ kind: z.literal('grant'), present: z.boolean() }).strict(),
  z.object({ kind: z.literal('membership'), present: z.boolean() }).strict(),
  z.object({ kind: z.literal('layout'), document: layoutDocumentSchema,
    activate: z.boolean(), basedOn: layoutClockSchema.optional() }).strict(),
])
export const configOperationSchema = z.object({
  origin: federationId, counter: integer.refine((v) => v > 0), accountId: federationId,
  key: federationId, clock: hlcSchema, context: vectorSchema, value: configValueSchema,
}).strict()
export type ConfigOperation = z.infer<typeof configOperationSchema>
export const signedConfigOperationSchema = z.object({ operation: configOperationSchema, signature: z.string().max(128) }).strict()
export type SignedConfigOperation = z.infer<typeof signedConfigOperationSchema>
export const telemetrySchema = z.object({
  nodeId: federationId, source: z.string().min(1).max(200), observedAt: integer,
  confidence: z.enum(['observed', 'reported', 'estimated', 'unknown']),
  memoryPressure: z.enum(['normal', 'warning', 'critical', 'unknown']),
  cpuUtilization: z.number().min(0).max(1).nullable(), ownerPresent: z.boolean().nullable(),
}).strict()
export type Telemetry = z.infer<typeof telemetrySchema>
export const streamBindingSchema = z.object({
  streamId: federationId, kind: z.enum(['session', 'run']), sessionId: federationId,
  ownerAccountId: federationId, homeNodeId: federationId, homeEpoch: integer.refine((v) => v > 0),
}).strict()
export type StreamBinding = z.infer<typeof streamBindingSchema>
const standardEvent = sessionEventSchema.refine((v) => v.class === 'standard', 'Reasoning cannot federate')
export const replicaEntrySchema = z.object({
  binding: streamBindingSchema, seq: integer.refine((v) => v > 0), previousHash: z.string().regex(/^[a-f0-9]{64}$/),
  event: standardEvent, hash: z.string().regex(/^[a-f0-9]{64}$/), signature: z.string().max(128),
}).strict()
export type ReplicaEntry = z.infer<typeof replicaEntrySchema>
export const routedCommandSchema = z.object({
  id: federationId, sessionId: federationId, runId: federationId, homeNodeId: federationId,
  stateVersion: integer.refine((v) => v > 0), expiresAt: integer,
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('stop') }).strict(),
    z.object({ kind: z.literal('decide') }).strict(),
    z.object({ kind: z.literal('prompt'), text: z.string().min(1) }).strict(),
  ]),
}).strict()
export type RoutedCommand = z.infer<typeof routedCommandSchema>
export const remoteAttemptOfferSchema = z.object({
  id: federationId, runId: federationId, sessionId: federationId, homeNodeId: federationId, executorNodeId: federationId,
  fence: z.object({ attemptId: federationId, epoch: integer.positive(), token: integer.positive() }).strict(),
  expiresAt: integer, mode: z.literal('strict'),
  resource: z.object({ kind: z.literal('local_inference'), model: z.string().trim().min(1), requestedContext: integer.positive() }).strict(),
  /** F2-d: a relay model call is a child run. Its executor-side pin derives from this already pinned relay run and
   * its home epoch. Only a counted dispatch may use it, and never for a run id that is pinned in its own right. */
  parent: z.object({ runId: federationId, epoch: integer.positive() }).strict().optional(),
}).strict()
export type RemoteAttemptOffer = z.infer<typeof remoteAttemptOfferSchema>
export const remoteAttemptReceiptSchema = z.object({
  offerId: federationId, runId: federationId, homeNodeId: federationId, executorNodeId: federationId,
  fence: remoteAttemptOfferSchema.shape.fence,
  status: z.enum(['queued', 'reserved', 'refused', 'expired', 'canceled', 'restart_lost', 'fenced']),
  dispatchAuthorized: z.literal(false),
  reservation: z.object({ id: federationId, ticketId: federationId, expiresAt: integer,
    source: z.literal('target-governor'), observedAt: integer, confidence: z.literal('observed'),
    scope: z.literal('application_process') }).strict().nullable(),
}).strict()
export type RemoteAttemptReceipt = z.infer<typeof remoteAttemptReceiptSchema>
export const remoteAttemptCancelSchema = z.object({ offerId: federationId, homeNodeId: federationId, executorNodeId: federationId }).strict()
export type RemoteAttemptCancel = z.infer<typeof remoteAttemptCancelSchema>
export const deviceRequestSchema = z.object({ publicKey: z.string().min(1).max(200) }).strict()
export const devicePollSchema = z.object({ device_code: z.string().min(1).max(200) }).strict()
export const deviceAuthorizationSchema = z.object({ device_code: z.string(), user_code: z.string(),
  verification_uri: z.string(), expires_in: integer, interval: integer }).strict()
export const federationAuthSchema = z.object({ nodeId: federationId, audience: federationId, version: federationVersionSchema,
  issuedAt: integer, nonce: federationId, signature: z.string().max(128) }).strict()
export type FederationAuth = z.infer<typeof federationAuthSchema>
export const federationSyncSchema = z.object({ operations: z.array(signedConfigOperationSchema), replicas: z.array(replicaEntrySchema) }).strict()

export const ATTEMPT_DISPATCH_MINOR = 3
export const ATTEMPT_DISPATCH_CAPABILITY = 'local-inference-dispatch-v1'
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
/** F2-d: exact count evidence the dispatch must reproduce. The executor re-renders and re-counts the single user
 * message and refuses on any difference, so the counted string is the evaluated string. */
export const countedRequestSchema = z.object({ contentSha256: sha256, renderedSha256: sha256, tokens: integer.positive(),
  /** Runtime identity the count was made under; the executor refuses a dispatch if it no longer serves exactly this. */
  digest: z.string().min(1), contextTokens: integer.positive() }).strict()
export type CountedRequest = z.infer<typeof countedRequestSchema>
export const localInferenceJobSchema = z.object({
  kind: z.literal('local_inference'), model: z.string().trim().min(1), context: integer.positive(),
  outputTokens: integer.positive(), deadline: integer,
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict()).min(1),
  counted: countedRequestSchema.optional(),
}).strict()
export type LocalInferenceJob = z.infer<typeof localInferenceJobSchema>
export const dispatchGrantSchema = z.object({
  id: federationId, offer: remoteAttemptOfferSchema, reservationId: federationId,
  /** F2-d: the holder TTL the home's cancel wait is sized for. The executor uses the smaller of this and its own. */
  holderTtlMs: integer.positive().optional(),
  job: localInferenceJobSchema, jobHash: z.string().regex(/^[a-f0-9]{64}$/), dispatchAuthorized: z.literal(true),
}).strict()
export type DispatchGrant = z.infer<typeof dispatchGrantSchema>
export const signedDispatchGrantSchema = z.object({ grant: dispatchGrantSchema, signature: z.string().max(128) }).strict()
export type SignedDispatchGrant = z.infer<typeof signedDispatchGrantSchema>
export const dispatchRefSchema = z.object({ id: federationId, homeNodeId: federationId, executorNodeId: federationId }).strict()
export type DispatchRef = z.infer<typeof dispatchRefSchema>
export const dispatchCancelSchema = dispatchRefSchema.extend({ expiresAt: integer }).strict()
export type DispatchCancel = z.infer<typeof dispatchCancelSchema>
export const dispatchRenewalSchema = z.object({ id: federationId, ttlMs: integer.positive() }).strict()
export const dispatchStateSchema = z.object({ id: federationId, status: z.enum(['accepted', 'running', 'completed', 'failed', 'canceled', 'lost']) }).strict()
export type DispatchState = z.infer<typeof dispatchStateSchema>
export const dispatchEventSchema = z.object({
  ref: dispatchRefSchema, seq: integer.positive(), previousHash: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: integer,
  event: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('started') }).strict(),
    z.object({ kind: z.literal('terminal'), outcome: z.enum(['completed','failed','canceled']), content: z.string(),
      inputTokens: integer.nullable(), outputTokens: integer.nullable(), source: z.enum(['ollama:/api/chat', 'llama-server:/completion']),
      /** F2-d: hash of the rendered prompt the executor evaluated, and a fixed refusal reason of a failed counted call. */
      renderedSha256: sha256.nullable().optional(), doneReason: z.enum(['stop', 'length']).optional(), reason: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional() }).strict(),
  ]),
}).strict()
export type DispatchEvent = z.infer<typeof dispatchEventSchema>
export const signedDispatchEventSchema = z.object({ entry: dispatchEventSchema, hash: z.string().regex(/^[a-f0-9]{64}$/), signature: z.string().max(128) }).strict()
export type SignedDispatchEvent = z.infer<typeof signedDispatchEventSchema>

/** F2-d: a relay runtime served by the executor node's llama-server (federation 1.4). */
export const RELAY_RUNTIME_MINOR = 4
/** F2-reap (federation 1.5): relay pins are leased by the executor and must be renewed by the home's heartbeat. An older home
 * never renews, so the executor refuses its pins instead of silently expiring them mid-run. */
export const RELAY_PIN_LEASE_MINOR = 5
export const RELAY_RUNTIME_CAPABILITY = 'remote-relay-runtime-v1'
export const relayRuntimeBindingSchema = z.object({
  homeNodeId: federationId, executorNodeId: federationId, model: z.string().trim().min(1),
  /** Absent only before the relay run exists (admission probe). The executor checks the pin of a present run. */
  run: z.object({ runId: federationId, sessionId: federationId,
    fence: z.object({ attemptId: federationId, epoch: integer.positive(), token: integer.positive() }).strict() }).strict().nullable(),
}).strict()
export type RelayRuntimeBinding = z.infer<typeof relayRuntimeBindingSchema>
export const relayRuntimeObserveSchema = z.object({ binding: relayRuntimeBindingSchema, challenge: federationId }).strict()
export type RelayRuntimeObserveRequest = z.infer<typeof relayRuntimeObserveSchema>
export const relayRuntimeCountSchema = relayRuntimeObserveSchema.extend({ content: z.string() }).strict()
export type RelayRuntimeCountRequest = z.infer<typeof relayRuntimeCountSchema>
export const relayRuntimeEvidenceSchema = z.object({
  kind: z.enum(['observe', 'count']), binding: relayRuntimeBindingSchema, challenge: federationId, executorNodeId: federationId,
  model: z.string().min(1), digest: z.string().min(1), contextTokens: integer.positive(), runtimeVersion: z.string().min(1),
  source: z.string().min(1), observedAt: integer,
  count: z.object({ contentSha256: sha256, renderedSha256: sha256, tokens: integer.positive() }).strict().nullable(),
}).strict().refine(v => (v.kind === 'count') === (v.count !== null), 'count evidence only on count')
export type RelayRuntimeEvidence = z.infer<typeof relayRuntimeEvidenceSchema>
export const signedRelayRuntimeEvidenceSchema = z.object({ entry: relayRuntimeEvidenceSchema, signature: z.string().max(128) }).strict()
export type SignedRelayRuntimeEvidence = z.infer<typeof signedRelayRuntimeEvidenceSchema>
/** The only content an executor counts before a relay run exists (admission probe). Anything else needs a run binding. */
export const RELAY_RUNTIME_PROBE = 'guanxi-relay-admission-probe-v1'

/** F2-d: executor-side pins of relay runs live in their own namespace, so an ordinary pinned run can never serve as a relay parent. */
export const RELAY_PIN_PREFIX = 'relay:'
export const relayRuntimePinSchema = z.object({
  action: z.enum(['pin', 'unpin']), homeNodeId: federationId, executorNodeId: federationId, model: z.string().trim().min(1),
  runId: federationId, sessionId: federationId, epoch: integer.positive(), challenge: federationId,
}).strict()
export type RelayRuntimePinRequest = z.infer<typeof relayRuntimePinSchema>
export const relayRuntimePinAckSchema = z.object({
  action: z.enum(['pin', 'unpin']), homeNodeId: federationId, executorNodeId: federationId,
  runId: federationId, sessionId: federationId, epoch: integer.positive(), challenge: federationId,
}).strict()
export const signedRelayRuntimePinAckSchema = z.object({ entry: relayRuntimePinAckSchema, signature: z.string().max(128) }).strict()
export type SignedRelayRuntimePinAck = z.infer<typeof signedRelayRuntimePinAckSchema>
