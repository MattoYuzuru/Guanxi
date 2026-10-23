import { orientation } from '../native-agent/orientation.ts'

/** ADR-0021 light orientation; expansion requires an ADR-0025 bench result. */
export function harnessSystemPrompt(): string {
  const prompt = `${orientation('chat')}\nReply in the language the user writes in.`
  if (Buffer.byteLength(prompt, 'utf8') > 350) throw new Error('chat_prompt_budget')
  return prompt
}
