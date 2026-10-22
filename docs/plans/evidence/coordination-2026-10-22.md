# Autonomous continuation — 2026-10-22

**Status:** in progress · **Updated:** 2026-10-22

The owner authorized finishing current in-progress work, then pursuing MS1 autonomously
until a concrete owner action is necessary. Stage scope and exit gates are unchanged.

**Latest runtime scope:** [D-195](../../decisions/2026-10-22-owner-decisions.md) restores named
Fedora work and explicitly retires the obsolete Agent Workstation application. Read
[current Fedora evidence](Fedora-2026-10-22.md), not the historical local-only checkpoint
below, before operating a host. Current-source Fedora X1/kernel passes62/62 without skips;
selectedcore fails25/213 (182pass/6Darwin-onlyskip) under diagnosis. Main's executable
integration remains `1b6f495`, all eight Mac gates
passed. Separate U1 mounted-host/G11/readiness repairs are not integrated or stage-complete.

## Integrated K4 retention and R1 bridge

`8006cd8` merges independently reviewed K4 follow-up 2 (`4afe2c3`).
[The evidence](K4-followup-2.md) holds author/reviewer counts, fixes, crash coverage and
residuals. Full gates ran at stable source `73dd577`; the subsequent correction is Markdown only.

New repair evidence is **5 new / 33 targeted regression envelope = 38**. Full regression
envelope: core **1237 total / 1236 pass / 1 opt-in skip**, kernel 106, web 318, UI gates 89,
codemod 6, catalog 70 and UI 17. Mocked browser **66/66**; UI browser, typecheck and build pass.
The initial Markdown failure was corrected; Markdown/links, licenses and source lint then pass.
Receipts are listed in the linked evidence. They report unchanged source; the inherited
external skill symlink prevents portable source certification.

Retention and R1 integration are implemented. No full K4 closure is claimed: input artifacts,
expanded UI evidence and the remaining platform envelope stay open. The later HTTPS closure
is recorded below.

## Earlier candidate snapshot (superseded by the updates below)

- DS2: repaired source under full integrator gates with K4 included. Owner-present production
  signing and installed-helper custody remain unverified. Ordinary tests never create a real key.
- X1: reviewed repaired source still needs Linux envelope and integration gates.
- U1: local layout acceptance replayed; signed F1 replication is being implemented. A stale
  catalog manifest found during acceptance is being corrected separately. Shell/migration remain.
- B1: per-request admission has separate review/fix commits `d70d56a` and `3b9a140`.
  Review reproduced expiry during a SQLite lock wait; the fix revalidates after acquiring the
  writer lock. Independent 11-case review and reproduction pass. Full package 43 tests =
  11 new / 32 fixture envelope, plus 21 mutations. No paid executor or measured quality claim.
- R3: `codex/ms1-r3` at `bf6a222` contains a separately reviewed observational ETA foundation.
  Focused evidence is 11 new / 2 integration envelope = 13; full stage gates remain open.
- F2: offers require a distinct capability and contract minor after U1's versioned layout scope.
  No offer receipt is permission to execute remotely; actual dispatch/fencing remains work.

DeepSeek's immutable B1 staging utility is isolated from the B1 author's files. One launch
failed before edits; a same-policy retry is running. No raw reasoning/tool stream is persisted.
A real installed Codex 0.162.1 handshake was observed using a temporary empty home, without
login, thread or inference requests. This is authentication-refusal evidence only, not the
recorded complete session required by K5.

## Earlier integration boundary (completed below)

Finish DS2's full gates, then merge reviewed candidates one at a time and rerun affected
integration checks. Keep the MS1 six-hour remote run, B3 slope/probe gate and real ETA
calibration explicitly unearned until measured. No paid/model run starts from fixture evidence.

## Review corrections and runtime scope

Independent review of central-doc commit `c09e2be` found one stale B1 matrix row and minor
tracker/lanetable lag. The correction names reviewed request admission and active gateway,
distinguishes U1's candidate from current main, and records K4's completed bounded merge.
No source/gate claim changes.

Root's independent staging review reproduced a content-integrity bug in `2c1b678`: an internal
symlink plus `..` caused kernel-resolved listing and lexical joined reads to use different
directories. DeepSeek fixed it separately in `0d1ff50`, refusing dot components before any
traversal; the new deterministic test fails before/removing the guard. Independent recheck
passed 12/12 at `0d1ff50` (`check-tlg8nodl`). The corrected source and separate fix are now
in the reviewed B1 candidate; the original source alone is not accepted.

R3's pure deterministic signal evaluator `5919d0b` is separately reviewed, with 10 new tests
passing independently (`check-nbaqmlfj`). It has no relay-loop integration or real collector
and makes no empirical quality claim.

