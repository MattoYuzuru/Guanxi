import { describe, it } from 'node:test'
import { installedModelDescriptorSchema, legacyInstalledModelDescriptor } from '@alamo/contract'

describe('t2', () => {
  it('legacy recorded descriptor without runtime/overrides', () => {
    const { runtime, overrides, ...withoutNew } = legacyInstalledModelDescriptor as any
    const parsed = installedModelDescriptorSchema.safeParse(withoutNew)
    console.log('T2a parses =', parsed.success)
    if (parsed.success) console.log('T2a runtime =', JSON.stringify(parsed.data.runtime), 'overrides =', JSON.stringify(parsed.data.overrides))
    else console.log(parsed.error.message.slice(0, 300))
  })
  it('a real serialized descriptor with runtime present is round-trippable', () => {
    const full = { ...legacyInstalledModelDescriptor,
      runtime: { state: 'sourced', runtime: 'ollama', version: '0.12.6', source: 'ollama_api_version', observedAt: '2026-08-07T00:00:00.000Z', confidence: 'observed' } }
    console.log('T2b parses =', installedModelDescriptorSchema.safeParse(full).success)
  })
  it('untrimmed runtime version is accepted by the fingerprint schema', () => {
    const full = { ...legacyInstalledModelDescriptor,
      runtime: { state: 'sourced', runtime: 'ollama', version: '  0.12.6\n', source: 'ollama_api_version', observedAt: '2026-08-07T00:00:00.000Z', confidence: 'observed' } }
    console.log('T2c untrimmed accepted =', installedModelDescriptorSchema.safeParse(full).success)
  })
})
