# Offline protocol recordings

**Status:** locally replayed documentation reconstructions · **Recorded:** 2026-10-21

These are independently authored wire sessions reconstructed from the linked primary protocol
documentation, **not captures from authenticated vendor CLIs**. The version labels came from
public release metadata on 2026-10-21. Replay success validates Guanxi's client against those
wire shapes; it does not establish compatibility with those installed releases. No account,
vendor credentials, model, keychain or network is used by these tests.

| Recording | Primary source | Version metadata |
| --- | --- | --- |
| Claude ACP 0.94.0 | [ACP bridge](https://github.com/agentclientprotocol/claude-agent-acp) | `@agentclientprotocol/claude-agent-acp` npm metadata |
| Copilot 1.0.101 | [ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) | `@github/copilot` npm metadata |
| Gemini CLI 0.65.0 | [ACP mode](https://geminicli.com/docs/cli/acp-mode/) | `@google/gemini-cli` npm metadata |
| OpenCode 1.19.3 | [ACP](https://docs.opencode.ai/docs/acp/) | `opencode-ai` npm metadata |
| Goose 1.55.0 | [ACP clients](https://block.github.io/goose/docs/guides/using-acp-clients/) | `block/goose` GitHub release metadata |
| Codex 0.163.0 | [App-server](https://developers.openai.com/codex/app-server) | `openai/codex` GitHub release metadata |

ACP frames follow [v1 initialization](https://agentclientprotocol.com/protocol/initialization),
[prompt turns](https://agentclientprotocol.com/protocol/prompt-turn) and
[config options](https://agentclientprotocol.com/protocol/session-config-options).
The JSON fixtures contain original synthetic names and data. No upstream source code, prompt,
documentation prose or licensed example implementation is copied. There is no vendored code.

The fixture binary is copied with an absolute Node shebang into a temporary directory. It
replays these response objects, correlates request IDs, records only client protocol frames
and can simulate malformed output, drift, crash, hang and permission requests. Generated
throwaway values test redaction across response chunks. The runtime boundary test lets only
the child fixture read its dummy login while every parent content-read API is trapped.

Future real captures must be collected in an explicit integration envelope, reduced to the
same synthetic data, scrubbed, and reviewed before replacing these reconstructions. Never
commit vendor credentials, private workspace contents or reasoning captured from a person.
