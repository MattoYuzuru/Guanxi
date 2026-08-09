import { PROJECT_NAME_MAX_LENGTH, type Project } from '@alamo/contract'
import type { ProjectStore } from '../store/projects.ts'

export class InvalidProjectNameError extends Error {}

export class ProjectService {
  private readonly store: ProjectStore

  constructor(store: ProjectStore) {
    this.store = store
  }

  list(): Project[] {
    return this.store.list()
  }

  get(id: string): Project | null {
    return this.store.get(id)
  }

  create(name: string): Project {
    return this.store.create(this.validName(name))
  }

  rename(id: string, name: string): Project | null {
    return this.store.rename(id, this.validName(name))
  }

  reconcileLegacyWorkspaces(): void {
    this.store.reconcileLegacyWorkspaces()
  }

  private validName(name: string): string {
    const normalized = name.trim()
    if (normalized.length === 0 || normalized.length > PROJECT_NAME_MAX_LENGTH) {
      throw new InvalidProjectNameError('Project name must contain 1–120 characters')
    }
    return normalized
  }
}
