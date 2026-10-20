# Lane DS1-b hand-off — components, catalog and approvals

**Status:** ready for the cross-family review · **Updated:** 2026-10-20 ·
**Branch:** `claude/lane-ds1-b-catalog-421657` (main merged at `11166df`) · **Ports:** 5183 / 4383

Everything in [DS1-b](DS1-b.md) is built. The three independent reviews ran, and their findings
are fixed in separate commits, except one inherent residual risk (key custody, below) that needs a
signing helper outside the checkout. All results below are local and mocked: no live Ollama, no
network, and no owner keychain (tests use throwaway keys generated in a temp directory).

## What was built

| Scope item | Where |
| --- | --- |
| `@guanxi/ui`: 14 primitives from shadcn/ui on Base UI (Button, IconButton, Input, Textarea, Select, Checkbox, Switch, Tabs, Tooltip, Popover, Menu, Dialog, Toast, Badge) and 4 patterns (StatusPill, ProvenanceLabel, EmptyState, ErrorState), each with a story per declared state (83 stories), docs with the required sections and a `draft` review record | `packages/ui/src/components/*` |
| Message keys: English source, curated Russian, +40% pseudo-locale | `packages/ui/src/i18n/` |
| Temporary token stub (FOUNDATIONS values, including 718240c's glass and density tables) | `packages/ui/src/styles/token-stub.css` |
| Generated, deterministic manifest (exports, props, states, CSS variables, hashes, status, usage) | `packages/ui/catalog/manifest.json`, `npm run ui:manifest` |
| Storybook 10.6.1 on the same story files (toolbar regimes, a11y addon, telemetry off) | `packages/ui/.storybook/`, `npm run ui:storybook` |
| In-app catalog at Settings → Developer → Components: Developer mode switch, code-split route, every state, docs, story source, tokens, review panel, T2 iframe sample; switches 4 themes, 2 densities, 3 glass levels, motion (system/full/reduced), transparency and locale; URL keeps component and regime | `packages/ui/catalog/`, `packages/web/src/features/catalog/` |
| Approvals (D-138): `GET /api/ui-catalog/review-capability`, `GET/POST /api/ui-catalog/components/:id/review`; Ed25519 signature inside `review.json`, key in the macOS keychain (access list trusts no app), public keys in `approval-keys.json`; source checkout only, release builds read-only (esbuild define); bound to source and snapshot hashes; signed change requests | contract `ui-catalog.ts`, server `src/ui-catalog/*` + `src/http/ui-catalog-routes.ts`, `packages/ui/catalog/approval/*` |
| Owner key script (`init`, `show`) | `packages/ui/catalog/scripts/approval-key.ts` |
| Gates G10–G16 with seeded violations; interim runner with self-test; DS1-a extension registration | `packages/ui/gates/catalog/`, `packages/ui/gates/extensions/catalog.gate.ts` |
| G13 baselines from `mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e…` (304 PNGs) | `packages/ui/catalog/snapshots/` |
| Skill scripts `find-component.mjs`, `new-component.mjs`; `packages/ui/AGENTS.md` | `.agents/skills/guanxi-ui/scripts/`, `packages/ui/AGENTS.md` |

## Exit gate

Each row names the assertion that fails when the property breaks. "New" tests were added by this
lane; the regression envelope is listed under [Commands](#commands).

| Exit-gate item | Assertion (new) | Proof it can fail |
| --- | --- | --- |
| Catalog shows every primitive with all declared states in light, dark, both HC themes, both densities and three glass levels | `component-catalog.spec.ts` › "every component shows every declared state in all 24 …": exact set of `<id>--<state>` keys per regime (sorted, so duplicates fail), resolved `--color-background-primary`, `--color-text-secondary`, `--density-control-height`, `--glass-fill`, normal and strong glass backdrop, no failed story | negative control: dark tokens scoped to `html` only → this test failed (receipt `check-g12ztkzh`) |
| Switching the theme recolours a T2 iframe plugin without code changes | same spec › "switching the theme recolours a sandboxed T2 plugin …": iframe body, card and secondary-text colours per theme over `ui/notifications/host-context-changed`, `srcdoc` unchanged, `sandbox="allow-scripts"` | negative control: host stops sending context changes → this test failed (`check-g12ztkzh`) |
| An agent-written `approved` record fails G12 | seeds `agent-written-approved` (fake key id and signature) and `agent-written-approved-unsigned`, plus `gates/catalog/seeds/G12.json` for DS1-a's G17 | the self-test requires the failure text (`untrusted_key`, `unsigned_approval`) |
| A record signed with the test key and then edited fails G12 | seed `signed-then-edited`; server test "fails G12 once any signed field of the record is edited" (comment, source hash, snapshot hashes, time, id) after a real approval through the route | each edit asserted to fail; the unedited record asserted to pass |
| A `draft` component used on a product screen fails G11 | seed `draft-on-product-screen` (+ `deprecated-laundering`), `gates/catalog/seeds/G11.json` | failure text required |
| Every seeded violation for G10–G16 fails its gate | `node packages/ui/gates/catalog/run.ts --selftest` (fast: 23 cases; browser: 11 cases) — clean copy passes, each seed fails with its named diagnostic; `gates.test.ts` and `extension.test.ts` | a seed that fails for another reason is reported as not ok |
| typecheck, `npm test`, browser gate, build, `lint:md`, `check:licenses` | see [Commands](#commands) | — |

Further claims with assertions: lazy loading behind Developer mode (request log shows no
`CatalogRoute.tsx` or `packages/ui/` module until the switch is on); motion, transparency and
locale applied to every story, motion following the OS by default; keyboard walk (skip link,
search with a live result count, navigation, tabs); approve sends the hashes shown, read-only
reasons hide actions; a built bundle older than the source refuses to sign (`catalog.test.tsx`);
release builds read-only (test bundles `release.ts` with and without the define and checks both
build scripts); writes refused from other origins, same-site pages, non-loopback Host or peer and
non-JSON bodies; concurrent decisions serialised (negative control: removing the lock fails the
race test); a record changed during the keychain prompt is not overwritten.

## Commands

Final run after the cross-family fixes, on HEAD `f39d523`, through
`agent-dev run --cwd "$PWD" --node 26 --resource heavy`, one check per call, with
`GUANXI_WEB_PORT=5183 GUANXI_API_PORT=4383 GUANXI_DATA_DIR="$PWD/.lane-data"`. The receipts
say `dirty`: the only uncommitted file was this hand-off.

| Check | Result | Receipt |
| --- | --- | --- |
| `npm run typecheck` | exit 0 (all workspaces) | direct (not heavy) |
| `npm test` | core 705 tests: 704 pass, 1 skipped (the opt-in keychain test); ui node 39/39; web 263/263; ui vitest 17/17 | `check-lypcklj_` |
| `npm run test:web:browser` | 51/51 | `check-nw17rt2d` |
| `npm run build` | exit 0 | `check-30q0ygob` |
| `npm run build-storybook --workspace @guanxi/ui` | exit 0 | `check-wpjgadax` |
| `run.ts --mode fast --selftest` | 23 cases ok | `check-gek0zfzd` |
| `run.ts --mode browser --selftest` (G13 in Docker, G14, G15 clipping, G16; clean runs + seeds) | 11 cases ok | `check-vr872fp6` |
| `run.ts --mode browser --only G13`, 10 consecutive compares | 10/10 pass | `check-_otyjwhc`, `check-izoedrxj`, `check-rau0stoi`, `check-2sgxgufu`, `check-myp62wdm`, `check-drqakl0f`, `check-2s_1zfie`, `check-4r1bflbu`, `check-dl6d6m08`, `check-0k8yydw4` |
| `npm run lint:md` | 0 errors | direct |
| `npm run check:licenses` | 343 packages, 0 not allowed | direct |

Before the cross-family fixes (`6930cb7`): `npm test` `check-0mzu4vn9`; browser gate 47/47
twice (`check-qur_zopt`, `check-dmh1ypai`), one legacy failure `check-dk4vaat8`; build
`check-pqeq5sgk`; Storybook `check-2kmw9h7e` (83 stories); self-tests `check-u8yscubq` (16),
`check-z1h52loq` (8).

**Open item:** in one of three full browser-gate runs, the legacy
`localization.spec.ts` › "locale preview, persistence and glossary stay exact across failure
and reload" saw 1 instead of 2 `/api/runtime` and `/api/models` reads (its expectation counts
the StrictMode double fetch). It passed 3/3 alone (`check-zxbw3r20`, `check-5s3ti3zl`,
`check-qr7cnsql`) and in the next three full runs (the last is `check-nw17rt2d`). The
integrator sent it to a separate investigation; this lane does not touch it. DS1-b changes no runtime or model fetching;
the pattern matches the StrictMode-aborted-request flakes fixed in S0. Not investigated further
in this lane; it should be, rather than retried.

New tests (by file): server `ui-catalog-review.test.ts` 24 (23 run, 1 opt-in); ui node
`gates/catalog/test/{approval,gates,extension}.test.ts` 39; ui vitest
`test/{components,catalog}.test.tsx` 17; web unit `developer-mode.test.ts` 2; web browser
`component-catalog.spec.ts` 7 and `flows-axe.spec.ts` 4; gate self-tests 23 fast + 11 browser
cases; G13 304 screenshots; G14 304 + 2 chrome scans + 3 app-flow scans; G15
clipping 166; G16 166. Regression envelope: the existing core, web component and 40 legacy
browser tests, unchanged.

G13 determinism: exact pixels (`threshold: 0`); 10 consecutive compare runs passed again
after the fixes (table above), and before them (`check-75q5cqfy`, `check-g0g2dp76`, `check-00j37utd`, `check-3ar3lazl`, `check-x3hqm81y`,
`check-iky8isxd`, `check-zr_pcwb8`, `check-3vz6xm2a`, `check-zoej41ax`, `check-gln7ojzo`).

## Independent verification

| Review | Findings | Fixed in |
| --- | --- | --- |
| `sde-agent:implementation-reviewer` | 2 High, 7 Medium, 10 Low | `fef724a` (hash scope, junk files, import closure), `5f37b3f` (G12 fail-closed, rotation versions, seeds name their failure, race test), `5f7e778` (release-define test, route hardening, code-unit sort), `757fd82` (refetch after 409, header status), `d356e6f` (motion/transparency/locale assertions, G16 split) |
| `frontend-agent:accessibility-reviewer` | 0 Critical, 3 Major, 10 Minor, 6 Nit | `9ecb704` (per-story focus guard, live region, OS motion default, no nested main, skip link, result count, ring clipping, HC glass border, select hover contrast, forced colours, T2 lang), `d356e6f` (G14 HC + chrome scan, narrower toast exception, G16 both sources) |
| `architecture-agent:adversarial-architect` (approval signing) | 2 Critical, 3 High, 5 Medium, 7 Low | `5f37b3f` (C2 base by full ref and fail closed, pinned key ids, H2 signed revocations, H3 deprecation laundering, M5 rotation replay, L2 strict records), `5f7e778` (M2 peer address, L3, L4, L6), `fef724a` (M4, L1), `757fd82` (M3 bundle binding); C1/H1 are the residual below |

Not fixed, by decision: overview shows five toast regions (one per toast story); G14 does not
scan the T2 iframe (sandboxed, opaque origin); dev origins on Vite's default port can still drive
the route when Guanxi itself is not on that port (adversarial M1).

### Cross-family review fixes

GPT reviewed `6930cb7` (`ds1-b-review/REVIEW-GPT.md`, verdict "merge after fixes"). Each
finding is fixed in its own commit. Each test or seed below was run against the code before the
fix and fails there (for the browser seeds, `run.ts --selftest` on the old spec reported
"expected fail, got pass": G16 `check-w_w2ix0x`, G15 `check-_udol4dw`).

| Finding | Commit | Test that fails without the fix |
| --- | --- | --- |
| H1 unsigned key-set version reset re-enables a revoked rotation | `f3918bc` | `approval.test.ts` › "rejects an unsigned version reset that would re-enable an old rotation"; G12 seed `key-version-reset` |
| H2 earlier approval overrides a later deprecation or in-record revocation | `64c73d3` | `approval.test.ts` › "treats an approval followed by a signed revocation in the same record as revoked"; G12 seeds `approval-over-base-deprecation`, `approval-revoked-in-record` |
| H3 source hash omits executable dependencies and shared styles | `1e27eab` | `approval.test.ts` › "changes when a dependency reached by …" (static, re-export, dynamic import, extensionless, `index`), "fails closed on a local import it cannot resolve"; server › "goes stale when a transitive helper or the shared styles change after approval" (`src/lib/cx.ts`, `src/styles/base.css`, `src/story-kit/index.tsx`) |
| M1 named root exports bypass G10 and G11 | `3a60a2b` | G10 seed `stray-named-export`; G11 seeds `aliased-draft`, `unknown-export` |
| M2 component-directory symlink escapes the write boundary | `7665f58` | server › "refuses a component directory that is a symlink out of the checkout", "refuses a review record that is a symlink", "refuses when the component directory is swapped for a symlink during the keychain prompt" |
| M3 G16 waits for finite motion to finish before checking | `43fc3f8` | G16 seeds `finite-entry-motion` (one finite rotation, OS source) and `interaction-motion` (switch thumb slides on Space, in-app source) |
| M4 G15 misses indirect literals and frame clipping | `6b4e171` (static), `64f5530` (browser) | G15 seed `indirect-literal` (constant, conditional, `??`, template); G15 clipping seed `frame-clip` (the regime frame clips) |
| M5 G14 never scans the Settings and new-session flows | `f39d523` | `flows-axe.spec.ts`: clean scans of `/settings` (Developer section on) and the new-session flow (empty chat, then the new dialog); seeds inject an unnamed icon button into each flow and require `button-name` |
| L1 Developer mode cannot be enabled without localStorage | `0d54afa` | `developer-mode.test.ts` › "keeps a page-local value when storage throws on read and write" |

Scope decisions in this round:

- **G14 on the new-session flow has one known legacy violation.** The Context panel's cache bar
  (`packages/web/src/features/context/ContextPanel.tsx`, `CacheBar`) dims inactive rows with
  `opacity-45`, which fails `color-contrast` (2 nodes) on the new dialog at the desktop
  viewport. It is a legacy screen outside DS1-b, and changing its classes collides with DS1-a's
  G5 and DS1-c's ratchet. `flows-axe.spec.ts` lists it by exact rule and target and asserts it is
  still present, so the entry must go when the screen is fixed. G14 is complete for Settings and
  for every other node of the new-session flow; it is not complete for that row. Owner or U1:
  fix the row (for example a muted text token instead of opacity).
- **G14 flow scans run in the web browser gate** (`npm run test:web:browser`), not in
  `run.ts`, because they need the app's routes and mocks.
- `@axe-core/playwright` 4.13.0 is now also a web dev dependency (one lock line, generated by
  `npm install --package-lock-only`).
- Key custody (C1/H1) stays a residual; it is stage DS2 (D-184).
- `localization.spec.ts` is untouched; its open item is below.

## Residual risk

- **Key custody (adversarial C1, H1).** The node decrypts the owner key in its own process, which
  runs from the agent-editable checkout. A malicious agent that edits the node (or its
  dependencies, or `NODE_OPTIONS`) can capture the key the next time the owner allows the
  keychain prompt, and any local process can request a signature; the macOS prompt names the
  `security` tool, not the component. "Always Allow" would remove the prompt for good. The
  integrator's proposal — a key with a user-presence access control (Touch ID or password per
  use, `kSecAccessControlUserPresence`) — is not feasible in this lane: access-controlled items
  live in the data-protection keychain, which needs a code-signed binary with a
  keychain-access-group entitlement, and `security` cannot create them. Follow-up: an
  owner-installed, code-signed signing helper outside the checkout, the only app on the item's
  access list, that shows the component id and short hash and returns only a signature (Secure
  Enclave keys are P-256, so the record would need an ECDSA option). Until then the guarantee is
  "an agent cannot sign without the owner allowing a prompt", not "agents cannot forge".
  **Owned by stage DS2** ([ROADMAP](../ROADMAP.md#ds2--approval-signing-helper), D-184): the
  helper is built right after DS1 merges, and until then the owner approves nothing and never
  chooses "Always Allow" on a keychain prompt.
- G12 trusts `approval-keys.json` on the base branch; with no owner key yet, the first key is a
  social anchor (the owner commits it on main). CI should set `GUANXI_UI_APPROVAL_KEY_IDS`.
- The source hash covers a component's own folder, everything under `src/styles/`, and its
  import closure in `packages/ui/src` (static, re-export and dynamic imports), except
  `i18n/messages.ts`; a label change that does not show in a screenshot (an accessible name)
  does not make an approval stale.
- G12 decides precedence from what is on the trusted base and in the record: a later revocation
  or a base deprecation beats an older approval. A decision deleted before it reached the base
  cannot be recovered; git history of the base is the only record of it.
- G16 drives stories by keyboard only (Tab, and Space on switches, checkboxes, radios, tabs and
  toggle buttons); motion behind pointer-only interactions or Enter is not exercised.
- G13 baselines are linux/arm64 renders with fallback fonts (Plex comes from DS1-a); they will be
  regenerated after DS1-a merges. 46 high-contrast baselines equal their normal-theme pair.
- The stub's HC themes do not raise status and accent text to 7:1, and the Solid border (step 8)
  is below 3:1; DS1-a's contrast gate owns the final values (proposal: FOUNDATIONS should say
  which pairs HC raises).
- `review` and `stale` warn but do not block slices (by design); nothing uses `@guanxi/ui` on a
  product screen yet.
- The real keychain prompt path (`-T ""`) was checked only by its access list on a throwaway
  keychain file; the opt-in keychain test uses `--trust-security-tool` to avoid a GUI prompt.

## Shared edits (outside owned paths)

- `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/vitest.config.ts` —
  DS1-a owns `package.json`; expect an add/add conflict. DS1-b's part: dependencies
  `@base-ui/react` 1.8.0 and `lucide-react`; dev dependencies Storybook 10.6.1, addon-a11y,
  `@axe-core/playwright` 4.13.0, Playwright, Vitest, jsdom, Testing Library, React types;
  exports `./catalog`, `./approval`, `./styles/token-stub.css`; scripts `test`, `manifest`,
  `catalog:check`, `catalog:check:browser`, `snapshots`, `harness:build`, `storybook`,
  `build-storybook`.
- Root `package.json`: `test` adds `test:ui`; scripts `test:ui`, `ui:catalog:check`,
  `ui:check:browser`, `ui:snapshots`, `ui:manifest`, `ui:storybook`. `package-lock.json` was
  regenerated by `npm install` (integrator regenerates at merge).
- `THIRD_PARTY_NOTICES.md`: 13 shadcn/ui rows (add/add with DS1-a's Plex rows).
- `packages/ui/gates/extensions/catalog.gate.ts` (the registration DS1-a's runner loads).
- Contract: `api.ts` (two routes), `schemas.ts` (four error codes), `index.ts`.
- Server: `app.ts` (mount, `uiCatalog` option), `index.ts` (service, `RELEASE_BUILD` re-export),
  `release.ts`, `scripts/build.mjs`; CLI `scripts/build.mjs` (define); `package.json` dependency.
- Web: `App.tsx`, `router.tsx`, `SettingsPage.tsx` (Developer section), `lib/api.ts` (three
  calls, error keys), `lib/locale.ts` (Developer keys), `vite.config.ts` and `vitest.config.ts`
  (aliases, Base UI pre-bundling), `package.json` dependency.
- Docs: `docs/design/COMPONENTS_AND_CATALOG.md` §8, `.agents/skills/guanxi-ui/SKILL.md` (script
  pointers).

## Integration after DS1-a merges

1. Delete `packages/ui/src/styles/token-stub.css`; import DS1-a's generated CSS where the stub is
   imported (`catalog/harness/main.tsx`, `.storybook/preview.tsx`,
   `packages/web/src/features/catalog/CatalogRoute.tsx`, web aliases). Names the components read
   that DS1-a must generate (G4 will list any gap): MCP Apps colour, font, radius, border and shadow
   names; `--color-background-{hover,pressed,accent,accent-hover,accent-pressed,danger-strong}`,
   `--color-text-{accent,on-accent}`, `--color-border-accent`, `--color-scrim`;
   `--space-{0-5,1,1-5,2,3,4,5,6,8,10,12,16}`; `--density-{control-height,row-height,panel-padding,gap}`;
   `--size-{target-min,icon-sm,icon-md,icon-lg,focus-ring,focus-offset,indicator,popover-max,dialog-max,toast-max,catalog-cell-min}`;
   `--z-{popover,dialog,toast,tooltip}`; `--motion-{duration,easing,distance}-*`,
   `--motion-loop-duration`; `--glass-{fill,strong-fill,backdrop,strong-backdrop,edge,seam,border,grain-image,grain-opacity}`.
   DS1-a renames `--font-sans`/`--font-mono` to `--font-family-*` (update the components and the
   T2 MCP Apps mapping, which must keep the MCP names). Theme, density, glass and motion must apply
   through attributes on any element, not only `:root` (the regime test fails otherwise).
2. Allow-list Base UI runtime variables for G4: `--active-tab-left`, `--active-tab-width`,
   `--anchor-width`, `--available-width`, `--available-height`, `--transform-origin`.
3. Run G5–G7 over `packages/ui/src` (no literal values today, but nothing in this lane enforces it).
4. Regenerate G13 baselines in the pinned image (`npm run ui:snapshots`) and the manifest.
5. `git show lane/ds1-a-tokens:packages/ui/gates/README.md` — the registration follows it; run
   `node packages/ui/gates/run.mjs` and `--browser` and confirm G10–G16 and G17 list them.

## Next slice

DS1-c (ESLint ratchet and codemod) after DS1-a and DS1-b merge; U1 then moves product screens onto
`@guanxi/ui`, which is when G11 starts seeing real uses. The owner signing
helper is stage DS2 (D-184), right after DS1.
