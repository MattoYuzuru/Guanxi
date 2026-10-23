import { createHash, randomUUID } from 'node:crypto'
import { ATTEMPT_DISPATCH_CAPABILITY, ATTEMPT_RESERVATIONS_CAPABILITY, RELAY_RUNTIME_CAPABILITY, RELAY_RUNTIME_PROBE, RELAY_STRUCTURED_MINOR } from '@guanxi/contract/federation'
import { FederationChannel } from '../federation/channel.ts'
import { thresholds } from '../relay/budget.ts'
import { REMOTE_RELAY_COUNTER_SOURCE, REMOTE_RELAY_PROPS_SOURCE } from '../relay/remote-runtime.ts'
import { LlamaServerClient } from '../runtime/llama-server/client.ts'
import { LlamaServerHost } from '../runtime/llama-server/process.ts'
import { LLAMA_SERVER_COUNTER_SOURCE } from '../runtime/llama-server/runtime.ts'
import { normalizeOllamaModelReference } from '../runtime/observation-key.ts'
import { explainError, explainProbe, fail, ok, probeFederation, signedHandshake, skip, step, warn, type Check } from './checks.ts'
import type { Ms1LiveSettings } from './config.ts'
import { readCredentials } from './identity.ts'
import { loopbackTransport } from './transport.ts'

