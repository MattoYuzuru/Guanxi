# Lane K5-apikey — hand-off

**Status:** implemented, fixture-validated · **Updated:** 2026-10-23 · **Branch:** `claude/k5-claude-api-key` (base main `9df521d5`) ·
Plan: [K5-apikey.plan](K5-apikey.plan.md) · Decision: D-211 in the
[2026-10-23 addendum](../../decisions/2026-10-23-owner-decisions-addendum.md) · Operator steps:
[MS1 live run §7](../../operations/ms1-live-run.md)

## What changed

- **K5** (`packages/server/src/external-agents/`): a `claude-code` installation bound to a K3 `model_api`/`anthropic`/`api_key`
  connection runs on that key. `payment()` puts it into the child environment as `ANTHROPIC_API_KEY` only; the `auth status` probe
  must report `loggedIn` with `authMethod: "api_key"` (`claude_api_key_not_in_effect` otherwise), the subscription path still accepts
  only `claude.ai`. Provider other than Anthropic or a connection with its own API root: `claude_api_connection_required`. Another
  author: `host_tools_owner_only`; `prepareLogin`: `api_or_local_required`. The persistent per-installation config directory is kept in
  this mode (resume). New installation field `claudeEffort`, applied through the bridge's `effort` config option after the model
  switch (`effort_unavailable`, `effort_selection_failed`); Claude installations only.
- **ms1-live** (`packages/server/src/ms1-live/`): `home.lead.auth`, `connection`, `providerKeysFile`, `effort`; boot import and
  connection resolution (`prepareLeadKey`), `doctor` checks `lead_key*`, `start` prints `lead-auth` and a one-line `summary` on a
  refusal. `StartOptions.connectionsKeychain` is a test seam for the vault's wrapping key.

## Observed, not assumed

CLI 2.1.287 with only `ANTHROPIC_API_KEY=<fake sk-ant-api03-...>` in an isolated `HOME`/`CLAUDE_CONFIG_DIR`: `auth status` prints
`loggedIn:true, authMethod:"api_key", apiKeySource:"ANTHROPIC_API_KEY"`, exit 0; without it `loggedIn:false, authMethod:"none"`,
exit 1; the fake value was not written into the config directory. Whether the command touches the network was not traced.
ACP bridge 0.94.0 (read from the installed package) offers `effort` (`category: thought_level`, `select`).

## Decisions taken (defaults)

1. The connection decides the mode (no installation flag).
2. API mode keeps the persistent config directory.
3. Effort is installation policy through the ACP option, not a `settings.json` edit and not `params.reasoning`.
4. A failed or key-less boot import refuses the lead; the vault's older key is used only when no file is named.
5. Key-file source order: `StartOptions.providerKeysFile`, `GUANXI_PROVIDER_KEYS_FILE`, `home.lead.providerKeysFile` (an empty
   variable is unset).
6. `claudeBare` still refuses in API mode.
7. I did not set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`: its effect on the bridge is unverified.

## The configuration the integrator sets

In the home's `ms1-live.json`, `home.lead` (everything else as today):

```json
{ "adapter": "claude-code", "bridge": "<abs path of claude-agent-acp>", "bridgeVersion": "0.94.0",
  "claudeExecutable": "<abs path of the claude CLI>", "billingAccount": "claude-code-account",
  "auth": "api_key", "providerKeysFile": "<abs path of the owner's dotenv file>", "effort": "medium",
  "model": "<the bridge's model option value for Sonnet 5.5>", "runDeadlineMs": "...", "limits": { "...": "as before" } }
```

Run `ms1-live doctor` first: `lead_key` must be `ok`. `model` must be `default` or a value of the bridge's model option; a wrong
one refuses `model_unavailable` before any prompt (no spend). The `settings.json` the integrator wrote in the subscription config
directory is not used in this mode (the directory is keyed by the paying connection).

## Evidence

Added tests: `test/external-agents/claude-api-key.test.ts` (12) and `test/ms1-live/lead-api-key.test.ts` (5); the fixture agent and
helper gained an API-key mode, a key-echo-free environment record and effort scenarios. Gate receipts are in the final report of the
session that produced this branch. Regression envelope: the whole external-agents (120 before) and ms1-live suites.

## Residual risks

1. **No real turn on the API key was run.** The real CLI was exercised only for `auth status` with a fake key; the bridge, model
   value, effort levels offered for Sonnet 5.5 and cost reporting are unverified.
2. The key is inherited by the CLI's own subprocesses (Bash tool, hooks, MCP stdio); K5 denies every permission request and the lead
   works through the node's MCP tool, which limits but does not remove that. What the vendor CLI writes into its own config directory
   is not inspected (the tests scan only what Guanxi and the fixture write).
3. The lead run is interactive for K3 (vault unlocked in process), not `background`: a node whose vault is locked after boot cannot
   start a lead turn. The vault stays unlocked until the process ends.
4. The key is the owner's money: `limits.maxCaps.moneyMicros` is the only Guanxi-side ceiling; Anthropic-side spend limits are not
   visible to K5.
5. Boot import failure of any line in the named file refuses the lead (strict by design).