The Fedora SSH route returned connection refused. The owner initially selected **local-only
continuation** on 2026-10-22. No more SSH/remote-host operations are authorized by this
continuation. Mac/Colima fixture work continues; real Fedora/Linux-host checks, live remote
MS1 and benchmark runs remain deferred. No service, VPN, relay or resident model was changed.
**Later superseded by [D-195](../../decisions/2026-10-22-owner-decisions.md):** the owner
restored Fedora and explicitly authorized retiring the old application and running needed
checks there. [The new evidence](Fedora-2026-10-22.md) owns actual changes/results; the earlier
local-only statements below describe their historical checkpoints, not current authorization.

## K4 main verification and DS2 integration

After K4 merge, full gates passed again at clean main `c09e2be`: typecheck
`check-s7dpcuv5`, full tests `check-ajoti6zd`, mocked browser `check-h8gdh3c4`, UI browser
`check-epidljb_`, build `check-syr7k_in`, Markdown/links `check-7zrq92bv`, licenses
`check-4g0yz7zc`, source lint `check-x8ldslnp`. These are the unchanged K4 source envelope
already counted above, not additional new tests. The separate central-doc correction
`133869e` is independently reviewed and incorporated; only Markdown changed after those gates.

DS2's complete candidate gates pass at clean `250517f`; source merged locally as `03c655b`.
[DS2 evidence](DS2.md) gives exact receipts and the still-unverified production signing path.
The separately reviewed [positive HTTPS case](K4-https.md) is also merged locally.
All eight post-merge gates pass on clean combined main `5e9bbfe`; see the receipt table below.
No remote-host validation is claimed.

U1 layout/replication `646bf3d` (executable `e5f8e0a`) has completed its candidate gates.
F2 reservations `5c66e27` is independently reviewed,17new/9governor envelope26pass, and must
follow U1 integration. Neither receipt grants remote execution; F2-b is next bounded work.
All work currently remains local under the owner's runtime constraint.

## Combined main verification at `5e9bbfe`

Every command below passed with a clean checkout and unchanged source. Receipts live under
`/Users/yuzuru/.local/state/agent-dev/<receipt>/result.json`. The inherited external skill
symlink still prevents portable source certification; these are observed local results.

| Command | Receipt | Scope |
| --- | --- | --- |
| `npm run typecheck` | `check-xv8h8020` | all workspaces |
| `npm test` | `check-08akwbn7` | core 1256/1256, kernel 106, web 318, UI gates 89, codemod 6, catalog 74, UI 17; zero skips |
| `npm run test:web:browser` | `check-gq1xvmz7` | 66/66 mocked Chromium cases |
| `npm run ui:check:browser` | `check-gku5mmlj` | catalog browser gates, including pinned-image visual comparison |
| `npm run build` | `check-2z1w92gr` | web/server/CLI |
| `npm run lint:md` | `check-ess3hxvp` | Markdown and links |
| `npm run check:licenses` | `check-go37mkob` | dependency license policy |
| `npm run lint` | `check-np5934rz` | JS/CSS and suppression ratchet |

This is a regression envelope, not another set of new DS2/K4 tests. Owner-present production
DS2 init/sign remains unverified. U1 candidate `a613f7a` now incorporates this verified main
and is under candidate integration gates. Its earlier reviewed source is `e5f8e0a`.

B1 handoff `25189cf` incorporates the separately reviewed private-channel protocol. Combined
checks at clean `7d5d704` pass 131/131 (`check-e6ob9k0s`): **45 new / 86 inherited envelope**
(72 bench = 40 new + 32 foundation; 59 connection = 5 new + 54 inherited). The later handoff
only corrects documentation. Socket/process binding, fresh corpus/images and real execution
remain unfinished; no live or paid run is authorized by fixture results.

R3 signal wiring `a8d5997` passed 31 scoped tests but independent review reproduced a stop/wall
liveness defect when the host collector never settles (`check-di56kgk5`). A separate author
repair is active. No integration or full R3 closure is credited before independent recheck.

U1-c CSS source `dfe5a2e` passed the new IBM typography and 12-case motion matrix in actual
Chromium. The full browser envelope failed 6/86 because six legacy cases required the obsolete
0.01 ms transition rather than the accepted removal of motion (`check-6m67kodz`). The author
is strengthening those assertions to zero motion in a separate commit; the gate remains red
until rerun. AppShellChrome is a new draft pattern under independent verification, with zero
product usage and no owner approval.

## B1 local integration boundary

Reviewed source and private stream adapter are merged locally as `7366df8`. The
[B1 evidence](B1.md) records candidate `70e4be2` and all affected passing gates, including
132 selected cases (55 new / 77 inherited) plus full npm regression. Browser source is unchanged.
Post-merge checks completed below; no whole B1 or MS1 closure is claimed.

