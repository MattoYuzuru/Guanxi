import type { ChatRetentionPolicy } from '@alamo/contract'
import type { ChatRetentionStore } from '../store/chat-retention.ts'

/** Application boundary for retention commands and projections. */
export class ChatRetentionService {
  private readonly store: ChatRetentionStore

  constructor(store: ChatRetentionStore) {
    this.store = store
  }

  get(chatId: string) {
    return this.store.get(chatId)
  }

  update(chatId: string, policy: ChatRetentionPolicy) {
    return this.store.update(chatId, policy)
  }

  listTrash(
    scope: { scope: 'projectless' } | { scope: 'project'; projectId: string },
    limit: number,
  ) {
    return this.store.listTrash(scope, limit)
  }

  restore(chatId: string) {
    return this.store.restore(chatId)
  }
}
