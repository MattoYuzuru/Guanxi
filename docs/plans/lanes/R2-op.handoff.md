# R2-op — operational local runtime: hand-off

**Status:** implemented and independently reviewed candidate; fixture-validated only. **Date:** 2026-10-23.
Branch `codex/r2-operational-runtime`, base `069eeb24`, merged main `a64d7d1b` (P1-a). Lane clone
`/Users/yuzuru/Projects/Guanxi-lanes/r2op`, ports 5212/4412, Node 26, Mac only. No main/status edits, push,
SSH, live model, paid call, Ollama store, `~/.guanxi` or secret was used. No migration, no contract change,
no dependency, no third-party code.

## Delivered

- **Design choice (see [plan](R2-op.plan.md)):** a direct **llama-server runtime**, not an Ollama-blob
  vocab sidecar. Checked here: the installed `llama-server` (build 10964) has no `--vocab-only` option;
  Ollama renders with its Go template layer, which cannot be proven equal to the GGUF Jinja template; a
  llama.cpp-only Fedora host has no Ollama store. Stock Ollama still refuses `runtime_meter_unavailable`.
- **Exact counter port:** `runtime/llama-server/{client,sync-count,runtime,process}.ts`. `/apply-template`
  renders, `/tokenize` counts, `/props` gives the per-slot window, `/completion` evaluates exactly the counted
  string; the executor's `prompt_eval_count` comparison (`truncation_protocol`) stays the cross-check.
- **Owned checkout allocator:** `relay/checkout.ts` (`OwnedCheckoutAllocator.allocate`): marker-owned
  `r-*` directory under `<data>/relay-checkouts`, clone detached at `plan.base` with no remote, ref, later
  object, alternates or hardlink, plus `runtime/` and `runtime/scratch/`. `close()` proves removal.
- **Boot opt-in:** `StartOptions.operationalRelay` (`relay/operational.ts`); mutually exclusive with `relay`;
  spawn or attach; background load; closed after the relay plugin disposes.
- **Seams (shared edits):** `connections/service.ts` (`LocalChatTransport`, `localChat(..., {transport})`),
  `relay/runtime.ts` (`RelayRuntimePolicy.observer`, Ollama path unchanged), `relay/model.ts` (transport passes
  through), `relay/start.ts` (an allocation's `cleanup_unconfirmed` is no longer masked by `relay_stopped`),
  `relay/workspace.ts` (exports `gitEnv`/`gitFlags`), `index.ts`, relay README, ADR-0020 appendix.

## Commits

`224285be` plan · `d34d9931` implementation · `7813e668` tests · `6fd92558` docs · `f0b208e4` review fixes ·
`11d78ae7` merge of main `a64d7d1b` · hand-off commit last.

## Gates (Mac, Node 26, shared lock resource `heavy`)

New is counted from files this slice added; envelope is everything else the command ran.

| Gate | Result |
| --- | --- |
| `npm run typecheck` (all workspaces) | pass, exit 0, after the merge |
| `npm run lint:md` | pass, 231 files, 706 links |
| `npm run check:licenses` | pass, 675 packages, 0 not allowed |
| `agent-dev … npm run test` receipt `check-szgzuvn2` at `11d78ae7`, clean tree | pass; core 1995 tests, 1993 pass, 0 fail, 2 skipped (the two pre-existing Linux-only tests); kernel 107; web 359; ui 74/43; ui-gates 168; bench; codemods 102 |
| `agent-dev … npm run build` | see Build below |
| New tests | **56 new** = client 7, runtime 14, process 8, checkout 11, K3 transport 3, end-to-end relay 9, boot 4 |
| Regression envelope | core 1995 − 56 new = **1939** core, plus the other suites above; targeted relay/K3/Ollama envelope: see below |

A first full run after the merge (`check-s4eea_19`) failed 3 X1 indexing tests
(`indexing/process.test.ts` 1, `indexing/service.test.ts` 2) by 20 s fixture timeouts while the host load
average was 14 to 16 because other lanes were running. Those files pass in isolation (16 tests) and the
identical command passed on rerun (`check-szgzuvn2`). They do not import any file this slice changed. This is
recorded as load sensitivity, not as a known flake to ignore.

## Properties and their failing-when-violated probes

Each mutation was applied to the source, the named test file run, and the source restored. All were caught
unless noted. Counted-token equality (`tokens === countRequest`), truncated reply, second `prepare()` plus an
`await` inserted before the POST, alternates kept, `prune` skipped, object-set invariant removed, ref/remote
kept, quarantine ignored, marker id or parent check ignored, `cleanup_unconfirmed` masked, environment
inherited, digest cache not keyed by stat, inode check removed, alias check removed, template proof removed,
`enable_thinking` removed, loopback check removed, freshness check disabled, shard refusal removed, neutral
cwd removed, `cache_prompt` pinned, source-overlap check removed, transport not passed to K3.
Two survivors were not claims: SIGTERM replaced by SIGKILL (the stubborn-child path is still covered) and a
no-op mutation of attach mode.

## Independent verification

`sde-agent:implementation-reviewer` (read-only) reviewed `069eeb24..6fd92558`. No P0 or P1. Findings fixed in
`f0b208e4`: P2 alternates-backed source kept a path back and later objects (now self-contained, alternates
removed, stored objects must equal what `HEAD` reaches); P2 the synchronous-POST claim had no falsifying test
(now a microtask probe); P2 model identity did not cover the file the child opened (spawn records
dev/ino/size/mtime; split GGUFs refused); P3 neutral cwd, exit code kept, `cachePrompt` option, attach no-signal
spy, unmarked-directory leak. Open as residual: P3 orphaned child after a hard crash of the Guanxi process,
`freePort()` race (fails closed), whole-body read in the worker when no `content-length`.

## Residual risk (named, not closed)

1. **No request has been made to a real llama-server.** Field names (`/props` `model_alias`, `model_path`,
   `default_generation_settings.n_ctx`, `build_info`; `/completion` `tokens_evaluated`, `stop_type`,
   `truncated`) were found as strings in the installed build only. If a real binary counts `tokens_evaluated`
   differently, every cached call fails closed with `truncation_protocol`; set `cachePrompt: false` and report.
   The first real-model smoke is the next required action, before any claim about MS1.
2. The synchronous count blocks the server event loop (milliseconds; up to 12 s if the server hangs). One
   relay run at a time is the supported shape.
3. Governor vocabulary is Ollama-only: a llama-server call takes the same single permit as provider `ollama`
   with a `llama-server:` model name. Widening the governor and contract vocabulary is not done.
4. Identity covers the one GGUF file. `attach` mode cannot see shards, `--mmproj` or draft models.
5. Orphan checkouts after a crash and an orphaned child after a hard kill are not reaped.
6. No CLI flag or config file exposes the option; a host must call `start({ operationalRelay })`.
7. Linux/Fedora behaviour (binary, git path `/usr/bin/git`, sandbox, GPU offload) is not validated; ADR-0020
   stays `proposed`; MS1, B3 quality, six-hour envelope and R2 full exit remain open.

## Next slice

Real-binary smoke on the Mac with a tiny GGUF (owner-supplied) and then on Fedora; CLI/config surface for
`operationalRelay`; governor provider vocabulary; boot-time reaper for marker-owned orphans.
