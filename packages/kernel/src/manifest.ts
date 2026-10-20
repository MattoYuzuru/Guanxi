/**
 * The plugin manifest: the `guanxi` field of a plugin package's `package.json`
 * (ADR-0022 §2). K1 reads and validates it; K1 enforces `engines.guanxi`,
 * `provides`, `requires`, `trust` and slot contributions. The other
 * contribution kinds are accepted as declared lists and enforced by the stages
 * that own them.
 */

/** Version of the kernel plugin API that `engines.guanxi` ranges are checked against. */
export const KERNEL_API_VERSION = '0.1.0'

export type TrustTier = 'T0' | 'T1' | 'T2'

/** ADR-0022 contribution kinds that K1 validates as name lists but does not enforce yet. */
export type DeclaredContributionKind =
  | 'settingsPages'
  | 'locales'
  | 'themes'
  | 'commands'
  | 'tools'
  | 'messageRenderers'
  | 'composerActions'

export interface ManifestContributions
  extends Partial<Readonly<Record<DeclaredContributionKind, readonly string[]>>> {
  /** Slots this plugin declares and therefore owns. */
  readonly slotDeclarations: readonly string[]
  /** Slots this plugin contributes entries to. */
  readonly slots: readonly string[]
}

export interface GuanxiManifest {
  readonly id: string
  readonly engines: { readonly guanxi: string }
  readonly provides: readonly string[]
  readonly requires: readonly string[]
  readonly uses: readonly string[]
  readonly contributes: ManifestContributions
  readonly trust: TrustTier
}

export class ManifestError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'ManifestError'
    this.path = path
  }
}

const ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/
const NAME_PATTERN = /^[a-z][a-zA-Z0-9-]*(\.[a-z0-9][a-zA-Z0-9-]*)*$/
const OTHER_CONTRIBUTIONS = new Set<string>([
  'settingsPages',
  'locales',
  'themes',
  'commands',
  'tools',
  'messageRenderers',
  'composerActions',
])
const TOP_LEVEL = new Set(['id', 'engines', 'provides', 'requires', 'uses', 'contributes', 'trust', 'capabilities'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nameList(value: unknown, path: string, pattern = NAME_PATTERN): readonly string[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value)) throw new ManifestError(path, 'must be an array of names')
  const seen = new Set<string>()
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || !pattern.test(item)) {
      throw new ManifestError(`${path}[${index}]`, 'must be a dotted lower-case name')
    }
    if (seen.has(item)) throw new ManifestError(`${path}[${index}]`, `duplicate "${item}"`)
    seen.add(item)
  }
  return Object.freeze([...value] as string[])
}

/** Validate a manifest object (the value of the `guanxi` field). */
export function parseManifest(input: unknown, path = 'guanxi'): GuanxiManifest {
  if (!isRecord(input)) throw new ManifestError(path, 'must be an object')
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL.has(key)) throw new ManifestError(`${path}.${key}`, 'is not a manifest field')
  }
  const { id, engines, trust } = input
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new ManifestError(`${path}.id`, 'must be a dotted lower-case id such as "guanxi.resource-governor"')
  }
  if (!isRecord(engines) || typeof engines['guanxi'] !== 'string') {
    throw new ManifestError(`${path}.engines.guanxi`, 'is required')
  }
  parseRange(engines['guanxi'], `${path}.engines.guanxi`)
  if (trust !== 'T0' && trust !== 'T1' && trust !== 'T2') {
    throw new ManifestError(`${path}.trust`, 'must be "T0", "T1" or "T2"')
  }
  if (trust !== 'T2' && input['capabilities'] !== undefined) {
    throw new ManifestError(`${path}.capabilities`, 'is only valid for T2 plugins')
  }

  const provides = nameList(input['provides'], `${path}.provides`)
  const requires = nameList(input['requires'], `${path}.requires`)
  const uses = nameList(input['uses'], `${path}.uses`)
  for (const name of uses) {
    if (provides.includes(name)) {
      throw new ManifestError(`${path}.uses`, `"${name}" is also provided by this plugin`)
    }
  }
  for (const name of requires) {
    if (provides.includes(name)) {
      throw new ManifestError(`${path}.requires`, `"${name}" is also provided by this plugin`)
    }
    if (uses.includes(name)) {
      throw new ManifestError(`${path}.uses`, `"${name}" is already required`)
    }
  }

  const contributes = input['contributes'] ?? {}
  if (!isRecord(contributes)) throw new ManifestError(`${path}.contributes`, 'must be an object')
  const declared: Partial<Record<DeclaredContributionKind, readonly string[]>> = {}
  for (const [key, value] of Object.entries(contributes)) {
    if (key === 'slots' || key === 'slotDeclarations') continue
    if (!OTHER_CONTRIBUTIONS.has(key)) {
      throw new ManifestError(`${path}.contributes.${key}`, 'is not a contribution kind')
    }
    declared[key as DeclaredContributionKind] = nameList(value, `${path}.contributes.${key}`)
  }

  return Object.freeze({
    id,
    engines: Object.freeze({ guanxi: engines['guanxi'] }),
    provides,
    requires,
    uses,
    contributes: Object.freeze({
      ...declared,
      slotDeclarations: nameList(contributes['slotDeclarations'], `${path}.contributes.slotDeclarations`),
      slots: nameList(contributes['slots'], `${path}.contributes.slots`),
    }),
    trust,
  })
}

