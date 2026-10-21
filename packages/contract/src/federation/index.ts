/** Node-to-node protocol. Separate from the browser REST/SSE contract (ADR-0018). */
import { z } from 'zod'
import { sessionEventSchema } from '../events/session-events.ts'

export const FEDERATION_VERSION = { major: 1, minor: 0 } as const
export const federationVersionSchema = z.object({ major: z.number().int().nonnegative(), minor: z.number().int().nonnegative() }).strict()
export const federationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
const integer = z.number().int().nonnegative().safe()
export const nodeTrustSchema = z.enum(['owner_device', 'shared_device', 'cloud_ephemeral'])
export const nodeScopeSchema = z.enum(['config', 'replicas', 'telemetry', 'commands'])
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
export const deviceRequestSchema = z.object({ publicKey: z.string().min(1).max(200) }).strict()
export const devicePollSchema = z.object({ device_code: z.string().min(1).max(200) }).strict()
export const deviceAuthorizationSchema = z.object({ device_code: z.string(), user_code: z.string(),
  verification_uri: z.string(), expires_in: integer, interval: integer }).strict()
export const federationAuthSchema = z.object({ nodeId: federationId, audience: federationId, version: federationVersionSchema,
  issuedAt: integer, nonce: federationId, signature: z.string().max(128) }).strict()
export type FederationAuth = z.infer<typeof federationAuthSchema>
export const federationSyncSchema = z.object({ operations: z.array(signedConfigOperationSchema), replicas: z.array(replicaEntrySchema) }).strict()