R3 repaired candidate `cd00a82` now includes verified main and passes server types, all relay/R1
155-case envelope (31 new / 124 inherited), Markdown, licenses and lint. It remains unmerged.
F2-b handoff `ffa9d1a` has independent review closure and author 181/181 (30 new / 151 existing);
its exact attempt/grant cancellation repairs are separate commits. Integration follows U1/F2-a.

U1-c `2c4a02f` now passes 86/86 mocked Chromium and UI browser gates (`check-j2meccpr`,
`check-b77scail`). U1 candidate `a613f7a` passed types/full tests but failed Projects at its
initial-failure fixture (84/85); a separate two-schedule Retry fixture repair is active. The
new shell pattern passed bounded axe/clipping/motion but the 390px controlled host exposed a
2px sidebar border-box overflow; a separate author repair is active before snapshots/product use.

## B1 post-merge verification and local continuation

All eight integration commands pass at clean, unchanged main `6da2058`:

| Command | Receipt | Observed scope |
| --- | --- | --- |
| `npm run typecheck` | `check-tk5kiq67` | all workspaces |
| `npm test` | `check-_akh1l3o` | core 1261/1261, kernel 106, web 318, UI gates 89, codemod 6, catalog 74, UI 17, bench 82; zero skips |
| `npm run test:web:browser` | `check-ayq8gie9` | 66/66 mocked Chromium cases |
| `npm run ui:check:browser` | `check-qzcfkzfm` | catalog browser gates and pinned-image visual comparison |
| `npm run build` | `check-3vc8fdu2` | web/server/CLI |
| `npm run lint:md` | `check-0kzrxgie` | Markdown and links |
| `npm run check:licenses` | `check-q2vhna6i` | 658 packages, zero disallowed |
| `npm run lint` | `check-fojx544n` | JS/CSS and suppression ratchet |

These are regression results, not new B1 tests or a real benchmark. The inherited external
skill symlink still prevents portable source attestation; receipts were inspected as local
observations with matching clean HEAD and unchanged source.

An earlier browser run at the same main failed two catalog cases (`check-5br628v6`). Local
`pmset` records clamshell sleep at 01:25:39, 24 seconds after its start, followed by repeated
sleep/dark-wake cycles. After the machine resumed, the seven-case catalog file passed
(`check-uxp7ae3g`), then the full 66 cases passed above. No test was weakened or marked flaky.
The earlier AppShellChrome G16 timeout also overlaps sleep; its nine-story rerun now passes
(`check-gpxe0u5r`). This does not claim operation through physical sleep.

U1 candidate `a4a42da` combines the reviewed replication/layout, current main and CSS source.
Types pass (`check-udavm1x_`), but `npm test` stops at G5/G6/G7 (`check-a6cxb2j3`): stale legacy
allowances must shrink and literal animation names/step timing remain outside tokens. The
CSS author is proposing a separate canonical motion recipe correction; no new allowance or
ratchet-policy exception is authorized. Projects fixture repair `3d14692` adds an assertion
that the forced schedule actually aborts before network start; its Chromium recheck is pending.

K4 input-artifact candidate `419a997` passes 83 scoped server and 33 web cases, but independent
additional fixtures reproduce three P2 defects: concurrent accepted queue items overwrite,
orphan reaping can detach a newly live canonical reference, and stop during an aborted input
write omits the durable intervention. Separate author fixes and independent recheck are active;
this candidate is not accepted. Its prior counts are 43 new / 73 inherited, not 74 inherited.
R2 trusted public start and R3 cascade implementation continue in isolated GPT lanes. F2-b
reviewed source remains unmerged until U1/F2-a. No SSH or remote execution is used.

The DS2 production helper is installed at its documented Application Support path. Production
build/ad-hoc code-sign verification and `build.sh --check` pass (`check-jgk64o2l`). No key was
created, no owner-presence prompt was triggered and no approval signature was produced.
The production owner-present Secure Enclave gate remains unverified.

## R3 observational foundation integrated locally

Merge `fad69e5` incorporates candidate `4657f47` after synchronization with main `6da2058`.
The [ETA evidence](R3-eta.md) and [signal/cancellation evidence](R3-signals.md) retain separate
author and independent findings/fixes. Its 31 new / 124 inherited relay/R1 cases passed
before integration. Full candidate gates at clean `4657f47` also pass: all-workspace types
`check-d2cmzhkg`, `npm test` `check-womzyc79` (core 1292/1292, kernel 106, web 318, catalog 74,
UI 17, bench 82; zero skips), build `check-_4omlr3c`, Markdown `check-eq__69xg`, licenses
`check-bd2wfp97`, source lint `check-m25y002g`. Candidate web source is unchanged relative to
current main. Full post-merge main checks are next; no further executable merge precedes them.

