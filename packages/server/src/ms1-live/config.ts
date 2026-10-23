import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { relayReservesSchema } from '@guanxi/contract'

/** The one environment variable that turns the MS1 live mode on for `bin.ts` and `ms1-live start`. */
export const MS1_LIVE_CONFIG_ENV = 'GUANXI_MS1_LIVE_CONFIG'
export const MS1_LIVE_CONFIG_VERSION = 1
/** Name of the executor-side local-runtime connection and of the home's connection to the executor. */
export const MS1_EXECUTOR_CONNECTION = 'ms1-executor'
export const MS1_LEAD_CONNECTION = 'ms1-lead'

/** A configuration or credential problem. The code is the contract; the field names *where*, never what the value was. */
export class Ms1LiveError extends Error {
  readonly code: string
  readonly field: string | null
  constructor(code: string, field: string | null = null) {
    super(field ? `${code} (${field})` : code)
    this.name = 'Ms1LiveError'; this.code = code; this.field = field
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
/** Admits only `http://<loopback>:<port>`: Guanxi never dials, nor binds, anything else (AGENTS.md invariant). The
 * operator's SSH forwards are what carries bytes between machines. */
export function loopbackBase(value: string, field: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Ms1LiveError('url_invalid', field) }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username || url.password || url.search || url.hash ||
    !['', '/'].includes(url.pathname) || !url.port) throw new Ms1LiveError('url_not_loopback', field)
  return url.origin
}

const positive = z.number().int().positive().safe()
const path = z.string().min(1)
const loopbackUrl = (field: string) => z.string().min(1).superRefine((value, ctx) => {
  try { loopbackBase(value, field) } catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'url_not_loopback' }) }
})
const caps = z.object({ cycles: positive, tokens: positive, moneyMicros: z.number().int().nonnegative().safe(), wallMs: positive }).strict()

/** Timing of the node-to-node dispatch protocol. Every value is a named policy, not a guess made by the code. */
const linkSchema = z.object({
  /** One signed request over the forwarded link. The first observation on an executor hashes the GGUF: allow minutes. */
  requestTimeoutMs: positive.default(15 * 60_000),
  /** Dispatch holder TTL: how long an executor may keep computing without a renewal from the home. */
  holderTtlMs: positive.default(30_000),
  /** Subtracted from the holder TTL on the executor. Must be under half of the TTL. */
  safetyMs: positive.default(2_000),
  /** Oldest model-inventory attestation the executor accepts. */
  maxModelAgeMs: positive.default(60_000),
  /** Longest an executor may keep one offer's governor reservation (its queue wait included). */
  maxReservationMs: positive.default(120_000),
}).strict().default({})

const homeSchema = z.object({
  /** The host's explicit assertion that this node stays awake while remote calls and a sleeping lead are in flight
   * (ADR-0019 decision 5): R1 refuses to start a remote attempt without it. Nothing here arranges power; on a Mac, run the
   * node under `caffeinate -dimsu` and on power. */
  alwaysOn: z.literal(true),
  /** ADR-0020 reserves for the served model. These are owner policy; the window itself is observed on the executor. */
  reserves: relayReservesSchema,
  /** Oldest loaded-model / counter observation a relay start accepts. */
  maximumAgeMs: positive.default(60_000),
  /** Guanxi-owned allowed root for checkouts. Default `<data dir>/relay-checkouts`. */
  checkoutRoot: path.optional(),
  /** Wall deadline of one model call. Default: the relay runtime's own (30 minutes). */
  callDeadlineMs: positive.optional(),
  reservationMs: positive.optional(),
  pollMs: positive.optional(),
  lead: z.object({
    adapter: z.literal('claude-code'),
    /** Absolute path of the operator-installed ACP bridge (`@agentclientprotocol/claude-agent-acp`). */
    bridge: path,
    /** Exact version the bridge reports in ACP `agentInfo`. */
    bridgeVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/),
    /** The owner's unmodified Claude Code CLI. */
    claudeExecutable: path,
    /** Opaque grouping key for the vendor account (K5). */
    billingAccount: z.string().min(1).default('claude-code-account'),
    /** ACP model the lead role is bound to. */
    model: z.string().min(1).default('default'),
    runDeadlineMs: positive.optional(),
    domains: z.array(z.string().min(1)).default([]),
    pollMs: positive.optional(),
    /** The owner's ceilings; the lead can never exceed them (LW). All four caps are mandatory. */
    limits: z.object({ maxCaps: caps, maxDeadlineMs: positive, allowDetach: z.boolean().default(false) }).strict(),
  }).strict().optional(),
}).strict()

const executorSchema = z.object({
  llamaServer: z.object({
    /** Attach mode: a llama-server the owner already runs (`--alias`, `--jinja`), reached on this node's loopback. */
    baseUrl: loopbackUrl('executor.llamaServer.baseUrl'),
    cachePrompt: z.boolean().optional(),
  }).strict(),
}).strict()

