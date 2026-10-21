import type { SandboxPolicy } from './sandbox.ts'
/** UTF-8 bytes are a conservative upper bound for byte-level model tokenizers. */
export function orientation(policy: SandboxPolicy): string {
  const value = `Node=local; OS=${process.platform}; cwd=scratch; roots=${policy.roots.length}; mode=${policy.mode}. Tools: project_info, file_read/write, shell, search, fetch, attachments, plan, queue, note_add, session_log_query. Skills=off. Paths, budgets, AGENTS.md: project_info; read instructions before work.`
  if (Buffer.byteLength(value, 'utf8') > 300) throw new Error('orientation_budget')
  return value
}
