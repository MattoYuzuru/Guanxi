import {
  FEATURE_FLAG_DECLARATION_VERSION,
  FEATURE_FLAG_REGISTRY_VERSION,
  featureFlagKeySchema,
  getFeatureFlagsResponse,
  type FeatureFlagKey,
  type FeatureFlagProjection,
  type GetFeatureFlagsResponse,
} from '@alamo/contract'

export const ESTIMATED_PARALLEL_ADMISSION_ENV =
  'ALAMO_FEATURE_ESTIMATED_PARALLEL_ADMISSION_POLICY'

export interface FeatureFlagDeclaration {
  readonly key: FeatureFlagKey
  readonly declarationVersion: typeof FEATURE_FLAG_DECLARATION_VERSION
  readonly safeDefault: false
  readonly operatorEnvironmentVariable: string
  readonly clientReadable: boolean
}

/** The only product registry. Consumers import keys/types, never raw strings or env names. */
export const FEATURE_FLAG_DECLARATIONS: readonly FeatureFlagDeclaration[] = Object.freeze([
  Object.freeze({
    key: 'estimated_parallel_admission_policy',
    declarationVersion: FEATURE_FLAG_DECLARATION_VERSION,
    safeDefault: false,
    operatorEnvironmentVariable: ESTIMATED_PARALLEL_ADMISSION_ENV,
    clientReadable: true,
  }),
])

export type FeatureFlagEnvironment =
  | {
      readonly state: 'available'
      readonly values: Readonly<Record<string, string | undefined>>
    }
  | { readonly state: 'unavailable' }

export interface FeatureFlagRegistryOptions {
  readonly environment: FeatureFlagEnvironment
  readonly observedAt?: string
}

function validateDeclarations(declarations: readonly FeatureFlagDeclaration[]): void {
  const expectedKeys = featureFlagKeySchema.options
  const keys = declarations.map((declaration) => declaration.key)
  if (new Set(keys).size !== keys.length) {
    throw new Error('Duplicate feature flag declaration')
  }
  if (
    keys.length !== expectedKeys.length
    || expectedKeys.some((key) => !keys.includes(key))
  ) {
    throw new Error('Feature flag registry is incomplete')
  }
  for (const declaration of declarations) {
    if (
      !featureFlagKeySchema.safeParse(declaration.key).success
      || declaration.declarationVersion !== FEATURE_FLAG_DECLARATION_VERSION
      || declaration.safeDefault !== false
      || !/^[A-Z][A-Z0-9_]*$/u.test(declaration.operatorEnvironmentVariable)
    ) {
      throw new Error('Invalid feature flag declaration')
    }
  }
}

function resolveFlag(
  declaration: FeatureFlagDeclaration,
  environment: FeatureFlagEnvironment,
  observedAt: string,
): FeatureFlagProjection {
  const basis = {
    registryVersion: FEATURE_FLAG_REGISTRY_VERSION,
    declarationVersion: declaration.declarationVersion,
  } as const
  Object.freeze(basis)

  const unavailable = (): FeatureFlagProjection => Object.freeze({
    key: declaration.key,
    effectiveValue: false,
    state: 'unavailable',
    source: 'safe_default',
    rejectedSource: 'operator_environment',
    reason: 'operator_source_unavailable',
    observedAt,
    basis,
  })

  if (
    environment.state !== 'available'
    || typeof environment.values !== 'object'
    || environment.values === null
  ) {
    return unavailable()
  }

  let raw: string | undefined
  try {
    raw = environment.values[declaration.operatorEnvironmentVariable]
  } catch {
    return unavailable()
  }
  if (raw === undefined) {
    return Object.freeze({
      key: declaration.key,
      effectiveValue: declaration.safeDefault,
      state: 'resolved',
      source: 'safe_default',
      reason: null,
      observedAt,
      basis,
    })
  }
  if (raw === 'enabled' || raw === 'disabled') {
    return Object.freeze({
      key: declaration.key,
      effectiveValue: raw === 'enabled',
      state: 'resolved',
      source: 'operator_environment',
      reason: null,
      observedAt,
      basis,
    })
  }
  return Object.freeze({
    key: declaration.key,
    effectiveValue: false,
    state: 'invalid',
    source: 'safe_default',
    rejectedSource: 'operator_environment',
    reason: 'invalid_operator_value',
    observedAt,
    basis,
  })
}

export class FeatureFlagRegistry {
  private readonly effective: ReadonlyMap<FeatureFlagKey, FeatureFlagProjection>
  private readonly publicResponse: GetFeatureFlagsResponse

  constructor(options: FeatureFlagRegistryOptions) {
    const declarations = FEATURE_FLAG_DECLARATIONS
    validateDeclarations(declarations)
    const observedAt = options.observedAt ?? new Date().toISOString()
    const resolved = declarations.map((declaration) => ({
      declaration,
      value: resolveFlag(declaration, options.environment, observedAt),
    }))

    this.effective = new Map(resolved.map(({ declaration, value }) => [declaration.key, value]))
    this.publicResponse = getFeatureFlagsResponse.parse({
      version: FEATURE_FLAG_REGISTRY_VERSION,
      flags: resolved
        .filter(({ declaration }) => declaration.clientReadable)
        .map(({ value }) => value),
    })
    for (const flag of this.publicResponse.flags) {
      Object.freeze(flag.basis)
      Object.freeze(flag)
    }
    Object.freeze(this.publicResponse.flags)
    Object.freeze(this.publicResponse)
  }

  /** Unknown runtime input fails closed even if an untyped caller bypasses TypeScript. */
  isEnabled(key: FeatureFlagKey): boolean {
    return this.effective.get(key)?.effectiveValue === true
  }

  /** Typed consumer projection preserves invalid/unavailable provenance. */
  projection(key: FeatureFlagKey): FeatureFlagProjection {
    const value = this.effective.get(key)
    if (!value) throw new Error('Unknown feature flag key')
    return value
  }

  /** Already redacted, immutable, and safe for Web/CLI serialization. */
  publicProjection(): GetFeatureFlagsResponse {
    return this.publicResponse
  }
}