The added collector is read-only and optional. Stop/wall cancellation does not wait for an
uncooperative observer; late results are discarded after an R1 fence recheck. This does not
release model/tool work without cleanup acknowledgement. ETA remains uncalibrated, with stated
provenance and scope. The full judge cascade, model grading, calibration/night wake and MS1
remain open in separate work.

## R3 full post-merge checks

All eight commands pass at clean, unchanged main `af0ccab`: types `check-4ey26amr`, full
`npm test` `check-dmeas875`, mocked Chromium 66/66 `check-_p9dlozt`, UI browser
`check-yeby503g`, build `check-mh87ebrr`, Markdown `check-wmw2mggj`, licenses
`check-w43ox514`, source lint `check-xn5wurrs`. The full npm scope is core 1292, kernel 106,
web 318, UI gates 89, codemod 6, catalog 74, UI 17 and bench 82; zero skips. These are the
integrated regression envelope, not additional new R3 cases or model-quality evidence.
Receipts have the same external-skill attestation limitation recorded above.

K4 input-artifact repair `afd7345` now has independent closure of the three original P2s and
one additional open-database release-error regression. At `d0aec89`, 86 server plus the original
three probes pass (`check-h2ps15uz`); at final `afd7345`, the original three plus release-error
probe pass 4/4 (`check-zmvo10oh`). The narrow last fix propagates open-database failures and
retains harmless already-closed database cleanup. Author selected counts are 47 new / 73
inherited (120 total); broader native/full/browser gates remain required before integration.

AppShellChrome plus Input invalid-story candidate `63aa885` passes full fast UI
`check-bhzv9c6g` and UI browser `check-s6xtucch`. The pinned-image generator writes 18 new
shell and four changed Input PNGs (`check-e0nqyzno`, child zero; source changed as expected for
a generator, not a clean validation pass). All 18 shell images and four Input images were
visually inspected. Separate review still requests localized nested shell story controls and
truthful loading/offline fixtures; no status promotion or owner approval is credited yet.

R3's next model adapter exposed a K3 transport ownership defect using a fake local POST:
abort was observed, but the call and governor permit settled before the injected fetch.
A separate client-only repair is active, coordinated with R2's dispatch-authorization seam.
GET/version observation liveness and actual model-POST settlement must remain distinct.
This fixture proves local client ownership, not backend inference cessation.

## K4 input source integrated; current independent findings

Reviewed input-artifact candidate `622addc` is merged locally as `53b1e76`.
[Input evidence](K4-input-artifacts.md) separates **48 new / 73 earlier selected regression**
cases, independent repair closures, full candidate results and remaining scope. Every individual
post-merge command passed at clean unchanged `53b1e76`:

| Command | Receipt | Observed scope |
| --- | --- | --- |
| typecheck | `check-_kgtij4a` | all workspaces |
| npm test | `check-hwq5f4nu` | core 1332, kernel 106, web 326, UI gates 89, codemod 6, catalog 74, UI 17, bench 82; zero skips |
| web browser | `check-wyu1wdam` | 66/66 mocked Chromium cases |
| catalog browser | `check-upccqcug` | full UI browser gates |
| build | `check-poy8_gke` | web/server/CLI |
| Markdown/links | `check-ao6i4q85` | zero errors |
| licenses | `check-dxj2h1g1` | 658 packages, zero disallowed |
| source lint | `check-at_tq1xz` | JS/CSS/suppression ratchet |

The outer coordinator script exited 127 **after** these eight child checks: the coordinator
edited its running shell script to add a cooperative pause, and the shell resumed reading at
the wrong file offset (`ep: command not found`). No product source or child check was
interrupted. This is a coordinator error, not a successful wrapper result. The individual
receipts above were inspected separately; future running coordinators stay immutable. The
corrected script passes `bash -n`. The existing external skill symlink still prevents reusable
source certification; these remain direct local observations.

The later combined U1 review found a new inherited K4 P2: a long secret registered after an
8 KiB excerpt was stored can leave its truncated prefix visible. External probe
`check-821298cf` passes the ordinary v2 metadata case and fails the long-secret case. This
does not undo the earlier findings' repair; it establishes another property that must be fixed
before the input/privacy exit. A separate GPT author owns the shared synchronous truncated
egress projection, with the finding's original reviewer reserved for independent verification.
No owner content or credential was used in these fixtures.

## Current local candidate boundary

- U1 earlier union `387453b` passes all eight commands, including **87** Chromium cases.
  Its CSS null-iterations finding is separately fixed (`7ca072e`, handoff `f83533b`) and
  independently closed. The current union `985dfed` includes main K4, unsigned shell readiness,
  reviewed search and that CSS fix: types pass (`check-lydnzcsx`), npm test stops at locale
  inventory (`check-5y575x_n`, web 351/352). The internal discriminator/brand-copy repair is
  isolated; no scanner exception or allowance growth is authorized. Product shell mounting,
  genuine ephemeral side chat and the remaining 112 CSS suppressions remain open.
