import { createHash } from 'node:crypto'
import type { AgentInstallation } from './types.ts'

/** One versioned canonical policy shape. Learned observations are deliberately excluded. */
export const ADMISSION_POLICY_SCHEMA = 'k5-account-admission/v1'

export function admissionPolicyDigest(install: Pick<AgentInstallation, 'nodeId' | 'ownerAccountId' | 'adapter' | 'billingAccount' | 'concurrency'>) {
  return createHash('sha256').update(JSON.stringify({
    schema: ADMISSION_POLICY_SCHEMA,
    nodeId: install.nodeId,
    ownerAccountId: install.ownerAccountId,
    adapter: install.adapter,
    billingAccount: install.billingAccount,
    operatorCeiling: install.concurrency ?? 1,
  })).digest('hex')
}

/** A learned rejection can tighten the operator ceiling but never raise it. */
export function effectiveRunCeiling(operatorCeiling: number, rejectedAt: number | null) {
  const learnedCeiling = rejectedAt === null ? Infinity : Math.max(1, rejectedAt - 1)
  return Math.min(operatorCeiling, learnedCeiling)
}