/** Read the manifest from a parsed `package.json`. */
export function readPackageManifest(packageJson: unknown): GuanxiManifest {
  if (!isRecord(packageJson)) throw new ManifestError('package.json', 'must be an object')
  if (packageJson['guanxi'] === undefined) {
    throw new ManifestError('package.json', 'has no "guanxi" manifest field')
  }
  return parseManifest(packageJson['guanxi'], 'package.json#guanxi')
}

/* ───────────────────────────── engines.guanxi ───────────────────────────── */

type Version = readonly [number, number, number]

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function parseVersion(text: string, path: string): Version {
  const match = VERSION.exec(text)
  if (!match) throw new ManifestError(path, `"${text}" is not a release version (x.y.z)`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compare(left: Version, right: Version): number {
  for (let index = 0; index < 3; index += 1) {
    const delta = left[index]! - right[index]!
    if (delta !== 0) return delta
  }
  return 0
}

interface Comparator {
  readonly operator: '>=' | '<' | '='
  readonly version: Version
}

/**
 * Supported ranges: `x.y.z`, `^x.y.z`, `~x.y.z`, `>=x.y.z`, and space-separated
 * conjunctions of `>=`/`<` bounds. Pre-release tags and `||` are rejected rather
 * than half-supported.
 */
function parseRange(range: string, path: string): Comparator[] {
  const parts = range.trim().split(/\s+/)
  if (parts.length === 0 || parts[0] === '') throw new ManifestError(path, 'is empty')
  const comparators: Comparator[] = []
  for (const part of parts) {
    if (part.startsWith('^')) {
      const version = parseVersion(part.slice(1), path)
      const [major, minor, patch] = version
      const upper: Version =
        major > 0 ? [major + 1, 0, 0] : minor > 0 ? [0, minor + 1, 0] : [0, 0, patch + 1]
      comparators.push({ operator: '>=', version }, { operator: '<', version: upper })
    } else if (part.startsWith('~')) {
      const version = parseVersion(part.slice(1), path)
      comparators.push(
        { operator: '>=', version },
        { operator: '<', version: [version[0], version[1] + 1, 0] },
      )
    } else if (part.startsWith('>=')) {
      comparators.push({ operator: '>=', version: parseVersion(part.slice(2), path) })
    } else if (part.startsWith('<')) {
      comparators.push({ operator: '<', version: parseVersion(part.slice(1), path) })
    } else {
      comparators.push({ operator: '=', version: parseVersion(part, path) })
    }
  }
  return comparators
}

export function satisfiesEngine(range: string, version = KERNEL_API_VERSION): boolean {
  const current = parseVersion(version, 'kernel version')
  return parseRange(range, 'engines.guanxi').every(({ operator, version: bound }) => {
    const delta = compare(current, bound)
    return operator === '>=' ? delta >= 0 : operator === '<' ? delta < 0 : delta === 0
  })
}
