/**
 * Tracker sync engine (WG2-a).
 *
 * The engine owns policy; adapters own transport shape. Business fields are imported into
 * display metadata and never sent outward. A coarse transition posts one marked status
 * comment (checked against existing comments first) and then one status label swap or one
 * mapped Jira transition. Rate-limit decisions return an exact retry time; the engine never
 * sleeps and never retries inside one call.
 */
import { DERIVED_STATUSES, type DerivedStatus } from '../types.ts'
import { RateLimitGovernor, type RateLimitDecision } from './rate-limit.ts'
import {
  TrackerRetryableError,
  TrackerSyncError,
  TrackerTransportError,
  headerValue,
  isCoarseStatus,
  isSuccessStatus,
  transitionMarker,
  type BusinessField,
  type BusinessFieldChange,
  type DeferReason,
  type ItemDisplayMetadata,
  type PollResult,
  type RemoteBusinessFields,
  type SyncDeferral,
  type SyncResult,
  type SyncWrite,
  type TrackerAdapter,
  type TrackerLink,
  type TransitionEvidence,
} from './types.ts'

const BUSINESS_FIELDS: readonly BusinessField[] = [
  'title',
  'description',
  'priority',
  'assignee',
  'labels',
]

export interface SyncEngineOptions {
  adapter: TrackerAdapter
  governor?: RateLimitGovernor
  now?: () => number
}

export interface SyncOptions {
  now?: number
  evidence?: TransitionEvidence
}

function cloneLink(link: TrackerLink): TrackerLink {
  return { ...link }
}

function cloneMetadata(metadata: ItemDisplayMetadata): ItemDisplayMetadata {
  return { ...metadata, labels: [...metadata.labels] }
}

function fieldValue(metadata: ItemDisplayMetadata | null, field: BusinessField) {
  return metadata === null ? null : metadata[field]
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index])
  }
  return left === right
}

function diffFields(
  previous: ItemDisplayMetadata | null,
  fields: RemoteBusinessFields,
): BusinessFieldChange[] {
  const changes: BusinessFieldChange[] = []
  for (const field of BUSINESS_FIELDS) {
    const from = fieldValue(previous, field)
    const to = fields[field]
    if (!sameValue(from, to)) changes.push({ field, from, to })
  }
  return changes
}

function commentBody(
  link: TrackerLink,
  status: DerivedStatus,
  marker: string,
  evidence: TransitionEvidence | undefined,
): string {
  const lines = [`Guanxi item \`${link.itemId}\` is now **${status}**.`]
  if (status === 'done') {
    if (evidence?.url !== undefined && evidence.url !== '') {
      lines.push(`Evidence: ${evidence.url}`)
    } else if (evidence?.commit !== undefined && evidence.commit !== '') {
      lines.push(`Evidence commit: \`${evidence.commit}\``)
    }
    if (evidence?.summary !== undefined && evidence.summary !== '') {
      lines.push(evidence.summary)
    }
  }
  lines.push('', marker)
  return lines.join('\n')
}

function deferred(
  link: TrackerLink,
  decision: RateLimitDecision | { reason?: DeferReason; nextAllowedAt: number },
  writes: SyncWrite[] = [],
): SyncResult {
  return {
    outcome: 'deferred',
    link: cloneLink(link),
    writes,
    commentPosted: writes.some(write => write.kind === 'comment' && !write.skipped),
    deferred: {
      reason: decision.reason ?? 'server_backoff',
      nextAllowedAt: decision.nextAllowedAt,
    },
  }
}

function validateStatus(status: DerivedStatus): void {
  if (!(DERIVED_STATUSES as readonly string[]).includes(status)) {
    throw new TrackerSyncError('invalid_status', `unknown derived status ${String(status)}`)
  }
}

export class TrackerSyncEngine {
  private readonly adapter: TrackerAdapter
  private readonly governor: RateLimitGovernor
  private readonly clock: () => number
  private readonly links = new Map<string, TrackerLink>()
  private readonly metadataByItem = new Map<string, ItemDisplayMetadata>()

  constructor(options: SyncEngineOptions) {
    this.adapter = options.adapter
    this.clock = options.now ?? (() => Date.now())
    this.governor = options.governor ?? new RateLimitGovernor({ now: this.clock })
    this.adapter.observeReads?.(observation => {
      this.governor.observeRead(observation)
    })
  }

  registerLink(link: TrackerLink): TrackerLink {
    this.assertLink(link)
    const copy = cloneLink(link)
    this.links.set(link.itemId, copy)
    return cloneLink(copy)
  }

