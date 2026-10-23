import { orientation } from '../native-agent/orientation.ts'

/** ADR-0021 light orientation; expansion requires an ADR-0025 bench result. */
export function harnessSystemPrompt(): string {
  return orientation('chat')
}