- AppShellChrome, Dialog and Input move unsigned draft to review at `6b72e68` after independent
  source/images/26 focused cases and full catalog browser checks. Fast status/integrity passes
  `check-_3culzz9`. Approval stays null; no owner key, signature or stage exit is inferred.
- R2 admission `c4dbaff` has independent closure. The first K3/R2 union reproduced a nonstream
  reader-cancellation deadlock despite its stream repair. Separate source `3439a7f` / handoff
  `19664d3` passes **26 new / 99 inherited = 125** author cases. Current union `d21661b`
  incorporates that fix plus main K4 and awaits independent original-probe recheck/full gates.
- R3 cascade source `9e62da8`, handoff `f0733b2`, closes stale runtime-window and missing judge
  facts findings. Author relay scope is **29 new / 92 inherited**, plus the original window
  probe; independent **29 repository + original probe** passes. K3/R2 integration and real
  operational/quality gates remain.
- B1 process/K2 review reproduced PID-reuse cleanup, empty completion fence and changed
  stopReason idempotency P2s. Separate `65d96c1` and `ef51113` fixes at `96ebde6` pass **19 new /
  115 inherited = 134** author cases. A documented legacy late-redacted tool-key edge is not
  accepted as closure and is being repaired before the real-process independent recheck.
- X1 optional Linux system mounts are repaired in `c7773d4`, handoff `7a471d0`, after the
  exact-source Linux image exposed absent `/lib64`. New exact-source image
  `sha256:a787e0776427fb1f42019448959c3ac0a9733ef1e977fcaf8dd780eb06c01b73`
  passes **55 indexing + 7 boot**, zero skips (`check-subq06iv`): **1 new / 61 prior selected**
  for this fix. Separate source/two-case review passes `check-awj5cow3`. This is bounded local
  Colima Linux with explicit nested-bwrap permissions, not Fedora/rootless production proof.
- K5's read-only local audit specifies durable same-node account admission next; a DSH plan
  is active in `codex/k5-durable-admission`. Real vendor captures, automatic bridge producer
  activation, effective implicit bare detection and distributed admission remain open.

No push or remote execution occurred. The local HTML roadmap was refreshed and passes desktop
and phone browser QA (`check-138h8k13`); its original Claude publication is unchanged. That
snapshot predates this last merge and keeps explicit source/candidate dates. MS1's real
second-node six-hour delegation/hibernation observations remain unearned in local-only scope.

## Final privacy closure and refreshed candidate boundaries

This is a documentation-only coordination slice on main after `a9b54e0`; executable main is
still `53b1e76`. No candidate below has been merged by this update.

- K4 privacy initial source `4818b92` fixed the original long late-secret prefix. Independent
  review then reproduced append-time marker expansion erasing truncation evidence for a valid
  short descriptor. Separate `c2ae12f` protects that ambiguous boundary conservatively.
  Author final `check-02wk2z86` passes **19 new / 148 prior repository + 3 outside = 170**;
  independent `check-p106mvgt` passes **19 privacy + 20 compatibility + unchanged original
  expansion probe = 40**, no bounded blocker. No artifact reads, stored-row writes or schema
  changes; ordinary unambiguous complete text remains useful. Final author docs `13bb0e2`.
- U1 prior clean `0753630` passes all eight commands: types `check-lm2tek8f`, npm test
  `check-6uve_ot1`, browser `check-p2rivokw`, catalog browser `check-axxx_5mx`, build
  `check-hew7hgat`, Markdown `check-azrpr3f7`, licenses `check-4_kop2c3`, lint
  `check-z671wn2j`. Regression counts: core 1383, kernel 107, web 353, UI gates 102,
  codemod 6, catalog 74, UI 43, bench 82; zero failures/skips. Browser **96/96**.
  These are envelope counts; new tests stay in individual handoffs.
- Final U1 union `aa87859` integrates the separate K4 follow-up. Production merged
  automatically; only the renamed evidence document conflicted, preserving main history and
  the author's entire follow-up. Independent final source comparison finds privacy files
  byte-identical to reviewed `c2ae12f`, with web/contract/UI/manifest/approval unchanged from
  `0753630`. The unchanged original U1-page probe passes **2/2**, `check-dor07a4s`.
  Full final-union gates are running. Product mounting and whole U1 remain open.
- R2/K3 `d21661b` is independently closed: **119 selected + 2 unchanged original probes**.
  Combined R3/K3/R2 `6a3e644` is independently closed at `check-mvg3c21u`: **151/151**,
  **148 repository + original window probe + 2 new outside integration cases**. Actual judge
  request/version expiry sends zero POSTs; actual body-cancel ACK retains the K3 permit.
  No new repository tests belong to this coordinator review. Wider stage gates remain.