  link(itemId: string): TrackerLink | undefined {
    const found = this.links.get(itemId)
    return found === undefined ? undefined : cloneLink(found)
  }

  metadata(itemId: string): ItemDisplayMetadata | undefined {
    const found = this.metadataByItem.get(itemId)
    return found === undefined ? undefined : cloneMetadata(found)
  }

  /**
   * Reads the remote issue with an ETag / If-Modified-Since conditional request. A 304
   * returns no changes and leaves both the link and display metadata untouched.
   */
  async poll(link: TrackerLink, now = this.clock()): Promise<PollResult> {
    this.assertLink(link)
    let read
    try {
      read = await this.adapter.read(link.externalKey, {
        etag: link.lastRemoteEtag,
        updatedAt: link.lastRemoteUpdatedAt,
      })
    } catch (error) {
      if (error instanceof TrackerRetryableError) {
        const metadata = this.metadataByItem.get(link.itemId) ?? null
        return {
          link: cloneLink(link),
          notModified: false,
          changed: false,
          changes: [],
          metadata: metadata === null ? null : cloneMetadata(metadata),
          deferred: this.readDeferral(link, error, now),
        }
      }
      throw error
    }
    if (read.notModified) {
      const metadata = this.metadataByItem.get(link.itemId) ?? null
      return {
        link: cloneLink(link),
        notModified: true,
        changed: false,
        changes: [],
        metadata: metadata === null ? null : cloneMetadata(metadata),
      }
    }

    const previous = this.metadataByItem.get(link.itemId) ?? null
    const changes = diffFields(previous, read.fields)
    const metadata: ItemDisplayMetadata = {
      ...read.fields,
      labels: [...read.fields.labels],
      itemId: link.itemId,
      tracker: link.tracker,
      externalKey: link.externalKey,
      fetchedAt: now,
    }
    this.metadataByItem.set(link.itemId, metadata)
    const nextLink: TrackerLink = {
      ...link,
      lastRemoteEtag: read.etag ?? link.lastRemoteEtag,
      lastRemoteUpdatedAt: read.updatedAt ?? link.lastRemoteUpdatedAt,
    }
    this.links.set(link.itemId, cloneLink(nextLink))
    return {
      link: cloneLink(nextLink),
      notModified: false,
      changed: changes.length > 0,
      changes,
      metadata: cloneMetadata(metadata),
    }
  }

