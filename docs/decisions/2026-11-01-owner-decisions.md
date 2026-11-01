# Owner decisions — 2026-11-01

**Status:** accepted intent; implementation status is tracked separately in PHASE_STATUS.
**Source:** owner replies in the current Mac audit/development chat. Newer applicable answers
override older defaults; an unanswered publication question is not consent.

## D-222 — Scoped desktop binary licensing exception (Q-247)

The owner approves distributing Electron/Chromium, its dynamically linked, replaceable
`libffmpeg.dylib`, and the official Node binary with their bundled license texts. Amend
ADR-0016 only for these desktop components, preserve notices and replacement rights, and
verify the notices in packaged artifacts. This does not permit arbitrary LGPL/GPL bundles.

## D-223 — Build-only WTFPL dependency (Q-248)

The owner approves exactly `truncate-utf8-bytes@1.0.2`, a transitive electron-builder build
dependency. It must not ship in the application. WTFPL is not added to the general allowlist.

## D-224 — Desktop identity and unsigned preparation

Use `io.github.mattoyuzuru.guanxi` as the permanent bundle ID. The owner has no Apple Developer account,
membership or supplied Developer ID credentials. Prepare an ad-hoc signed Apple Silicon
DMG/ZIP with honest Gatekeeper instructions; Developer ID signing/notarization is deferred.
The owner expects opening with a warning, not a requirement to enroll before any local build.
PR merge/publication authority, cadence and the first version were explicitly left difficult
to answer: they remain open, including publication of the prepared alpha.

## D-225 — Scoped editor payment grants (Q-245)

Replace the connection-wide, indefinite K5 default with grants scoped to a project and named
participant, with explicit expiry and budget. Subscription agents remain owner-bound (D-190).
Implementation must migrate existing broad grants conservatively, without silently granting
new paid access. This is accepted policy, not a claim that K5/U3 already enforces it.

## D-226 — Convenient, authenticated local clients (Q-246)

The owner approves proving local ownership by a per-install client/node binding instead of
trusting loopback alone. Use established authentication/bootstrap patterns with convenient
web/CLI/desktop onboarding, no secret in URLs, public HTML or logs, and explicit rotation and
revocation. Detailed design and verification remain engineering work; no absolute guarantee
against compromise is claimed. Until implemented, the documented loopback limitation remains.

## D-227 — Configurable dictation providers and local discovery

Start with local whisper.cpp. Detect existing local runtimes, models and supported hardware
through a plugin-owned discovery flow, record provenance and let the user choose reuse and
path presets. Do not scan arbitrary private files, load models or overwrite existing installs
as discovery side effects. Support named cloud connections and provider/path presets in plugin
settings. Existing per-connection cloud-glossary consent remains off by default (D-157).

## D-228 — Private prompt-derived glossary candidates

The owner authorizes examining available harness chat prompts across projects by script,
starting with role/length metadata and longer user prompts. Do not dump or have agents read
raw private messages as the discovery step. Derived local glossary/phrase candidates need
review; never commit raw prompts, credentials or private workspace content. Export/retention
scope must remain explicit. Prompt text supplies vocabulary and prospective scripts, not
recorded audio or corrected STT ground truth; D-157's real audio evaluation remains pending.

## D-229 — General agent browser, not a site whitelist product

Build a full agent-oriented browser supporting ordinary sites and localhost, with Guanxi's
visual system and efficient navigation/inspection tools. Reuse verified compatible open
source where useful. Pilot sites are test coverage choices, not product access ceilings.
Explore explicit sharing from installed Chrome/Firefox and site sessions, with transparent
control. This does not authorize covert profile/cookie/password/passkey extraction. Preserve
D-179's per-site grant, visible indicator and one-click stop, and D-182's cloud restriction.
Credentials, login/2FA/passkeys remain user-mediated; later secure handoff needs its own design.

## D-230 — Delegated public benchmark corpus selection

The owner delegates selection of 2–3 actively maintained public production repositories:
a large AI/mixed-stack project and a smaller framework/language/tool, optionally a store or
messenger with backend/frontend/infrastructure diversity. Use real feature/bug Issues and
linked implementations; exclude dependency bumps and administrative-only work. Pin source
revisions, licenses and task provenance; do not publish restricted task content. Public tasks
are a development corpus, not a private contamination-resistant holdout. D-153 owner labels
and actual benchmark runs remain missing evidence, rather than unanswered selection consent.

## D-231 — Initial GitHub tracker target

Use `MattoYuzuru/Guanxi` for the first linked tracker read. This authorizes Issue inspection;
it does not identify a disposable live write target or install credentials. WG2 runtime,
durable links, account/rate scope and secure configuration remain implementation work.

## D-232 — Remote rollout deferred

HTTPS node name, TLS and allowed project roots will be supplied later. Proceed with local
account implementation; do not probe or deploy to other hosts under this Mac-only task.

## D-233 — DMG for each versioned release

In a later reply, the owner explicitly chose a DMG for every versioned release. Keep
verification builds for PRs as CI artifacts. This answers cadence, superseding the unresolved
cadence portion of D-224. The first version and authority to merge/publish the current
candidate remain unanswered; preparing release automation does not execute a release.

## D-234 — Authorized first alpha and continued implementation

The owner explicitly authorizes merging PR #5 and PR #6 and publishing
`v0.1.0-alpha.1` in MattoYuzuru/Guanxi. This closes Q-249/Q-250 and supersedes the earlier
unanswered-publication/version portions of D-224/D-233. Keep independent review and fresh
full hosted checks on each actual integration candidate; a refreshed base is revalidated.
The authorized release uses the accepted ad-hoc Apple Silicon build and honest alpha /
not-notarized instructions. It does not require an Apple Developer account.

Continue autonomously with plugin platform, accounts and GitHub sync as the main priorities.
Routine in-scope branch/PR preparation, fixes, review, CI and integration remain part of
this work. This does not authorize unrelated deployments, new hosts, spending, deletion of
retained data or bypassing protection. Future feature lanes stay out of the first alpha's
pinned candidate until their own checks pass.