- X1 current-main merge `d861b58` has separate source-conflict review closure plus **116
  targeted Mac passes / 1 Linux-only skip** (`check-nptpb5tu`). Candidate full gates run on
  the frozen merge; earlier exact Linux `c7773d4` 62/62 proof keeps its narrower scope.
- B1 original repairs at `87e6d64` independently pass **138 repository + 6 original outside
  process/K2 cases**. Additional actual default-ps cleanup fails because macOS `Ss` state is
  rejected. Separate `057ffc3` / final docs `0d7302f` adds **2 new / 16 prior process tests**
  with 26 state rows; author 18/18, exact classifier probe 2/2. Final actual-process review
  remains pending. No full B1/paid-executor claim is made.
- K5 complete same-node admission plan was root-reviewed against current call sites and
  accepted in `eb5be75`. An isolated DSH implementation is active; no source completion is
  claimed. Original K3 authorization snapshot/order remains, with abort rechecks before
  spawns; the slice does not add a mid-flight grant-revocation guarantee.

The local HTML now names main `a9b54e0` / executable `53b1e76` and the latest candidate
boundaries. Initial browser observation passed but visual inspection exposed phone-wide
clipping. A three-declaration grid containment fix is independently source-reviewed; actual
1440/390-px browser QA `check-c6cwv0eg` asserts **no page overflow at 390**, 52 graph nodes,
46 stages, 11 audited rows, K4 interaction and no JS errors, with all HTTP blocked. It passes.
The outside artifact is not a Git-source certification and original Claude URL is unchanged.

All checks use synthetic fixtures/local Mac Node26 with the shared heavy lock where needed.
No remote host, live/paid model, owner workspace, owner key or push was used. The inherited
external skill symlink still prevents reusable attestation. Full K4/K5/R2/B1/U1/DS2 and MS1
exit gates remain unearned where their named residuals apply.

## Current checkpoint: reviewed migration bundle integrated locally

This section supersedes the candidate-state snapshots above. Main `1b6f495` merges reviewed
`73ebbb18` with no conflicts/manual resolutions; `git diff` confirms the complete source tree
is identical. The main checkout received its own offline `npm ci` (`check-ej75c1xl`), and
`@guanxi/contract` resolves inside it. No remote host, owner data/key, live/paid model or push
was used. All eight post-merge main gates pass at clean, unchanged `1b6f495`; the complete
coordinator exits 0. Later central changes are documentation only.

The complete feature proof remains in individual handoffs; this integration does not credit
the same test twice or close whole stages:

| Integrated part | New / regression scope and independent closure |
| --- | --- |
| U1 layout/replication/CSS/shell/search preparation | Prior reviewed union aa878593 and docs `84c9f651`; five executable gates at aa and remaining docs/license/lint after a docs-only repair. Browser96. Shell components remain unsigned review; product App mount is a subsequent slice. |
| K4 late-current-registry privacy | Separate4818b92/c2ae12f fixes; independent40 =19 privacy +20 compatibility + original expansion probe. Final original page probe2/2 in U1 union. No blob reads/stored-row rewrite. |
| K4 bounded string encoding | Final `63f8b016`; 19 new repository /51 prior envelope. Initial actual helper/native selected 67, two ownership probes, then final14 pure + three unchanged bracket probes + two independent controls =19. Decorative-bracket P2 fixed separately, not waived. Read/replay/provider/queue buffers remain. |
| K5 same-node admission and atomic learning | Final e4c7cf32; 37 new repository /66 inherited =103. Independent105 adds unchanged write-boundary race and SQL/provenance controls. Login exclusive; uncertain cleanup retains occupancy. No distributed admission claim. |
| R2/K3/R3 cascade | Final `6a3e644`; independent 151 =148 repository + original held-window probe + two actual judge request/cancel integration cases. Public R3 default remains off; absent exact meter/workspace authority refuses. |
| F2 grants/dispatch | Foundation 17 new/9 governor envelope; F2-b 30 new/151 inherited. One additional actual F2/K3 cancellation-ACK composition assertion plus 304 prior selected cases passed. Offers and dispatch grants remain distinct. |
| X1 | Exact c777 source62 local Colima Linux cases, zero skips; d861 all eight candidate commands. Reviewed join preserves native/index code and both scrubber capabilities. Nested-container permissions do not prove Fedora/rootless production behavior. |
| B1 process/K2 | Source `0d7302f` independently 149 selected; main union `fb573` adds exact source preservation and two v2 compatibility seams. Final author 153 selected includes142 repository + seven original behavioral probes + two classifier + two v2 cases; independent new seams 2/2. No measured benchmark score. |

The [integration handoff](../lanes/F2-integration.handoff.md) records the actual merge joins,
source comparisons, schema ledgers, compatibility/rollback and separate author/reviewer fixes.
Outside independent report:
`/Users/yuzuru/Projects/Guanxi-lanes/reviews/codex-active-integration-20261022.md`.