  /**
   * Applies one derived status. A write is attempted only for a transition into the coarse
   * set, and only once per transition: the marker is looked up before any POST.
   */
  async sync(
    link: TrackerLink,
    status: DerivedStatus,
    options: SyncOptions = {},
  ): Promise<SyncResult> {
    this.assertLink(link)
    validateStatus(status)
    const now = options.now ?? this.clock()
    if (status === link.lastSyncedStatus) {
      return { outcome: 'unchanged', link: cloneLink(link), writes: [], commentPosted: false }
    }

    if (!isCoarseStatus(status)) {
      const nextLink: TrackerLink = { ...link, lastSyncedStatus: status }
      this.links.set(link.itemId, cloneLink(nextLink))
      return { outcome: 'synced', link: cloneLink(nextLink), writes: [], commentPosted: false }
    }

    const writes: SyncWrite[] = []
    const seq = (link.lastTransitionSeq ?? 0) + 1
    const marker = transitionMarker(link.itemId, status, seq)
    let pending = cloneLink(link)

    let comments
    try {
      comments = await this.adapter.listComments(link.externalKey)
    } catch (error) {
      if (error instanceof TrackerTransportError) {
        const observation = this.governor.observeTransportFailure({
          tracker: link.tracker,
          key: link.externalKey,
          now,
        })
        return deferred(link, observation)
      }
      if (error instanceof TrackerRetryableError) {
        return deferred(link, this.readDeferral(link, error, now))
      }
      throw error
    }

    const existing = comments.find(comment => comment.body.includes(marker))
    let commentPosted = false
    if (existing !== undefined) {
      pending = { ...pending, lastCommentId: existing.id, lastTransitionSeq: seq }
      writes.push({ kind: 'comment', skipped: true, commentId: existing.id })
    } else {
      const decision = this.governor.checkWrite({
        tracker: link.tracker,
        key: link.externalKey,
        contentCreation: true,
        now,
      })
      if (!decision.allowed) return deferred(link, decision)

      let result
      try {
        result = await this.adapter.mutate(link.externalKey, {
          kind: 'comment',
          body: commentBody(link, status, marker, options.evidence),
          marker,
        })
      } catch (error) {
        if (error instanceof TrackerTransportError) {
          const observation = this.governor.observeTransportFailure({
            tracker: link.tracker,
            key: link.externalKey,
            now,
          })
          return deferred(link, observation)
        }
        throw error
      }

      const observation = this.governor.observeWrite({
        tracker: link.tracker,
        key: link.externalKey,
        status: result.status,
        headers: result.headers,
        contentCreation: true,
        retryable: result.retryable,
        now,
      })
      if (observation.retry) return deferred(link, observation)

      if (!isSuccessStatus(result.status)) {
        throw new TrackerSyncError(
          'remote_rejected',
          `status comment rejected with status ${result.status}`,
        )
      }
      if (result.commentId !== undefined) pending = { ...pending, lastCommentId: result.commentId }
      pending = { ...pending, lastTransitionSeq: seq }
      commentPosted = true
      writes.push({
        kind: 'comment',
        skipped: false,
        ...(result.commentId === undefined ? {} : { commentId: result.commentId }),
      })
    }

    const mapping = this.adapter.statusMapping(status)
    if (mapping !== 'none') {
      const decision = this.governor.checkWrite({
        tracker: link.tracker,
        key: link.externalKey,
        contentCreation: false,
        now,
      })
      // Keep the pre-transition link until every write for this transition succeeds.
      // Retrying with the same sequence reuses the marker and cannot double-post.
      if (!decision.allowed) return deferred(link, decision, writes)

      let result
      try {
        result = await this.adapter.mutate(
          link.externalKey,
          mapping === 'label'
            ? { kind: 'status-label', status }
            : { kind: 'transition', status },
        )
      } catch (error) {
        if (error instanceof TrackerTransportError) {
          const observation = this.governor.observeTransportFailure({
            tracker: link.tracker,
            key: link.externalKey,
            now,
          })
          return deferred(link, observation, writes)
        }
        if (error instanceof TrackerRetryableError) {
          return deferred(link, this.readDeferral(link, error, now), writes)
        }
        throw error
      }

      const observation = this.governor.observeWrite({
        tracker: link.tracker,
        key: link.externalKey,
        status: result.status,
        headers: result.headers,
        contentCreation: false,
        retryable: result.retryable,
        now,
      })
      if (observation.retry) return deferred(link, observation, writes)
      if (!isSuccessStatus(result.status)) {
        throw new TrackerSyncError(
          'remote_rejected',
          `${mapping} write rejected with status ${result.status}`,
        )
      }
      writes.push({
        kind: mapping === 'label' ? 'status-label' : 'transition',
        skipped: result.skipped === true,
      })
    }

    const finalLink: TrackerLink = { ...pending, lastSyncedStatus: status }
    this.links.set(link.itemId, cloneLink(finalLink))
    return {
      outcome: 'synced',
      link: cloneLink(finalLink),
      writes,
      commentPosted,
    }
  }

  /**
   * The adapter already reported the retryable read; read the exact scheduled time back
   * from the governor instead of observing the same response twice.
   */
  private readDeferral(
    link: TrackerLink,
    error: TrackerRetryableError,
    now: number,
  ): SyncDeferral {
    const nextAllowedAt = this.governor.nextAllowedAt({
      tracker: link.tracker,
      key: link.externalKey,
      contentCreation: false,
      now,
    })
    const reason: DeferReason = headerValue(error.headers, 'retry-after') !== undefined
      ? 'retry_after'
      : error.status === 403
        ? 'secondary_limit'
        : 'server_backoff'
    return { reason, nextAllowedAt: Math.max(now, nextAllowedAt) }
  }

  private assertLink(link: TrackerLink): void {
    if (link.tracker !== this.adapter.tracker) {
      throw new TrackerSyncError(
        'tracker_mismatch',
        `link tracker ${link.tracker} does not match adapter ${this.adapter.tracker}`,
      )
    }
    if (
      typeof link.itemId !== 'string' || link.itemId === ''
      || typeof link.externalKey !== 'string' || link.externalKey === ''
    ) {
      throw new TrackerSyncError('invalid_config', 'link itemId and externalKey must be non-empty')
    }
    if (
      link.lastTransitionSeq !== undefined
      && (!Number.isInteger(link.lastTransitionSeq) || link.lastTransitionSeq < 0)
    ) {
      throw new TrackerSyncError('invalid_config', 'link lastTransitionSeq must be a non-negative integer')
    }
  }
}
