# Lane K5-apikey — MS1 Claude Code lead on an Anthropic API key

**Status:** accepted bounded plan · **Updated:** 2026-10-23 · **Branch:** `claude/k5-claude-api-key` (from main `9df521d5`) ·
**Ports:** `GUANXI_WEB_PORT=5239`, `GUANXI_API_PORT=4439`

## Why

The owner's subscription sign-in into K5's private Claude config directory did not take (`claude auth status` there reports
`loggedIn:false, authMethod:none`). The owner asked to run the MS1 lead on the Anthropic API key from the git-ignored dotenv
file instead (D-211, billed as API usage, planning and final review only; Sonnet 5.5 at medium effort stays D-210).

## Observed facts (not assumed)

- `claude auth status` of CLI 2.1.287 with only `ANTHROPIC_API_KEY=<fake sk-ant-api03-…>` in an isolated `HOME` and
  `CLAUDE_CONFIG_DIR` prints `loggedIn:true, authMethod:"api_key", apiKeySource:"ANTHROPIC_API_KEY"`, exit 0. Without the
  variable: `loggedIn:false, authMethod:"none"`, exit 1. The key value was not written into the config directory.
  Network behaviour of the real command was not traced; only a fake key was used.
- The operator-installed ACP bridge 0.94.0 exposes an `effort` select config option (`category: thought_level`), settable
  through `session/set_config_option`; the CLI also accepts `CLAUDE_CODE_EFFORT_LEVEL`.

## Decisions taken (defaults, recorded here and in the hand-off)

1. The K3 connection decides the payment mode of a `claude-code` installation: an `agent`/`cli_login` connection keeps the
   subscription path unchanged; a `model_api`/`anthropic`/`api_key` connection selects the API path. No new installation field.
2. API mode injects the key only into the child environment as `ANTHROPIC_API_KEY` through `payment()`. `auth status` must report
   `loggedIn` with `authMethod:"api_key"`; subscription mode still requires `claude.ai`. Neither mode accepts the other's method.
3. The Claude config directory stays the persistent per-installation one in API mode (lead sessions are resumed with
   `session/load`, which needs the saved transcripts). The key never goes there; only other API agents use throwaway directories.
4. A `claude-code` API connection can never pay for another account's prompt (`host_tools_owner_only`, no editor grant).
5. Effort is a new installation policy field `claudeEffort` set through the bridge's `effort` config option (refused with
   `effort_unavailable` when the bridge does not offer that level). The vendor's settings files are not edited.
6. ms1-live: `home.lead.auth` (`subscription` default | `api_key`), `home.lead.connection` (name or id of the K3 anthropic
   connection, optional when exactly one exists), `home.lead.providerKeysFile` (dotenv imported at boot, after the explicit option
   and `GUANXI_PROVIDER_KEYS_FILE`), `home.lead.effort`. `doctor` and `start` explain what is missing without values.

## Slices (separate commits)

1. This plan and D-211.
2. K5: API mode for `claude-code`, effort option, tests with fixture CLI and fake keys.
3. ms1-live: config, boot resolution, doctor, start, tests.
4. Runbook §7, hand-off, status.
5. Independent review round and fixes.
