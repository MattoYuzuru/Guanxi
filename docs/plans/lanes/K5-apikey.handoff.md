# Lane K5-apikey — hand-off

**Status:** implemented, fixture-validated · **Updated:** 2026-10-23 · **Branch:** `claude/k5-claude-api-key` (base main `9df521d5`) ·
Plan: [K5-apikey.plan](K5-apikey.plan.md) · Decisions: D-211 and D-212 in the
[2026-10-23 addendum](../../decisions/2026-10-23-owner-decisions-addendum.md) · Operator steps:
[MS1 live run §7](../../operations/ms1-live-run.md)

## What changed

- **K5** (`packages/server/src/external-agents/`): `claude-code` can be paid from the K3 vault in two ways besides the CLI sign-in.
  - **API key (D-211):** a `model_api`/`anthropic`/`api_key` connection; injected as `ANTHROPIC_API_KEY`; `auth status` must say
    `api_key` with `apiKeySource: "ANTHROPIC_API_KEY"`.
  - **Subscription token (D-212):** a `claude-code` `agent` connection that holds the owner's `claude setup-token` token; injected as
    `CLAUDE_CODE_OAUTH_TOKEN`; `auth status` must say `oauth_token`. Billing fact `subscription`.
  - **Both:** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`; a vendor settings file in the config directory or `work/.claude` refuses the launch
    (`claude_settings_present`); the endpoint and permission mode are pinned in the bridge's programmatic settings tier; another author
    is refused; no login to prepare. `claudeEffort` goes through the bridge's `effort` option and leaves an `effort` fact.
- **K3** (`packages/server/src/connections/`): `assertOAuthToken`; the dotenv importer reads `CLAUDE_CODE_OAUTH_TOKEN` (and an
  `sk-ant-oat` value under `ANTHROPIC_API_KEY`) only when asked for token mode and stores it on an `agent` connection;
  `dispatchAgent` hands such a connection's token to K5 and to nothing else. `complete()`, chat and `saveSecret` still refuse it, and
  `assertApiKey` still refuses `sk-ant-oat` as an API key. `inspectProviderKeysFile` serves the doctor.
- **ms1-live** (`packages/server/src/ms1-live/`): `home.lead.auth` = `subscription` | `api_key` | `oauth_token`, `connection`,
  `providerKeysFile`, `effort`; boot import and connection resolution (`prepareLeadKey`), `doctor` `lead_key*` checks, `start` prints
  `lead-auth` (mode, billing, key source, never a value) and a one-line `summary` on a refusal. `setUpLead` was extracted from the
  `start` command. `StartOptions.connectionsKeychain` is a test seam; the command's environment (not the process's) names the key file.

## Observed, not assumed (CLI 2.1.287, bridge 0.94.0, fake credentials, offline where a sandbox could deny the network)

- Only `ANTHROPIC_API_KEY`: `auth status` prints `loggedIn:true, authMethod:"api_key", apiKeySource:"ANTHROPIC_API_KEY"`. Only
  `CLAUDE_CODE_OAUTH_TOKEN`: `loggedIn:true, authMethod:"oauth_token"` (no token source). Both: `api_key` wins. Neither: `none`, exit 1.
  None of them wrote the credential into the config directory.
- `claude -p` run offline with a fake key and with a fake token: the credential's last 20 characters appear in no file of the
  config/home directory (no `customApiKeyResponses` entry). No turn completed offline, so a full stream-json turn is unobserved.
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`: an MCP stdio server started by `claude mcp list` no longer sees `ANTHROPIC_API_KEY` or
  `CLAUDE_CONFIG_DIR` (without it, it sees both). The bridge still initialises and opens a session offline with it. Bash tool and hooks
  were not exercised.
- The bridge offers `effort` (`select`) and applies programmatic `_meta.claudeCode.options.settings` as its highest settings tier.

## Decisions taken (defaults)

1. The connection (kind, auth, secret) decides the mode; no installation flag.
2. Vault modes keep the persistent config directory (a lead resumes from it); the directory is keyed by the paying connection, so the
   integrator's earlier `settings.json` in the `ms1-lead` directory is not seen (and would refuse the launch if it were).
