# ADR-0017: Model access — connections, subscription agents and secrets

**Status:** accepted for policy (owner decision D-104); proposed for design · **Date:** 2026-10-19
**Relates:** legacy ADR-0003 (capability manifest and adapters), ADR-0008 (agent execution).

## Context

The brief wants subscriptions, API keys, local runtimes and non-LLM services (search, STT,
TTS, image) in one place, with balances visible to people and agents, per account, and with
secrets that agents can "read safely".

Verified on 2026-10-19 (lane 1 §7):

| Vendor | Subscription route allowed in third-party apps |
| --- | --- |
| Anthropic | Only the user's own unmodified `claude` binary (ACP or `-p`). OAuth tokens from Free/Pro/Max may not be used in other products, including through the Agent SDK. Since 2026-04-04 such traffic may be billed as extra usage (secondary source). |
| OpenAI | "Sign in with ChatGPT" for open-source and local apps (Responses API, preview), and the Codex app-server. Hosted computer use, image generation and Code Interpreter are not available in that mode. |
| Google | Consumer plans moved to a closed CLI; reusing Gemini CLI OAuth is forbidden. API key only. |
| GitHub | Copilot SDK (MIT) and `copilot --acp`. |

Sharing one subscription with other people is forbidden by every vendor checked.

## Decision

1. **Connection registry** (one per account) with kinds:
   - `agent` — an external CLI agent driven over ACP/app-server (Claude Code, Codex, Copilot,
     Gemini CLI with API key, OpenCode, Goose);
   - `model_api` — API key or vendor-sanctioned sign-in token for a model provider;
   - `local_runtime` — a runtime on a node (see ADR-0031);
   - `service` — web search, STT, TTS, image/video API, cloud GPU provider.
   Each connection carries capabilities, limits, health, balance and cost facts, each with
   `source`, `observedAt` and `confidence`.
2. **Subscriptions only through sanctioned routes** (D-104). The plugin API does not block
   third-party auth plugins installed by a user at their own risk; core neither ships nor
   recommends them. The `pi-ai` Anthropic OAuth module is disabled in the core profile.
3. **Balances and cost**: probes per provider where an API exists (for example OpenRouter key
   credits, DeepSeek user balance, OpenAI/Anthropic admin usage APIs when the user supplies an
   admin key); otherwise local metering from usage events. A cost ledger attributes spend to
   connection, run and account.
4. **Secrets**:
   - a per-account vault (encrypted file in the node database) whose data key is wrapped by
     the OS keychain through `@napi-rs/keyring`;
   - agents, prompts, logs, traces and auditors see only `secret://` references and derived
     facts;
   - values are injected just in time at the HTTP-client or process-spawn boundary;
   - one **egress scrubber** removes known secret values by exact match, then by rules
     (secretlint/gitleaks), at every boundary where data leaves the node process: model
     request construction (including tool results), artifact write before hashing
     (handoffs, wake packets, reports), event write, log write and every export;
   - vendor CLI logins are never stored by Guanxi; accounts are isolated with
     `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and equivalents.
5. **Unattended use**: connections marked `unattended` may be unlocked by the node key so
   background runs work without an interactive login; others require an unlocked session.
   Node-key wrapping is opt-in per node and only on `owner_device` nodes.
6. **Replication**: the vault never leaves the account owner's opted-in `owner_device` nodes;
   `cloud_ephemeral` nodes receive only per-attempt, scoped, expiring secret grants when the
   run policy allows (ADR-0018 §2).

## Invariants

- No secret value ever appears in a model request body other than the provider's own auth
  header, in an event, a log line or a trace.
- A balance or limit without `observedAt` is displayed as `unknown`.
- Proprietary agents and SDKs are never bundled; the user installs them.

## Consequences

- Claude subscription use depends on the user's Claude Code install and its terms (including
  the announced change that `--bare` becomes the default for `-p` and does not read the
  subscription login). Guanxi must detect and report that state rather than work around it.
- External agents are black boxes for compaction and internal tools; Guanxi traces only what
  their protocol exposes.

## Validation

- Integration test: a fake provider echoes request headers and bodies; the scrubber test
  asserts that a planted secret never appears in events, logs or exported traces.
- End-to-end trace: a secret injected into a tool's environment and printed by a failing test
  never appears in the next model request, the ledger, the sealed handoff, the wake packet or
  a J3 review request.
- A `cloud_ephemeral` node receives 0 vault records over a full delegated run.
- Contract tests per balance probe with recorded fixtures; a missing timestamp renders
  `unknown`.
- ACP adapter tests against recorded sessions of each supported agent version.

## Evidence

Lane 1 §§7–12 and its ToS risk register ([research](../research/README.md)).