/** What the executor's llama-server was observed to be, with where and when that was observed. */
export interface PreflightObserved {
  model: string
  digest: string
  /** The loaded window per slot, in tokens. */
  contextTokens: number
  /** llama-server build, as the server reports it. */
  runtimeVersion: string
  propsSource: string
  counterSource: string
  /** When the observation was made (the home's send time for a remote one). */
  observedAt: string
  probe?: { contentSha256?: string; renderedSha256: string; tokens: number }
}
export interface PreflightReport {
  ok: boolean
  role: Ms1LiveSettings['role']
  checks: Check[]
  observed: PreflightObserved | null
  generatedAt: string
}
export interface PreflightOptions {
  settings: Ms1LiveSettings
  /** Executor only: also run `/completion` for one token on the rendered probe and compare `tokens_evaluated` with the count. */
  completion?: boolean
  transport?: typeof fetch
  clock?: () => number
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

export async function preflight(options: PreflightOptions): Promise<PreflightReport> {
  const { settings } = options, clock = options.clock ?? Date.now
  const checks: Check[] = []
  let observed: PreflightObserved | null = null
  const run = async (check: Promise<Check>): Promise<Check> => { const done = await check; checks.push(done); return done }
  const creds = await run(step('credentials', async () => {
    const { local, peer } = readCredentials(settings)
    return ok('credentials', 'Identity, private key and peer file agree.', { nodeId: local.identity.id, peerId: peer.id, accountId: local.identity.accountId })
  }))
  if (creds.status !== 'ok') {
    checks.push(skip('peer_url', 'Skipped: credentials are not usable.'))
    return finish(settings, checks, observed, clock)
  }
  const { local, peer } = readCredentials(settings)
  const peerBase = settings.peer.url
  const model = normalizeOllamaModelReference(settings.model)!
  const transport = loopbackTransport({ base: peerBase, timeoutMs: settings.link.requestTimeoutMs, ...(options.transport ? { fetch: options.transport } : {}) })

  if (settings.role === 'home') {
    const probe = await run(step('peer_url', async () => explainProbe('peer_url', await probeFederation(peerBase, 5_000, options.transport), peerBase)))
    if (probe.status !== 'ok') return finish(settings, [...checks, skip('handshake', 'Skipped: the executor is not reachable.')], observed, clock)
    const handshake = await run(step('handshake', async () => {
      const shake = await signedHandshake({ base: peerBase, nodeId: local.identity.id, peerId: peer.id, privateKey: local.privateKey, timeoutMs: 15_000, ...(options.transport ? { transport: options.transport } : {}) })
      const missing = [ATTEMPT_RESERVATIONS_CAPABILITY, ATTEMPT_DISPATCH_CAPABILITY, RELAY_RUNTIME_CAPABILITY].filter(name => !(shake.capabilities ?? []).includes(name))
      if (missing.length) return fail('handshake', 'peer_lacks_capability', `The executor does not offer: ${missing.join(', ')}.`,
        'Start the executor in role "executor" (it advertises the relay runtime only with an attached llama-server) on the same Guanxi version.')
      // Federation 1.6 carries a response schema in a counted job; an older executor would refuse every probe and work call (426).
      if (settings.home!.structuredOutput && shake.version.minor < RELAY_STRUCTURED_MINOR) return fail('handshake', 'peer_protocol_old',
        `The executor speaks federation ${shake.version.major}.${shake.version.minor}; decoding under a JSON Schema needs 1.${RELAY_STRUCTURED_MINOR}.`,
        'Run the same Guanxi commit on both nodes, or set home.structuredOutput to false to run without the grammar.')
      return ok('handshake', 'The executor accepts this node\'s signature and offers the relay runtime.', { protocol: `${shake.negotiated.major}.${shake.negotiated.minor}`, capabilities: shake.capabilities })
    }))
    if (handshake.status !== 'ok') return finish(settings, [...checks, skip('observe', 'Skipped: the handshake failed.')], observed, clock)
    const channel = new FederationChannel({ local: local.identity, privateKey: local.privateKey, peer, transport, clock })
    const binding = { homeNodeId: local.identity.id, executorNodeId: peer.id, model, run: null }
    let sent = 0
    const seen = await run(step('observe', async () => {
      sent = clock()
      const evidence = await channel.relayObserve({ binding, challenge: randomUUID() })
      observed = { model: evidence.model, digest: evidence.digest, contextTokens: evidence.contextTokens, runtimeVersion: evidence.runtimeVersion,
        propsSource: REMOTE_RELAY_PROPS_SOURCE, counterSource: REMOTE_RELAY_COUNTER_SOURCE, observedAt: new Date(sent).toISOString() }
      return ok('observe', 'The executor signed an observation of its llama-server.', { model: evidence.model, window: evidence.contextTokens, build: evidence.runtimeVersion, digest: evidence.digest, source: REMOTE_RELAY_PROPS_SOURCE })
    }))
    if (seen.status !== 'ok' || !observed) return finish(settings, [...checks, skip('count', 'Skipped: no observation.')], null, clock)
    const found = observed as PreflightObserved
    const counted = await run(step('count', async () => {
      const evidence = await channel.relayCount({ binding, challenge: randomUUID(), content: RELAY_RUNTIME_PROBE })
      const count = evidence.count!
      if (count.contentSha256 !== sha(RELAY_RUNTIME_PROBE)) return fail('count', 'runtime_counter_mismatch', 'The executor counted a different string than the one sent.')
      if (evidence.digest !== found.digest || evidence.runtimeVersion !== found.runtimeVersion || evidence.contextTokens !== found.contextTokens) {
        return fail('count', 'runtime_identity_changed', 'The model served while counting differs from the one observed a moment earlier.', 'Is another llama-server instance answering on and off? Restart cleanly and rerun.')
      }
      found.probe = { contentSha256: count.contentSha256, renderedSha256: count.renderedSha256, tokens: count.tokens }
      return ok('count', 'The executor rendered and counted the fixed probe exactly (template round trip proved).', { tokens: count.tokens, renderedSha256: count.renderedSha256, source: REMOTE_RELAY_COUNTER_SOURCE })
    }))
    if (counted.status === 'ok') {
      await run(step('reserves', async () => {
        const reserves = settings.home!.reserves
        try { const t = thresholds({ tokens: found.contextTokens, framingTokens: 0, source: found.propsSource, observedAt: sent, confidence: 'high' }, reserves)
          return ok('reserves', `The configured reserves fit the ${found.contextTokens}-token window.`, { hardTokens: t.hard, softTokens: t.soft, requestCeilingTokens: t.H }) } catch (error) {
          return fail('reserves', error instanceof Error ? error.message : 'window_too_small', `The configured home.reserves do not fit the observed ${found.contextTokens}-token window.`,
            'Lower turn/handoff/tool/stepMedian/effective in the configuration: they are tokens of one window.')
        }
      }))
    }
    const cascade = settings.home!.judge?.cascade
    if (counted.status === 'ok' && settings.home!.judge) {
      await run(step('judge', async () => {
        if (!cascade) return ok('judge', 'The judge reads signals from the relay ledger (J0/J1); there is no model layer.')
        const need = cascade.maxInputTokens + cascade.maxOutputTokens
        if (need > found.contextTokens) return fail('judge', 'judge_exceeds_window', `A judge sample needs ${need} tokens (${cascade.maxInputTokens} in, ${cascade.maxOutputTokens} out); the observed window is ${found.contextTokens}.`,
          'Lower home.judge.cascade.maxInputTokens or maxOutputTokens: every relay start would otherwise be refused.')
        const perCycle = 2 * cascade.samples * need
        return ok('judge', `Judge samples fit the ${found.contextTokens}-token window; each cycle pre-debits ${perCycle} tokens from caps.tokens (${cascade.samples} samples at two boundaries).`,
          { sampleTokens: need, perCycleTokens: perCycle, window: found.contextTokens })
      }))
    }
    if (options.completion) checks.push(skip('completion', 'Only an executor runs a generation: use --completion on the executor.'))
    return finish(settings, checks, found, clock)
  }

  // Executor: the local llama-server through the same class that serves the home, then the reverse link.
  const llama = LlamaServerHost.create({ kind: 'attach', baseUrl: settings.executor!.llamaServer.baseUrl, model: settings.model })
  try {
    const runtime = llama.runtime!
    const seen = await run(step('llama_server', async () => {
      const began = clock()
      const o = await runtime.observe(model, AbortSignal.timeout(settings.link.requestTimeoutMs))
      observed = { model: o.model, digest: o.digest, contextTokens: o.contextTokens, runtimeVersion: o.runtimeVersion, propsSource: o.source,
        counterSource: LLAMA_SERVER_COUNTER_SOURCE, observedAt: new Date(o.observedAt).toISOString() }
      return ok('llama_server', 'The attached llama-server serves the configured model (alias, file digest and window observed).',
        { model: o.model, window: o.contextTokens, build: o.runtimeVersion, digest: o.digest, source: o.source, observedMs: clock() - began })
    }, error => {
      const code = (error as { code?: string } | null)?.code
      if (code === 'runtime_meter_unavailable') return { code: 'llama_server_unavailable', summary: `The llama-server at ${settings.executor!.llamaServer.baseUrl} is not reachable or not ready.`,
        fix: 'Start llama-server (with --alias <model> --jinja), wait for /health to answer ok, and check executor.llamaServer.baseUrl.' }
      if (code === 'runtime_identity_unknown') return { code: 'llama_server_identity', summary: 'The llama-server does not serve the configured model, or its model file cannot be read from this machine.',
        fix: 'Its --alias must equal "model" in the configuration, and its model file must be readable here (attach mode hashes it locally).' }
      return explainError(error)
    }))
    if (seen.status === 'ok' && observed) {
      const found = observed as PreflightObserved
      let rendered = ''
      const measured = await run(step('template', async () => {
        const m = await runtime.measure(RELAY_RUNTIME_PROBE, AbortSignal.timeout(60_000))
        rendered = m.rendered
        found.probe = { renderedSha256: sha(m.rendered), tokens: m.tokens }
        return ok('template', 'Chat template round trip proved; the probe was rendered and counted.', { tokens: m.tokens, renderedSha256: found.probe.renderedSha256, source: LLAMA_SERVER_COUNTER_SOURCE })
      }))
      await run(step('slots', async () => {
        const props = await new LlamaServerClient({ baseUrl: settings.executor!.llamaServer.baseUrl }).props(AbortSignal.timeout(15_000))
        return props.slots === 1 ? ok('slots', 'One slot, as the relay expects.', { slots: 1 })
          : warn('slots', 'slots_not_one', `The llama-server reports ${props.slots} slots; the relay was validated with one.`, 'Start llama-server with -np 1 so the observed window is the whole context.')
      }))
      if (options.completion) {
        // One slot: a generation made while the node serves relays would queue behind, or in front of, a live run.
        const answering = await probeFederation(`http://127.0.0.1:${settings.listen.federationPort}`, 2_000, options.transport)
        if (answering.kind === 'status') checks.push(fail('completion', 'completion_while_running', 'This node\'s federation port answers: a generation now would share the single slot with the relay.',
          'Run --completion before starting the node, or after stopping it; never during a run.'))
        else if (measured.status === 'ok') {
          await run(step('completion', async () => {
            const client = new LlamaServerClient({ baseUrl: settings.executor!.llamaServer.baseUrl })
            const done = await client.complete(rendered, 1, AbortSignal.timeout(settings.link.requestTimeoutMs), () => undefined)
            const expected = found.probe!.tokens
            if (done.truncated || done.promptTokens !== expected) {
              return fail('completion', 'truncation_protocol', `/completion evaluated ${done.promptTokens} prompt tokens where /tokenize counted ${expected}${done.truncated ? ' and reported truncation' : ''}.`,
                'Every relay call would be refused. Report the llama.cpp build; try cachePrompt:false in executor.llamaServer.')
            }
            return ok('completion', 'One-token completion: evaluated tokens equal the exact count.', { evaluatedTokens: done.promptTokens, stopType: done.stopType, truncated: done.truncated })
          }))
        } else checks.push(skip('completion', 'Skipped: the template check failed.'))
      } else checks.push(skip('completion', 'Not requested (--completion runs one real one-token generation).'))
    } else {
      checks.push(skip('template', 'Skipped: the llama-server is not usable.'), skip('completion', 'Skipped: the llama-server is not usable.'))
    }
  } finally { await llama.close() }
  // The reverse link carries renewals and results from the executor to the home: unreachable is "not yet", a refusal is a fault.
  const probe = await step('home_link', async () => explainProbe('home_link', await probeFederation(peerBase, 5_000, options.transport), peerBase))
  if (probe.status === 'fail' && ['peer_unreachable', 'peer_timeout'].includes(probe.code ?? '')) {
    checks.push({ ...probe, status: 'warn', summary: `${probe.summary} (the home may not be started yet)` })
  } else {
    checks.push(probe)
    if (probe.status === 'ok') {
      checks.push(await step('home_handshake', async () => {
        const shake = await signedHandshake({ base: peerBase, nodeId: local.identity.id, peerId: peer.id, privateKey: local.privateKey, timeoutMs: 15_000, ...(options.transport ? { transport: options.transport } : {}) })
        return ok('home_handshake', 'The home accepts this node\'s signature over the reverse link.', { protocol: `${shake.negotiated.major}.${shake.negotiated.minor}` })
      }))
    }
  }
  return finish(settings, checks, observed, clock)
}

function finish(settings: Ms1LiveSettings, checks: Check[], observed: PreflightObserved | null, clock: () => number): PreflightReport {
  return { ok: checks.every(check => check.status !== 'fail'), role: settings.role, checks, observed, generatedAt: new Date(clock()).toISOString() }
}