### Actual aggregate failures and separate corrections

First d640 npm gate failed17/135 bench cases because fixture paths assumed root CWD and
setup could throw before caller cleanup; seven exact owned fixture groups required cleanup.
Separate cb520038 fixes module-relative paths and immediate test-hook ownership. A direct
setup-failure regression was added separately9e90e20a; its first run failed because a nested
Node runner inherited NODE_TEST_CONTEXT. Separate e9611d35 removes only that child marker.
Independent actual failing-setup cleanup passes1/1 (`check-ktw6ahix`).

Full f2ff npm then failed1/136 bench cases: a natural-exit fixture closed request fd4 before
its final report/process.exit0, allowing correct EOF-triggered SIGTERM to race the expected
zero exit. Separate red `7ed36bae` reproduces null versus 0 deterministically with finalization work
(`check-5u5sswsy`); fixture-only ab83dc17 keeps fd4 until natural exit. Original zero/cleanup
assertions and production source remain unchanged. New case independently passes1/1
(`check-e4op9bkt`), with bench 137 and root-invoked private-process 20 passing. These repairs
add **two new repository regressions** across the continuation; overlapping runs are envelope.

At061681f6 the five executable gates pass; Markdown then fails only two plan-format errors.
Separate `73ebbb18` changes three Markdown files only. No executable retest is inferred from
that docs commit; the final three candidate commands pass at73. Independent composition and
both follow-up source/doc reviews are CLOSED, no remaining bounded finding.

| Candidate command | Actual pin | Receipt |
| --- | --- | --- |
| typecheck |061681f6 | `check-jflqp14r` |
| npm test |061681f6 | `check-__cz0d_6` |
| mocked web browser 96/96 |061681f6 | `check-nup93izu` |
| catalog browser |061681f6 | `check-lqukf4b2` |
| build |061681f6 | `check-v9n3r2kr` |
| Markdown/links |73ebbb18 | `check-fgh2lixa` |
| dependency licenses 675/0 |73ebbb18 | `check-9gmytls5` |
| source lint |73ebbb18 | `check-0m8ktjak` |

Earlier failed wrappers remain failed. Five/three commands at their actual pins are distinct
from the all-eight post-merge main sequence below. No new test credit comes from these gates.

### Post-merge main verification at `1b6f495`

| Command | Receipt |
| --- | --- |
| typecheck | `check-tk4x3ixr` |
| npm test | `check-9tke65kg` |
| mocked web browser 96/96 | `check-a48m6uv_` |
| catalog browser | `check-0inqts8y` |
| build | `check-gsag0nc8` |
| Markdown/links | `check-2nfrg6em` |
| licenses 675/0 | `check-cya6mzu5` |
| source lint | `check-adilfv2d` |

Regression scope: core 1632 total/1631 pass/one Linux-only worker-priority skip; kernel 107,
web 353, UI 43, UI gates 102, catalog 74, codemod 6, bench 137; mocked browser 96/96. The earlier
exact Linux fixture result has its separate envelope. Receipts record unchanged clean source;
the inherited external `.claude/skills/guanxi-ui` symlink prevents reusable source
certification. These are direct observations with actual pins, not portable certificates.

### Next local work and remaining exits

The root accepted a bounded U1 actual-product-mount plan at b1046a30 and completed DSH authorship in an
isolated standalone clone, `codex/u1-shell-mount`, ports 5202/4402. Source `9a1aaa26`, tests `761f01e3`,
handoff `20f0331f` add 17 cases (eight component, nine browser). The author reports 64 scoped component
passes (eight new / 56 inherited), three existing preference cases and scoped types/lint; actual
browser remains unrun by the author. Root joined main at `4734c2f8` and refreshed usage at `6c8aa1f2`;
independent Sol review is active there. It reuses prepared public
shell/controller/search and must prove real-route state/focus/navigation/slot uniqueness.
Author/check status must be inspected live before any takeover. Independent Sol 6.1/high
review, mounted browser evidence and integration follow. Review/stale component use is an
ordinary-slice warning under COMPONENTS_AND_CATALOG section4; signed owner approval still
blocks stage/release exit. No signature/key/approval was created.

A fresh read-only residual matrix and concrete K4 queue-v3 engineering proposal live outside
Git under `/Users/yuzuru/Projects/Guanxi-lanes/reviews/`. Queue-v3 and the B3 offline evidence
format require root engineering acceptance before authoring. No ledger 40 reservation, public
schema change, B3 implementation or benchmark gate was silently accepted by these plans.

