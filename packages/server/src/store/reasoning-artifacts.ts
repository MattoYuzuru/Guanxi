import {
  REASONING_ARTIFACT_VERSION,
  REASONING_RETENTION_DAYS,
  reasoningArtifactSchema,
  reasoningArtifactWithContentSchema,
  type GeneratedAnswerProjection,
  type ReasoningArtifact,
  type ReasoningArtifactWithContent,
} from '@alamo/contract'
import { createHash } from 'node:crypto'
import type { Db } from './db.ts'

export interface ReasoningArtifactRow {
  id: string
  artifact_version: number
  chat_id: string
  project_id: string | null
  source_message_id: string
  source_job_id: string
  media_type: string
  storage_kind: string
  content_text: string
  byte_size: number
  checksum: string
  created_at: string
  artifact_expires_at: string
  parent_retention_mode: string
  parent_retention_expires_at: string | null
  effective_expires_at: string
}

export interface ReasoningArtifactScope {
  scope: 'projectless' | 'project'
  projectId: string | null
}

export function toReasoningArtifact(
  row: ReasoningArtifactRow,
  currentParent?: { mode: 'keep' | 'ttl' | 'session'; expiresAt: string | null },
): ReasoningArtifact {
  const byteSize = Buffer.byteLength(row.content_text, 'utf8')
  const checksum = `sha256:${createHash('sha256')
    .update(Buffer.from(row.content_text, 'utf8'))
    .digest('hex')}`
  if (row.byte_size !== byteSize || row.checksum !== checksum) {
    throw new Error(`Reasoning Artifact ${row.id} failed content integrity validation`)
  }
  const parentMode = currentParent?.mode ?? row.parent_retention_mode
  const parentExpiresAt = currentParent ? currentParent.expiresAt : row.parent_retention_expires_at
  const effectiveExpiresAt = parentExpiresAt && parentExpiresAt < row.artifact_expires_at
    ? parentExpiresAt
    : row.artifact_expires_at
  return reasoningArtifactSchema.parse({
    artifactVersion: row.artifact_version,
    id: row.id,
    type: 'reasoning',
    mediaType: row.media_type,
    storageKind: row.storage_kind,
    byteSize: row.byte_size,
    checksum: row.checksum,
    createdAt: row.created_at,
    source: {
      chatId: row.chat_id,
      messageId: row.source_message_id,
      jobId: row.source_job_id,
    },
    ownership: row.project_id === null
      ? { scope: 'projectless', projectId: null }
      : { scope: 'project', projectId: row.project_id },
    retention: {
      basis: 'diagnostic_7_days',
      expiresAfterDays: REASONING_RETENTION_DAYS,
      artifactExpiresAt: row.artifact_expires_at,
      parentMode,
      parentExpiresAt,
      effectiveExpiresAt,
      relationship: 'shorter_parent_retention_wins',
      automaticDeletion: 'not_implemented',
    },
  })
}

function matchesScope(projectId: string | null, scope: ReasoningArtifactScope): boolean {
  return scope.scope === 'project'
    ? scope.projectId !== null && projectId === scope.projectId
    : scope.projectId === null && projectId === null
}

export class ReasoningArtifactStore {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  list(chatId: string, scope: ReasoningArtifactScope): {
    status: 'ok' | 'not_found' | 'scope_mismatch' | 'in_trash'
    generatedAnswers?: GeneratedAnswerProjection[]
    artifacts?: ReasoningArtifact[]
  } {
    const chat = this.db
      .prepare(
        `SELECT id, mode, project_id, chat_lifecycle_state, retention_policy,
                last_user_activity_at, created_at
         FROM threads WHERE id = ?`,
      )
      .get(chatId) as unknown as {
        id: string
        mode: string
        project_id: string | null
        chat_lifecycle_state: string
        retention_policy: 'keep' | 'ttl' | 'session'
        last_user_activity_at: string | null
        created_at: string
      } | undefined
    if (!chat || chat.mode !== 'chat') return { status: 'not_found' }
    if (!matchesScope(chat.project_id, scope)) return { status: 'scope_mismatch' }
    if (chat.chat_lifecycle_state !== 'active') return { status: 'in_trash' }

    const rows = this.db
      .prepare('SELECT * FROM reasoning_artifacts WHERE chat_id = ? ORDER BY created_at, id')
      .all(chatId) as unknown as ReasoningArtifactRow[]
    const answers = this.db
      .prepare(
        `SELECT id, job_id, created_at, length(CAST(content AS BLOB)) AS byte_size
         FROM messages
         WHERE thread_id = ? AND role = 'assistant' AND job_id IS NOT NULL
           AND turn_status = 'completed'
         ORDER BY created_at, id`,
      )
      .all(chatId) as unknown as Array<{
        id: string
        job_id: string
        created_at: string
        byte_size: number
      }>
    return {
      status: 'ok',
      generatedAnswers: answers.map((answer) => ({
        messageId: answer.id,
        jobId: answer.job_id,
        createdAt: answer.created_at,
        byteSize: answer.byte_size,
      })),
      artifacts: rows.map((row) => toReasoningArtifact(row, {
        mode: chat.retention_policy,
        expiresAt: chat.retention_policy === 'ttl'
          ? new Date(
              Date.parse(chat.last_user_activity_at ?? chat.created_at) + 7 * 24 * 60 * 60 * 1_000,
            ).toISOString()
          : null,
      })),
    }
  }

  get(chatId: string, artifactId: string, scope: ReasoningArtifactScope):
    | { status: 'ok'; artifact: ReasoningArtifactWithContent }
    | { status: 'not_found' | 'scope_mismatch' | 'in_trash' } {
    const listed = this.list(chatId, scope)
    if (listed.status !== 'ok') return { status: listed.status }
    const row = this.db
      .prepare('SELECT * FROM reasoning_artifacts WHERE id = ? AND chat_id = ?')
      .get(artifactId, chatId) as unknown as ReasoningArtifactRow | undefined
    if (!row) return { status: 'not_found' }
    const projection = listed.artifacts?.find((artifact) => artifact.id === artifactId)
    if (!projection) return { status: 'not_found' }
    return {
      status: 'ok',
      artifact: reasoningArtifactWithContentSchema.parse({
        ...projection,
        content: row.content_text,
      }),
    }
  }
}

export const REASONING_ARTIFACT_DB_VERSION = REASONING_ARTIFACT_VERSION
