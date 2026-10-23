/** U1-b command palettes call this entry point; they never import the engine. */
export const MOVE_BLOCK_COMMAND = 'workspace.move-block'
export const REVEAL_BLOCK_COMMAND = 'workspace.reveal-block'
export function requestBlockMove(instanceId?: string): void {
  window.dispatchEvent(new CustomEvent(MOVE_BLOCK_COMMAND, { detail: { instanceId } }))
}
export function requestBlockReveal(instanceId: string): void {
  window.dispatchEvent(new CustomEvent(REVEAL_BLOCK_COMMAND, { detail: { instanceId } }))
}
