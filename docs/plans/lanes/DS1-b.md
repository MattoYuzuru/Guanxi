# Lane DS1-b — Components, catalog and approvals

**Status:** ready · **Updated:** 2026-10-20 · **Runs in:** Claude Opus session ·
**Branch:** `lane/ds1-b-catalog` (or the session's own branch) ·
**Ports:** `GUANXI_WEB_PORT=5183`, `GUANXI_API_PORT=4383`

You are implementing lane DS1-b of stage DS1 (Design foundations). Lanes K1 (kernel spike)
and DS1-a (token pipeline, fonts, gate runner, G1–G7) run at the same time.

Read first:

- `AGENTS.md`, `docs/plans/lanes/README.md` and `docs/plans/WORKFLOW.md`;
- ADR-0034 and ADR-0036;
- in `docs/design/`: README, PRINCIPLES, FOUNDATIONS, LAYOUT_AND_SCREENS and
  COMPONENTS_AND_CATALOG;
- `docs/research/2026-10-20-design/02-design-system-tooling.md`;
- `.agents/skills/guanxi-ui/SKILL.md`.

Goal: `@guanxi/ui` exists with real primitives, every component is visible in a live catalog
with all its states, and the owner can approve components with a signature agents cannot
forge.

Scope:

- **Package.** `packages/ui` as `@guanxi/ui`, following the folder convention in
  COMPONENTS_AND_CATALOG §2:
  - copy primitives in from shadcn/ui on Base UI, MIT, with `THIRD_PARTY_NOTICES.md` entries;
  - each primitive gets portable CSF 3 stories (one per declared state), `docs.md` with the
    required sections, and `review.json` set to `draft`.
- **Token dependency.** Style only through semantic token names from FOUNDATIONS.
  - Until DS1-a merges, consume the CSS custom properties by those names and keep a small
    temporary stub stylesheet, which you delete when you merge `main` after DS1-a lands.
  - Start with the primitives the current web package needs most (Button, IconButton, Input,
    Textarea, Select, Checkbox, Switch, Tabs, Tooltip, Popover, Menu, Dialog, Toast, Badge),
    then the first patterns (StatusPill, ProvenanceLabel, EmptyState, ErrorState).
- **Manifest.** A generated `packages/ui/catalog/manifest.json` (props, exports, status, usage
  count).
- **Storybook 10** as the developer and agent harness, reading the same story files.
- **In-app catalog.** Settings → Developer → Components:
  - visible only with Developer mode on, and lazy-loaded;
  - renders the same stories with a small interpreter;
  - switches light, dark, both high-contrast themes, both densities, three glass levels,
    reduced motion and reduced transparency.
- **Approvals (D-138).**
  - The node writes `review.json` with status, date, source hash, snapshot hashes and comment.
  - It signs the record with an owner approval key kept in the macOS keychain; the public key
    is committed.
  - Approvals are written only when running from a source checkout. Release builds show the
    catalog read-only.
  - Use the REST contract for the approve and request-changes calls: contract, server route,
    web client and route tests together.
  - In tests, use a throwaway key generated in a temp directory, never the owner keychain.
- **Gates** registered in DS1-a's runner under `packages/ui/gates/`. Append to the registry
  only; never edit DS1-a's gates.
  - G10 catalog complete.
  - G11 status policy (the table in COMPONENTS_AND_CATALOG §4).
  - G12 approval integrity.
  - G13 visual regression: baselines only from a pinned Playwright Docker image. If Docker is
    not available locally, implement the gate and record that the baselines are pending.
  - G14 axe accessibility.
  - G15 i18n with Russian and a +40% pseudo-locale.
  - G16 reduced motion.
  - Each gate has a seeded violation. `npm run ui:check:browser` runs the browser gates.
- **Skill scripts and package docs.** The `guanxi-ui` skill scripts `find-component` and
  `new-component` (DS1-a owns `ui-check`), and `packages/ui/AGENTS.md`.

Owned paths:

- `packages/ui/src/**`, `packages/ui/catalog/**`, `packages/ui/.storybook/**`, `packages/ui/AGENTS.md`;
- `.agents/skills/guanxi-ui/scripts/**`;
- the new catalog feature folder under `packages/web/src/features/` and its route wiring;
- the approval route in `packages/contract`, `packages/server` (a new module) and their tests;
- your gate modules in `packages/ui/gates/`.

Do not touch `packages/ui/tokens/**`, `fonts/**`, `generated/**` or DS1-a's gates.

Non-goals:

- rewriting legacy screens to use the new primitives (U1 and DS1-c);
- ESLint rules (DS1-c);
- new token values.

Exit gate (each item needs an assertion that fails when violated):

- The catalog shows every primitive with all declared states in light, dark, both
  high-contrast themes, both densities and three glass levels.
- Switching the theme recolours a sample T2 iframe plugin without code changes.
- An agent-written `approved` record fails G12, and a record signed with the test key and
  then edited fails G12.
- A `draft` component used on a product screen fails G11.
- Every seeded violation for G10–G16 fails its gate.
- `npm run typecheck`, `npm test`, `npm run test:web:browser`, `npm run build`,
  `npm run lint:md` and `npm run check:licenses` pass, the heavy ones through
  `agent-dev run --resource heavy`.

Independent verification inside the lane:

- `sde-agent:implementation-reviewer` on the diff;
- `frontend-agent:accessibility-reviewer` on the catalog;
- `architecture-agent:adversarial-architect` on the approval signing and its trust boundary.

The integrator then arranges a cross-family review with [REVIEW](REVIEW.md).

Finish with `docs/plans/lanes/DS1-b.handoff.md`.
