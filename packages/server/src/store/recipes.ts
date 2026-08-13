import { createHash, randomUUID } from 'node:crypto'
import {
  RECIPE_REVISION_VERSION,
  RECIPE_VERSION,
  recipeConfigurationSchema,
  recipeNameSchema,
  recipeRevisionSchema,
  recipeSchema,
  type Recipe,
  type RecipeConfiguration,
  type RecipeJsonValue,
  type RecipeRevision,
  type RecipeScope,
} from '@alamo/contract'
import type { Db } from './db.ts'

interface RecipeRow {
  id: string
  recipe_version: number
  project_id: string | null
  name: string
  created_at: string
  updated_at: string
  current_revision: number
}

interface RecipeRevisionRow {
  recipe_id: string
  revision_number: number
  recipe_revision_version: number
  operation: string
  model_state: string
  model_provider: string | null
  model_reference: string | null
  instructions: string
  default_parameters_json: string
  retention_policy: string
  configuration_json: string
  configuration_byte_size: number
  configuration_sha256: string
  created_at: string
}

export type RecipeStoreResult =
  | { status: 'ok'; recipe: Recipe }
  | { status: 'not_found' }
  | { status: 'scope_mismatch' }

export type RecipeRevisionStoreResult =
  | { status: 'ok'; revision: RecipeRevision }
  | { status: 'not_found' }
  | { status: 'scope_mismatch' }

export type ReviseRecipeStoreResult = RecipeStoreResult | {
  status: 'conflict'
  currentRevision: number
}

function scopeProjectId(scope: RecipeScope): string | null {
  return scope.scope === 'project' ? scope.projectId : null
}

function canonicalValue(value: RecipeJsonValue): RecipeJsonValue {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key]!)]),
    )
  }
  return value
}

export function canonicalRecipeConfiguration(configurationInput: RecipeConfiguration): string {
  const configuration = recipeConfigurationSchema.parse(configurationInput)
  return JSON.stringify(canonicalValue(configuration as RecipeJsonValue))
}

function digest(bytes: string): { byteSize: number; sha256: string } {
  return {
    byteSize: Buffer.byteLength(bytes, 'utf8'),
    sha256: createHash('sha256').update(bytes, 'utf8').digest('hex'),
  }
}

function parseRevision(row: RecipeRevisionRow): RecipeRevision {
  let raw: unknown
  try {
    raw = JSON.parse(row.configuration_json)
  } catch {
    throw new Error(`Recipe ${row.recipe_id} revision ${row.revision_number} has malformed bytes`)
  }
  const configuration = recipeConfigurationSchema.parse(raw)
  const canonical = canonicalRecipeConfiguration(configuration)
  const proof = digest(row.configuration_json)
  if (
    canonical !== row.configuration_json ||
    proof.byteSize !== row.configuration_byte_size ||
    proof.sha256 !== row.configuration_sha256 ||
    configuration.recipeRevisionVersion !== row.recipe_revision_version ||
    configuration.operation !== row.operation ||
    configuration.instructions !== row.instructions ||
    JSON.stringify(configuration.defaultParameters) !== row.default_parameters_json ||
    configuration.retention.mode !== row.retention_policy ||
    configuration.model.state !== row.model_state ||
    (configuration.model.state === 'explicit'
      ? configuration.model.provider !== row.model_provider || configuration.model.reference !== row.model_reference
      : row.model_provider !== null || row.model_reference !== null)
  ) {
    throw new Error(`Recipe ${row.recipe_id} revision ${row.revision_number} failed integrity validation`)
  }
  return recipeRevisionSchema.parse({
    recipeRevisionVersion: row.recipe_revision_version,
    recipeId: row.recipe_id,
    revision: row.revision_number,
    configuration,
    canonical: { format: 'canonical_json_v1', ...proof },
    createdAt: row.created_at,
  })
}

export class RecipeStore {
  private readonly db: Db
  private readonly options: { clock?: () => string; createId?: () => string }

  constructor(
    db: Db,
    options: { clock?: () => string; createId?: () => string } = {},
  ) {
    this.db = db
    this.options = options
  }

  create(input: { name: string; scope: RecipeScope; configuration: RecipeConfiguration }): Recipe {
    const configuration = recipeConfigurationSchema.parse(input.configuration)
    const name = recipeNameSchema.parse(input.name)
    const id = this.options.createId?.() ?? randomUUID()
    const now = this.options.clock?.() ?? new Date().toISOString()
    this.transaction(() => {
      this.db.prepare(
        `INSERT INTO recipes (
           id, recipe_version, project_id, name, created_at, updated_at, current_revision
         ) VALUES (?, ?, ?, ?, ?, ?, 1)`,
      ).run(id, RECIPE_VERSION, scopeProjectId(input.scope), name, now, now)
      this.insertRevision(id, 1, configuration, now)
    })
    return this.requireRecipe(id)
  }

  list(scope: RecipeScope): Recipe[] {
    const rows = scope.scope === 'project'
      ? this.db.prepare('SELECT * FROM recipes WHERE project_id = ? ORDER BY updated_at DESC, id').all(scope.projectId)
      : this.db.prepare('SELECT * FROM recipes WHERE project_id IS NULL ORDER BY updated_at DESC, id').all()
    return (rows as unknown as RecipeRow[]).map((row) => this.toRecipe(row))
  }

