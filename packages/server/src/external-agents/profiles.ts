import type { AdapterId } from './types.ts'

/** Protocol exposure, not a claim about model intelligence or hardware fit. */
export const ADAPTERS = Object.freeze({
  'claude-code': { protocol: 'acp-v1', args: [], payment: 'subscription', plan: true, toolCalls: true, usage: false, resume: false, quota: 'claude.rate_limits', login: 'official-cli', source: 'https://github.com/agentclientprotocol/claude-agent-acp' },
  copilot: { protocol: 'acp-v1', args: ['--acp', '--stdio'], payment: 'subscription', plan: true, toolCalls: true, usage: false, resume: false, quota: null, login: 'official-cli', source: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server' },
  'gemini-cli': { protocol: 'acp-v1', args: ['--experimental-acp'], payment: 'api_key', plan: true, toolCalls: true, usage: false, resume: false, quota: null, login: 'api-key-only', source: 'https://geminicli.com/docs/cli/acp-mode/' },
  opencode: { protocol: 'acp-v1', args: ['acp'], payment: 'api_key', plan: true, toolCalls: true, usage: false, resume: false, quota: null, login: 'api-key-only', source: 'https://docs.opencode.ai/docs/acp/' },
  goose: { protocol: 'acp-v1', args: ['acp'], payment: 'api_key', plan: true, toolCalls: true, usage: false, resume: false, quota: null, login: 'api-key-only', source: 'https://block.github.io/goose/docs/guides/using-acp-clients/' },
  codex: { protocol: 'codex-app-server', args: ['app-server'], payment: 'subscription', plan: true, toolCalls: false, usage: false, resume: false, quota: 'account/rateLimits', login: 'sign-in-with-chatgpt', source: 'https://developers.openai.com/codex/app-server' },
} as const satisfies Record<AdapterId, unknown>)

export const API_ENV = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
} as const
