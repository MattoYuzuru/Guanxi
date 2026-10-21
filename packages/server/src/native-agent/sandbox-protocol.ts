import type { AccessMode } from '@guanxi/contract'

export interface SandboxPolicy {
  mode: AccessMode
  scratch: string
  roots: string[]
  attachments: string[]
  protectedPaths: string[]
  domains: string[]
  runtimeBase?: string
  hiddenPaths?: string[]
  attachmentMetadata?: { path: string; mediaType: string; displayName: string }[]
}
export interface CommandResult { code: number | null; stdout: string; stderr: string; truncated: boolean }
export const TOOL_OUTPUT_BYTES = 64 * 1024

