import type { Health } from '@guanxi/contract'

/**
 * Health facts without their observation times. The 15 s health poll moves `observedAt` on every
 * answer; comparing facts lets the app keep the previous answer's identity, so a poll that changes
 * nothing renders nothing (D-203). No view displays these observation times, which mark when the
 * current facts were first observed.
 */
function facts(health: Health) {
  return {
    ...health,
    application: { ...health.application, observedAt: null },
    ollama: { ...health.ollama, observedAt: null },
    network: { ...health.network, checkedAt: null },
  }
}

export function sameHealthFacts(previous: Health | null, next: Health): boolean {
  return previous !== null && JSON.stringify(facts(previous)) === JSON.stringify(facts(next))
}
