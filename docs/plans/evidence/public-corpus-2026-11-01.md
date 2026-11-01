# Public benchmark corpus selection

**Status:** research-qualified candidates, not executed benchmark evidence · **Date:** 2026-11-01
**Authority:** D-230. Primary public GitHub metadata, licenses and merge parents inspected;
no repositories cloned, upstream tests run or source copied into Guanxi.

## Selection

| Repository | Coverage | Inventory revision and license |
| --- | --- | --- |
| [Langflow](https://github.com/langflow-ai/langflow) | Large AI application, Python backend, TypeScript/React, Docker/shell | `b5c54a64e685b7e50fd3bc76e965ad718fc2dea3`, [MIT](https://github.com/langflow-ai/langflow/blob/b5c54a64e685b7e50fd3bc76e965ad718fc2dea3/LICENSE); pushed Nov 1 |
| [fd](https://github.com/sharkdp/fd) | Small Rust CLI; inexpensive environment contrast | `cc4e40fa4e32d61733cd72926e233a3fb6c8d56d`, [MIT OR Apache-2.0](https://github.com/sharkdp/fd/blob/cc4e40fa4e32d61733cd72926e233a3fb6c8d56d/Cargo.toml); committed/pushed Nov 1 |
| [Zulip](https://github.com/zulip/zulip) | Messenger, Django/Python, TypeScript, shell/Puppet operations | `e0efc953036781e2bf38ef0ff538fa6f3b23507f`, [Apache-2.0](https://github.com/zulip/zulip/blob/e0efc953036781e2bf38ef0ff538fa6f3b23507f/LICENSE); committed/pushed Nov 1 |

These repository licenses fit ADR-0016; each task still needs a file-level notice check.
Public completed work is a development corpus, not an unseen private holdout. Keep private
owner corpora and D-153 quality labels as separate pending evidence.

## Initial task candidates

The base is the completed merge commit's first parent, verified from the commit graph,
not the mutable PR API base metadata. Dependency bumps and administrative tasks are excluded.

| Issue → merged PR | Behavior and upstream test scope | Pre-fix base → completed merge |
| --- | --- | --- |
| Langflow [15569](https://github.com/langflow-ai/langflow/issues/15569) → [15570](https://github.com/langflow-ai/langflow/pull/15570) | Literal punctuation in table contains/not-contains filters; Python regressions | `5bba3a5963d78dc433ad928ffe1526992dffe1fa` → `23a3d2ad878a40af729fccb3d7e4b3802d6a3d99` |
| Langflow [15937](https://github.com/langflow-ai/langflow/issues/15937) → [15993](https://github.com/langflow-ai/langflow/pull/15993) | Firefox file selection/cancellation keeps the input alive; frontend helper tests | `23a3d2ad878a40af729fccb3d7e4b3802d6a3d99` → `ee265484e43e41f5c3fca486e6840de7f55734c7` |
| fd [2192](https://github.com/sharkdp/fd/issues/2192) → [2193](https://github.com/sharkdp/fd/pull/2193) | Explicit hidden/ignore flags override their part of unrestricted mode; CLI tests | `22d11e135263621eebd1521f99d54413f8da164e` → `3c784f63b8e7976650682d550926bb79e9e1f640` |
| fd [2184](https://github.com/sharkdp/fd/issues/2184) → [2185](https://github.com/sharkdp/fd/pull/2185) | Inline case flags preserve independent smart-case behavior of additional patterns; regex/CLI tests | `9e904639aee44df4507200cf0ed5e8531e120d6f` → `e3eead9da73fb6bcc41f692304e3c8f968a3ceb1` |
| Zulip [39021](https://github.com/zulip/zulip/issues/39021) → [39147](https://github.com/zulip/zulip/pull/39147) | Plain-text clipboard preserves message newlines; unit/browser tests | `ffa19ed190c5835bee221db3f61b67a6f2387796` → `b22d1eddb76078c8d2de1415fdf0439e22a71ddb` |
| Zulip [29272](https://github.com/zulip/zulip/issues/29272) → [38601](https://github.com/zulip/zulip/pull/38601) | Notify on another user's channel unsubscription; backend/API/events/settings/UI | `dd5adc2de6c43bd7bac7d1a0e6dc18c9364268a7` → `9bc601078a698b72b32298a90ac72f2273f50031` |

Langflow's two PRs merged into `release-1.14.0` on Oct 29, while their Issues remain open;
live [PR metadata](https://api.github.com/repos/langflow-ai/langflow/pulls/15570) overrides
stale cached HTML. fd and Zulip Issues above are closed as completed. Merge dates: fd Oct 28
and Oct 23; Zulip Oct 29 and Oct 28, respectively. No task closure is inferred from a PR link.

## Qualification still required

Start with fd's two cases and Langflow's literal filter. Prepare isolated pre-fix environments,
show a baseline/no-op failing the intended oracle, then oracle success and a regression
envelope. Browser tasks require Firefox/clipboard qualification; Zulip adds database setup.
Do not run untrusted upstream tests outside the accepted execution sandbox.

Index only the pre-fix snapshot. Keep completed solutions, hidden oracle material and labels
out of agent-visible retrieval. Record provenance, contamination risk, task filtering and
reproducibility per ADR-0025 before crediting B1/B2/B3 results. Selection does not establish
quality, model superiority or permission to publish task content.