K4 queue/whole-buffer/platform scope; K5 real vendor/effective-bare/Claude producer scope;
U1 new-session/finished-unseen/ephemeral chat/112 CSS suppressions/owner signatures; R2 exact
runtime meter/checkout authority; R3 quality/ETA/night calibration; F2 toolful transport/cost/
physical-host lifecycle; B1 real corpus/execution/billing/five seeds and actual B3 remain open.
MS1 still needs real >=6h other-node 30B delegation, zero lead-token change, exactly one wake
and verified final item/B3 exits. Local fixtures cannot discharge these observations.

### U1 mount review: concrete follow-up findings

At clean `6c8aa1f2` independent focused components pass 35/35 (`check-jf4e603s`: eight new / 27
inherited) and nine new actual-App browser cases pass (`check-pr_0jn4g`). The adapted legacy
browser subset passes 11/18, seven failures (`check-r2kqf9i4`); all checks are terminal. Three
P2s require separate repair before feature integration:

- AppShellChrome and Dialog reach draft IconButton/Menu/Tooltip. G11 only counts direct
  public imports, so the original outside transitive probe semantically fails (`check-xa_6x0h9`).
  A review wrapper is no exemption from the product draft rule. Isolated DSH gate repair is
  active under root plan `308ede3e` in codex/u1-status-closure, own CI check-kvc2fdn8; no status
  promotion or policy weakening is authorized there.
- Added mocks use the wrong session-page endpoint. Six failures and the new-browser success
  state need the actual `/api/sessions/list/page` contract plus explicit empty/no-error assertions.
- Unchanged CacheBar opacity debt still produces exactly two documented contrast nodes. Axe's
  selector serialization changed with the host, exposing the old exact selector exception.
  Root chooses a minimal semantic-text contrast repair and removal of the exception, with
  zero-serious scans and seeded detector assertions preserved, rather than a broader ignore.

A separate readiness audit names missing Menu/Tooltip interaction and regime assertions; no
bulk draft-to-review transition is justified yet. Real Menu/IconButton/Tooltip readiness
will be tested and reviewed before any unsigned transition. Owner approval stays separate.
No new U1 source is integrated or stage exit claimed by this checkpoint.

### Fedora repair integrated; U1 and Q0 current continuation

Newest authority is D-195. The old Fedora application is retired with SSH/VPN/private data
preserved, and dedicated-user actual Linux checks are available. [Fedora evidence](Fedora-2026-10-22.md)
retains setup/red/JUnit limits and initial X1/kernel62/62. The25/213 native/core failures were
caused by110-byte proxy socket paths under long TMPDIR. Focused source a7df34d4 uses trusted
short `/tmp` for Linux; no sandbox permission/timeout/dependency changes.

The [focused handoff](../lanes/K4-linux-proxy-path.handoff.md) records actual one-case red,
green, selected214 (1new/213inherited:208pass/6Darwin-onlyskip) at3e75852c, and strengthened
samecase1/1 at28653d92 with unchanged production. Separate corrected lifecycle/policy control
passes; original failed controls remain failures with their confirmed hidden-tmpfs premise
error. Independent source/final-test/receipt review is closed, no remaining focused finding.

Mac full npm check-jqapa65j passes at3e75852c; final45491863 types/build/Markdown/license/lint
pass (fo_1sgj2,2f9913p3,d6e5mxce,_y5egedl,ccs7zg8j). Root fast-forwarded that exact tree into
local main; no manual resolution and no push. Last all-eight main sequence remains1b6, not
an invented repeat at454. External-skill symlink still prevents portable source certification.

U1 three repair lanes are closed and assembled. Workspace-state candidate1776389c is now
independently closed at a single unchanged pin:97 repository cases =55new/42inherited,
web7 hlul0l22, UI25 poudrs0d, browser65 i9s7d5e5; outside held-Save-as1 q9epx5m8. The reviewer
inspected current loading/error/forced-color images and all eight regime sheets. Its own
initial JSX-import harness error occurred before product execution and is preserved. Root
still owns exact12 pinned-Docker baselines, unsigned lifecycle transitions and full union/main
gates. No owner key/signature/approved status or whole U1 closure.

K4 queue-v3 Q0 author repairs plus separate root fixture fixes pass64 repository + unchanged
outside5 at71dc6bb0. The new held-writer observer now awaits owned worker exits; exact16KiB
FTS token has a delimiter and identical-token indexed positive. Subsequent14db1971 is docs-only
and Markdownyee4gsv5 passes. Missing native/helper/CLI envelope79/79 passes (1new/78inherited),
but inspector components23/24 fail one Russian accessible-name oracle. Root must repair that
test and truthful v1/v3 preview/unit copy, then run inspector/browser and union gates. No Q0
acceptance, Q1 consumption, Q2 producer or full queue claim yet. Earlier review failures and
their distinct fixes remain in history. B3 offline-format independent planning review is active.

MS1's real six-hour30B delegation, zero lead-token change, exactly one wake, accepted B3
quality/calibration and every remaining item exit stay open; none is inferred from these gates.