3. Effort is installation policy through the ACP option, not a `settings.json` edit and not `params.reasoning`.
4. A failed or credential-less boot import refuses the lead; the vault's older credential is used only when no file is named, and a
   connection that was not imported from the file just read cannot pay.
5. Key-file source: `StartOptions.providerKeysFile`, else `GUANXI_PROVIDER_KEYS_FILE`, else `home.lead.providerKeysFile`; an empty value
   is unset; `start` and `doctor` read the same environment.
6. `claudeBare` still refuses in the vault modes.
7. The token is never routed to an Anthropic API connection; K3's `sk-ant-oat` refusal for API use is unchanged (D-212).

## The configuration the integrator sets (token from `claude setup-token`)

In the home's `ms1-live.json`, `home.lead` (everything else as today):

```json
{ "adapter": "claude-code", "bridge": "<abs path of claude-agent-acp>", "bridgeVersion": "0.94.0",
  "claudeExecutable": "<abs path of the claude CLI>", "billingAccount": "claude-code-account",
  "auth": "oauth_token", "providerKeysFile": "<abs path of the owner's dotenv file>", "effort": "medium",
  "model": "<the bridge's model option value for Sonnet 5.5>", "runDeadlineMs": "...", "limits": { "...": "as before" } }
```

The token may stay under `ANTHROPIC_API_KEY` in that file (or be renamed `CLAUDE_CODE_OAUTH_TOKEN`). Run `ms1-live doctor` first:
`lead_key` must be `ok`. `model` must be `default` or a value of the bridge's model option; a wrong one refuses `model_unavailable`
before any prompt. For a real `sk-ant-api` key use `"auth": "api_key"` instead.

## Review round (coordinator, no P1) — what was done

P2-1 settings guard, pin and `apiKeySource` (separate commit, tests fail without it); P2-2 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` tested
with the real CLI and bridge, documented as an open risk; P2-3 `lead_connection_not_imported`; P2-4 money wording corrected (below);
P2-5 tests no longer read the process's key file or the OS keychain. P3: effort fact and exact `effort` id; vault-unlocked and
`lead_vault_locked` tests; an end-to-end lead turn through `setUpLead` in both modes; `keySource` in `lead-auth`; mode-switch note
in the runbook.

## Evidence

Added tests: `test/external-agents/claude-api-key.test.ts`, `test/external-agents/claude-oauth-token.test.ts` and
`test/ms1-live/lead-api-key.test.ts`; the fixture agent and helper gained API-key and token modes, a value-free environment record,
effort scenarios and an `auth status` that follows the variable it is given. Gate receipts are in the final report of the session
that produced this branch. Regression envelope: the whole external-agents, connections and ms1-live suites.

## Residual risks

1. **No real turn in either vault mode.** The bridge's model value for Sonnet 5.5, the offered effort levels and cost reporting are
   unverified; a full stream-json turn might write something about the credential into the config directory (the offline `-p` run did not).
2. **Credential inheritance.** The scrub was observed for MCP stdio subprocesses only; the CLI's Bash tool and hooks are expected to
   follow but were not exercised, and K5 denies every permission request. Treat as open.
3. **Money.** `limits.maxCaps.moneyMicros` caps the work the lead *delegates*, not the lead's own tokens (no lead money cap exists;
   the owner decided not to add one now). In `api_key` mode set a spend limit on the Anthropic Console workspace that owns the key; in
   `oauth_token` mode the subscription's limits apply.
4. The lead run is interactive for K3 (vault unlocked in process, not `background`): it needs the vault unlocked, which holds until the
   process ends; a locked keychain at boot is `lead_vault_locked`.
5. Switching `auth` switches the config directory: saved lead sessions of the other mode are not found (the lead is seeded into a new
   session). Change the mode only between leads.
6. Any invalid line in the named key file refuses the lead (strict by design).
7. The token's expiry and revocation are the vendor's; a rejected token surfaces as a failed turn, not as a Guanxi check.