  get(id: string, scope: RecipeScope): RecipeStoreResult {
    const row = this.readRecipeRow(id)
    if (!row) return { status: 'not_found' }
    if (row.project_id !== scopeProjectId(scope)) return { status: 'scope_mismatch' }
    return { status: 'ok', recipe: this.toRecipe(row) }
  }

  getRevision(id: string, revision: number, scope: RecipeScope): RecipeRevisionStoreResult {
    const recipe = this.readRecipeRow(id)
    if (!recipe) return { status: 'not_found' }
    if (recipe.project_id !== scopeProjectId(scope)) return { status: 'scope_mismatch' }
    const row = this.readRevisionRow(id, revision)
    return row ? { status: 'ok', revision: parseRevision(row) } : { status: 'not_found' }
  }

  rename(id: string, scope: RecipeScope, nameInput: string): RecipeStoreResult {
    const name = recipeNameSchema.parse(nameInput)
    const now = this.options.clock?.() ?? new Date().toISOString()
    const result = this.db.prepare(
      'UPDATE recipes SET name = ?, updated_at = ? WHERE id = ? AND project_id IS ?',
    ).run(name, now, id, scopeProjectId(scope))
    if (result.changes === 1) return { status: 'ok', recipe: this.requireRecipe(id) }
    return this.readRecipeRow(id) ? { status: 'scope_mismatch' } : { status: 'not_found' }
  }

  revise(
    id: string,
    scope: RecipeScope,
    expectedRevision: number,
    configurationInput: RecipeConfiguration,
  ): ReviseRecipeStoreResult {
    const configuration = recipeConfigurationSchema.parse(configurationInput)
    let outcome: ReviseRecipeStoreResult = { status: 'not_found' }
    this.transaction(() => {
      const row = this.readRecipeRow(id)
      if (!row) return
      if (row.project_id !== scopeProjectId(scope)) {
        outcome = { status: 'scope_mismatch' }
        return
      }
      if (row.current_revision !== expectedRevision) {
        outcome = { status: 'conflict', currentRevision: row.current_revision }
        return
      }
      const nextRevision = expectedRevision + 1
      const now = this.options.clock?.() ?? new Date().toISOString()
      this.insertRevision(id, nextRevision, configuration, now)
      const updated = this.db.prepare(
        `UPDATE recipes SET current_revision = ?, updated_at = ?
         WHERE id = ? AND project_id IS ? AND current_revision = ?`,
      ).run(nextRevision, now, id, scopeProjectId(scope), expectedRevision)
      if (updated.changes !== 1) throw new Error(`Recipe ${id} revision compare-and-set failed`)
      outcome = { status: 'ok', recipe: this.requireRecipe(id) }
    })
    return outcome
  }

  private insertRevision(
    recipeId: string,
    revision: number,
    configuration: RecipeConfiguration,
    createdAt: string,
  ): void {
    const bytes = canonicalRecipeConfiguration(configuration)
    const proof = digest(bytes)
    const modelProvider = configuration.model.state === 'explicit' ? configuration.model.provider : null
    const modelReference = configuration.model.state === 'explicit' ? configuration.model.reference : null
    this.db.prepare(
      `INSERT INTO recipe_revisions (
         recipe_id, revision_number, recipe_revision_version, operation,
         model_state, model_provider, model_reference, instructions,
         default_parameters_json, retention_policy, configuration_json,
         configuration_byte_size, configuration_sha256, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      recipeId,
      revision,
      RECIPE_REVISION_VERSION,
      configuration.operation,
      configuration.model.state,
      modelProvider,
      modelReference,
      configuration.instructions,
      JSON.stringify(canonicalValue(configuration.defaultParameters)),
      configuration.retention.mode,
      bytes,
      proof.byteSize,
      proof.sha256,
      createdAt,
    )
  }

  private toRecipe(row: RecipeRow): Recipe {
    const revisionRow = this.readRevisionRow(row.id, row.current_revision)
    if (!revisionRow) throw new Error(`Recipe ${row.id} current revision is missing`)
    return recipeSchema.parse({
      recipeVersion: row.recipe_version,
      id: row.id,
      name: row.name,
      scope: row.project_id === null ? 'projectless' : 'project',
      projectId: row.project_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      currentRevision: parseRevision(revisionRow),
      advancedRouting: 'not_implemented',
      execution: 'not_implemented',
      jobSnapshot: 'not_implemented',
    })
  }

  private readRecipeRow(id: string): RecipeRow | null {
    return (this.db.prepare('SELECT * FROM recipes WHERE id = ?').get(id) as unknown as RecipeRow | undefined) ?? null
  }

  private readRevisionRow(id: string, revision: number): RecipeRevisionRow | null {
    return (this.db.prepare(
      'SELECT * FROM recipe_revisions WHERE recipe_id = ? AND revision_number = ?',
    ).get(id, revision) as unknown as RecipeRevisionRow | undefined) ?? null
  }

  private requireRecipe(id: string): Recipe {
    const row = this.readRecipeRow(id)
    if (!row) throw new Error(`Recipe ${id} was not persisted`)
    return this.toRecipe(row)
  }

  private transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* preserve original failure */ }
      throw error
    }
  }
}