export const ms1LiveConfigSchema = z.object({
  version: z.literal(MS1_LIVE_CONFIG_VERSION),
  role: z.enum(['home', 'executor']),
  node: z.object({
    /** Public identity (`identity.json` from `init`). */
    identityFile: path,
    /** PKCS8 PEM written by `init`, mode 0600. Only the *path* ever appears in configuration. */
    privateKeyFile: path,
  }).strict(),
  peer: z.object({
    /** The other node's public identity file, copied by the operator. */
    identityFile: path,
    /** Where the other node's federation API is reachable from here: this side of the SSH forward. */
    url: loopbackUrl('peer.url'),
  }).strict(),
  /** This node's own federation/API port on its loopback. `GUANXI_API_PORT` overrides it. The peer's `peer.url` port must be this one. */
  listen: z.object({ port: z.number().int().min(1).max(65535) }).strict().optional(),
  /** The one model reference the executor's llama-server serves (its `--alias`). */
  model: z.string().min(1),
  link: linkSchema,
  home: homeSchema.optional(),
  executor: executorSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.role === 'home' && !value.home) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['home'], message: 'section_required' })
  if (value.role === 'executor' && !value.executor) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['executor'], message: 'section_required' })
  if (value.role === 'home' && value.executor) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['executor'], message: 'section_not_for_role' })
  if (value.role === 'executor' && value.home) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['home'], message: 'section_not_for_role' })
  if (value.link.safetyMs >= value.link.holderTtlMs / 2) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['link', 'safetyMs'], message: 'safety_too_large' })
})
export type Ms1LiveFile = z.infer<typeof ms1LiveConfigSchema>
export type Ms1LiveLead = NonNullable<NonNullable<Ms1LiveFile['home']>['lead']>

/** A parsed configuration with every path absolute. Holds paths only: no key, no token. */
export interface Ms1LiveSettings extends Omit<Ms1LiveFile, 'node' | 'peer' | 'home' | 'executor'> {
  /** Absolute path of the configuration file. */
  readonly file: string
  readonly node: { identityFile: string; privateKeyFile: string }
  readonly peer: { identityFile: string; url: string }
  readonly home?: Omit<NonNullable<Ms1LiveFile['home']>, 'checkoutRoot'> & { checkoutRoot?: string }
  readonly executor?: { llamaServer: { baseUrl: string; cachePrompt?: boolean } }
}

function absolute(base: string, value: string): string { return isAbsolute(value) ? value : resolve(base, value) }

/** Strict parse of an already-read JSON value. */
export function parseMs1LiveConfig(raw: unknown, file: string): Ms1LiveSettings {
  const parsed = ms1LiveConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    // Names the field and the rule, never the offending value (it could be a pasted secret).
    const code = issue.code === 'unrecognized_keys' ? 'config_unknown_key' : issue.code === 'custom' ? `config_${issue.message}` : 'config_invalid'
    throw new Ms1LiveError(code, issue.path.join('.') || null)
  }
  const value = parsed.data, base = dirname(file)
  return Object.freeze({
    ...value, file,
    node: { identityFile: absolute(base, value.node.identityFile), privateKeyFile: absolute(base, value.node.privateKeyFile) },
    peer: { identityFile: absolute(base, value.peer.identityFile), url: loopbackBase(value.peer.url, 'peer.url') },
    ...(value.home ? { home: { ...value.home, ...(value.home.checkoutRoot ? { checkoutRoot: absolute(base, value.home.checkoutRoot) } : {}) } } : {}),
    ...(value.executor ? { executor: { llamaServer: { ...value.executor.llamaServer, baseUrl: loopbackBase(value.executor.llamaServer.baseUrl, 'executor.llamaServer.baseUrl') } } } : {}),
  } as Ms1LiveSettings)
}

/** Reads and validates the file at `path`. Only an absolute path or one relative to the working directory is accepted. */
export function loadMs1LiveConfig(path: string): Ms1LiveSettings {
  const file = resolve(path)
  let text: string
  try {
    if (!statSync(file).isFile()) throw new Error('not a file')
    text = readFileSync(file, 'utf8')
  } catch { throw new Ms1LiveError('config_unreadable') }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Ms1LiveError('config_invalid_json') }
  return parseMs1LiveConfig(raw, file)
}

/** `undefined` when the variable is unset or empty: the default boot is then untouched. */
export function ms1LiveFromEnv(env: Readonly<Record<string, string | undefined>>): Ms1LiveSettings | undefined {
  const value = env[MS1_LIVE_CONFIG_ENV]
  return value === undefined || value === '' ? undefined : loadMs1LiveConfig(value)
}
