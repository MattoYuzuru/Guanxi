import snapshot from './metadata/models-dev.json' with { type: 'json' }
import type { ConnectionFact } from '@guanxi/contract'

/** Independent evidence stays separate from pi-ai; discrepancies are not overwritten. */
export function modelsDevFacts(provider: string, model: string): Record<string, ConnectionFact> {
  const row = snapshot.models.find(item => item.provider === provider && item.id === model)
  if (!row) return {}
  const fact = (value: number | string | boolean): ConnectionFact => ({
    value, source: row.source, observedAt: snapshot.observedAt, confidence: 'medium',
  })
  return {
    'models.dev.context': fact(row.data.limit.context),
    'models.dev.output': fact(row.data.limit.output),
    ...(row.data.status ? { 'models.dev.status': fact(row.data.status) } : {}),
    'models.dev.tools': fact(row.data.capabilities.tools.supported),
    'models.dev.reasoning': fact(row.data.capabilities.reasoning.supported),
  }
}
